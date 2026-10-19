// Express app: routes, static page, startup checks.
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { AuditLog } from "./audit.js";
import { createBoxClient, RealBoxGateway } from "./box.js";
import { assertAuditOutsideScan, type Config, loadConfig } from "./config.js";
import { applyFinding } from "./engine/apply.js";
import { commitWrites, CycleBusyError, CycleRunner, type Engine } from "./engine/cycle.js";
import { loadPrompt } from "./engine/extract.js";
import { loadPeople } from "./engine/normalize.js";
import { PasscodeLimiter } from "./passcode-limit.js";
import { score, type AnswerKey } from "./score.js";
import { State } from "./state.js";
import { BoxTasksTracker } from "./trackers/box-tasks.js";
import { fullScan, startSweeper } from "./triggers/sweep.js";
import { createWebhookHandler } from "./triggers/webhook.js";

const SESSION_COOKIE = "hc_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const ANSWER_KEY = "seed/answer_key.json";

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(engine: Engine, runner: CycleRunner, opts: { secureCookies: boolean; webDir?: string; serviceUserId: string }) {
  const { config, state } = engine;
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });

  // The webhook needs the raw body for its signature check, so it is registered before JSON parsing.
  app.post("/webhooks/box", express.raw({ type: "*/*", limit: "1mb" }), createWebhookHandler({
    keys: { primary: config.webhookPrimaryKey, secondary: config.webhookSecondaryKey },
    runner,
    serviceUserId: opts.serviceUserId,
  }));

  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser(config.sessionSecret));

  const limiter = new PasscodeLimiter();
  app.post("/api/session", (req, res) => {
    const client = req.ip ?? "unknown";
    const wait = limiter.retryAfter(client);
    if (wait) { res.set("Retry-After", String(wait)).status(429).json({ error: "too many wrong passcodes; try again later" }); return; }
    const passcode = typeof req.body?.passcode === "string" ? req.body.passcode : "";
    if (!sameText(passcode, config.demoPasscode)) {
      limiter.fail(client);
      res.status(401).json({ error: "wrong passcode" });
      return;
    }
    limiter.succeed(client);
    res.cookie(SESSION_COOKIE, String(Date.now() + SESSION_MS), {
      signed: true, httpOnly: true, sameSite: "lax", secure: opts.secureCookies, maxAge: SESSION_MS,
    });
    res.json({ ok: true });
  });

  const session = (req: Request, res: Response, next: NextFunction) => {
    const expires = Number(req.signedCookies?.[SESSION_COOKIE]);
    if (!expires || expires < Date.now()) { res.status(401).json({ error: "sign in with the passcode" }); return; }
    next();
  };

  app.get("/api/state", session, (_req, res) => { res.json(state.toAppState()); });

  app.post("/api/scan", session, (_req, res) => {
    try {
      fullScan(runner).catch(() => undefined);
      res.status(202).json({ started: true });
    } catch (err) {
      if (err instanceof CycleBusyError) { res.status(409).json({ error: err.message }); return; }
      throw err;
    }
  });

  app.post("/api/findings/:id/actions", session, async (req, res) => {
    const finding = state.findings.find((f) => f.id === req.params.id);
    if (!finding) { res.status(404).json({ error: "no such finding" }); return; }
    const action = req.body?.action;
    try {
      if (action === "dismiss") {
        await runner.exclusive(async () => {
          state.dismissed.add(finding.fingerprint);
          state.findings = state.findings.filter((f) => f.id !== finding.id);
        });
        res.json({ status: "dismissed" });
        return;
      }
      const kind = action === "create_task" ? "task" : action === "comment" ? "comment" : undefined;
      if (!kind) { res.status(400).json({ error: "action must be create_task, comment or dismiss" }); return; }
      if (finding.proposal?.kind !== kind) { res.status(400).json({ error: `this finding has no ${kind} to write` }); return; }
      const result = await runner.exclusive(() => applyFinding({
        tracker: engine.tracker, audit: engine.audit, state, people: engine.people, now: engine.now,
      }, finding, "click"));
      if (result.status === "applied") state.findings = state.findings.filter((f) => f.id !== finding.id);
      res.status(result.status === "failed" ? 502 : 200).json(result);
    } catch (err) {
      if (err instanceof CycleBusyError) { res.status(409).json({ error: err.message }); return; }
      throw err;
    }
  });

  // Hides a failed file and stops trying its current version. Only a logged dismissal takes effect,
  // so a failed audit write leaves the error on the page to try again.
  app.post("/api/files/:id/dismiss-error", session, async (req, res) => {
    const fileId = String(req.params.id);
    const failure = state.toAppState().errors?.find((e) => e.fileId === fileId);
    const version = state.versions.get(fileId);
    if (!failure || !version) { res.status(404).json({ error: "no failed file with that ID" }); return; }
    try {
      const auditError = await runner.exclusive(async () => {
        state.dismissedFiles.set(fileId, version);
        try {
          await engine.audit.appendFileDismissal({
            time: engine.now().toISOString(), fileId, fileName: state.names.get(fileId) ?? fileId,
            fileVersion: version, error: failure.message,
          });
          return undefined;
        } catch (err) {
          state.dismissedFiles.delete(fileId);
          return err instanceof Error ? err.message : String(err);
        }
      });
      if (auditError !== undefined) {
        console.error(`file dismissal not logged (${fileId}):`, auditError);
        res.status(502).json({ error: `not dismissed: the audit log could not be written (${auditError})` });
        return;
      }
      res.json({ status: "dismissed" });
    } catch (err) {
      if (err instanceof CycleBusyError) { res.status(409).json({ error: err.message }); return; }
      throw err;
    }
  });

  app.post("/api/mode", session, async (req, res) => {
    const mode = req.body?.mode;
    if (mode !== "dry-run" && mode !== "apply") { res.status(400).json({ error: "mode must be dry-run or apply" }); return; }
    try {
      // Switching to apply writes the findings already on the page. It does not wait for the next sweep.
      const summary = await runner.exclusive(async () => {
        state.mode = mode;
        return mode === "apply" ? commitWrites(engine, "click") : { applied: 0, held: 0 };
      });
      res.json({ mode, ...summary });
    } catch (err) {
      if (err instanceof CycleBusyError) { res.status(409).json({ error: err.message }); return; }
      throw err;
    }
  });

  app.get("/api/audit", session, async (req, res) => {
    const date = String(req.query.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "date must be YYYY-MM-DD" }); return; }
    res.type("text/plain").send(await engine.audit.read(date));
  });

  app.post("/api/score", session, (_req, res) => {
    if (!existsSync(ANSWER_KEY)) { res.status(404).json({ error: "no answer key in this build" }); return; }
    res.json(score(state.toAppState(), JSON.parse(readFileSync(ANSWER_KEY, "utf8")) as AnswerKey));
  });

  app.use(express.static(opts.webDir ?? join(process.cwd(), "dist", "web")));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });
  return app;
}

export async function buildEngine(config: Config): Promise<Engine> {
  if (config.fakeBox) {
    const { fakeEngine } = await import("./fake-box.js");
    const latencyMs = Number(process.env.FAKE_BOX_LATENCY_MS ?? 300);
    const { engine } = await fakeEngine({ mode: config.mode, latencyMs });
    return { ...engine, config: { ...engine.config, ...config } };
  }
  const client = createBoxClient(config);
  const gateway = new RealBoxGateway(client, config.auditFolderId);
  assertAuditOutsideScan(config.scanFolderId, config.auditFolderId, await gateway.folderAncestors(config.auditFolderId));
  return {
    config, gateway, tracker: new BoxTasksTracker(client), people: loadPeople(),
    state: new State(config.mode), audit: new AuditLog(gateway), promptTemplate: loadPrompt(), now: () => new Date(),
  };
}

async function main() {
  const config = loadConfig();
  const engine = await buildEngine(config);
  const serviceUserId = await engine.gateway.serviceUserId();
  const runner = new CycleRunner(engine);
  const app = createApp(engine, runner, { secureCookies: !config.fakeBox, serviceUserId });
  app.listen(config.port, () => {
    console.log(`herding-cats listening on :${config.port} (${config.fakeBox ? "FAKE_BOX" : "Box"}, ${config.mode}, sweeps ${config.sweepsEnabled ? "on" : "off"})`);
    // With sweeps off, only webhooks and Scan now start a cycle; the page is empty until one runs.
    if (config.sweepsEnabled) startSweeper(runner, config.sweepIntervalMinutes);
    engine.state.watching = true;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
