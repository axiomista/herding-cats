import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { CycleRunner, runCycle } from "../../src/engine/cycle.js";
import { fakeEngine } from "../../src/fake-box.js";
import { createApp } from "../../src/server.js";
import type { AppState } from "../../src/types.js";

// Starts the app on a free port after a dry-run full scan, signed in with the fake passcode.
async function signedIn() {
  const { engine, box } = await fakeEngine({ mode: "dry-run" });
  await runCycle(engine, "all", { trigger: "full_scan", full: true });
  const app = createApp(engine, new CycleRunner(engine), { secureCookies: false, serviceUserId: "svc", webDir: "web" });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: engine.config.demoPasscode }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const call = (path: string, body?: unknown) => fetch(`${base}${path}`, body === undefined ? { headers: { cookie } }
    : { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { engine, box, call, close: () => server.close() };
}

test("an edited comment is posted with the real fingerprint; text on a task finding is refused", async (t) => {
  const { engine, box, call, close } = await signedIn();
  t.after(close);
  const orphan = engine.state.findings.find((f) => f.bucket === "orphan")!;
  const res = await call(`/api/findings/${orphan.id}/actions`, { action: "comment", text: "Who asked for this?\nfingerprint: wrong" });
  assert.equal(res.status, 200);
  const posted = box.writes.filter((w) => w.op === "comment").at(-1) as unknown as { text: string };
  assert.equal(posted.text, `Who asked for this?\n\nfingerprint: ${orphan.fingerprint}`);

  const task = engine.state.findings.find((f) => f.proposal?.kind === "task")!;
  assert.equal((await call(`/api/findings/${task.id}/actions`, { action: "create_task", text: "x" })).status, 400);
  const other = engine.state.findings.find((f) => f.proposal?.kind === "comment")!;
  assert.equal((await call(`/api/findings/${other.id}/actions`, { action: "comment", text: "   " })).status, 400);
});

test("switching to apply without applying existing findings writes none of them", async (t) => {
  const { engine, box, call, close } = await signedIn();
  t.after(close);
  const res = await call("/api/mode", { mode: "apply", applyExisting: false });
  const out = await res.json() as { mode: string; applied: number; held: number };
  assert.equal(out.mode, "apply");
  assert.equal(out.applied, 0);
  assert.equal(box.writes.filter((w) => w.op === "createTask" || w.op === "comment").length, 0);
  const state = await (await call("/api/state")).json() as AppState;
  assert.equal(state.mode, "apply");
  assert.ok(state.waiting!.length > 0);
  assert.equal(state.sweepIntervalMinutes, engine.config.sweepIntervalMinutes);
});

test("the audit log is served as entries", async (t) => {
  const { engine, call, close } = await signedIn();
  t.after(close);
  const finding = engine.state.findings.find((f) => f.proposal?.kind === "task")!;
  await call(`/api/findings/${finding.id}/actions`, { action: "create_task" });
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const body = await (await call(`/api/audit?date=${day}&format=json`)).json() as
    { date: string; entries: { status: string; trigger: string; fields: Record<string, string> }[] };
  assert.equal(body.date, day);
  const e = body.entries.at(-1)!;
  assert.equal(e.status, "applied");
  assert.equal(e.trigger, "click");
  assert.equal(e.fields.fingerprint, finding.fingerprint);
  assert.equal((await call(`/api/audit?date=${day}`)).headers.get("content-type")?.split(";")[0], "text/plain");
});
