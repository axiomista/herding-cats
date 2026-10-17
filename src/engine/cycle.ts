// runCycle(fileIds): the steps in How it works. Every trigger runs through here; the triggers only
// decide which files to pass.
import type { AuditLog } from "../audit.js";
import type { BoxGateway } from "../box.js";
import type { Config } from "../config.js";
import type { FileResult, State } from "../state.js";
import type { BoxFile, Commitment, Finding, TrackerAdapter, TrackerTask, Trigger } from "../types.js";
import { applyFinding, buildProposal, holdFinding, type WriteContext } from "./apply.js";
import { withCertainty } from "./certainty.js";
import { buildPrompt, extractItems, PROMPT_VERSION } from "./extract.js";
import { applyStatusChanges, matchFolder, type StatusChange } from "./match.js";
import { dedupe, type People, peopleNames, resolveDate, resolveOwner } from "./normalize.js";
import { verifyItems } from "./verify.js";

export interface Engine {
  config: Config;
  gateway: BoxGateway;
  tracker: TrackerAdapter;
  people: People;
  state: State;
  audit: AuditLog;
  promptTemplate: string;
  now: () => Date;
}

export interface CycleSummary {
  trigger: Trigger;
  filesChecked: number;
  filesScanned: number;
  aiCalls: number;
  applied: number;
  held: number;
}

const SUPPORTED = /\.(txt|md|pdf|docx?|rtf|odt|html?|pptx?|xlsx?)$/i;

export const scanMarker = (version: string) => `${version}@${PROMPT_VERSION}`;

// Inventory rules: subfolders are never listed as files; skip unsupported types and files over
// the size limit. The audit folder is a separate folder and is never listed here.
export function inventory(files: BoxFile[], maxBytes: number): BoxFile[] {
  return files.filter((f) => SUPPORTED.test(f.name) && f.size <= maxBytes);
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function scanFile(engine: Engine, file: BoxFile, full: boolean): Promise<{ scanned: boolean; aiCalls: number }> {
  const { gateway, state, people } = engine;
  const marker = scanMarker(file.version);
  // 1. Skip check. Full scans ignore it.
  if (!full) {
    let known = state.markers.get(file.id);
    if (!known) {
      known = (await gateway.getMeta(file.id)).hcScannedVersion;
      if (known) state.metaMarkers.set(file.id, known);
    }
    if (known === marker) { state.markers.set(file.id, marker); return { scanned: false, aiCalls: 0 }; }
  }
  // 2. Classify.
  const doc = await gateway.classify(file.id);
  // 3. Extract.
  const prompt = buildPrompt(engine.promptTemplate, engine.config.orgName, peopleNames(people));
  const extracted = await extractItems(gateway, file.id, prompt);
  const aiCalls = 1 + extracted.calls;
  // 4. Verify evidence.
  const text = await gateway.fileText(file.id);
  const items = extracted.items.map((i) => ({ ...i, fileId: file.id }));
  const { verified, unverified } = verifyItems(items, text);
  // 5. Normalize owners and dates.
  const commitments: Commitment[] = [];
  const statusChanges: StatusChange[] = [];
  const setAside: FileResult["setAside"] = [];
  verified.forEach((item, i) => {
    if (item.kind === "status_change") { statusChanges.push(item); return; }
    if (item.kind !== "commitment") { setAside.push(item); return; }
    const owner = resolveOwner(item.owner, people, { docType: doc.docType, text, evidence: item.evidence });
    const date = resolveDate(item.due, doc.docDate);
    commitments.push({
      id: `${file.id}:${i}`, fileId: file.id, fileVersion: file.version, text: item.action,
      evidence: item.evidence, owner: owner.owner, ownerUserId: owner.userId, due: date.due,
      dueAbsolute: date.absolute, status: "open", flags: [...owner.flags, ...date.flags],
    });
  });
  // 6. Deduplicate within the file.
  state.files.set(file.id, {
    id: file.id, name: file.name, version: file.version, docType: doc.docType, docDate: doc.docDate,
    model: extracted.model, commitments: dedupe(commitments, engine.config.match.dedupeThreshold),
    statusChanges, setAside, unverified,
  });
  state.markers.set(file.id, marker);
  return { scanned: true, aiCalls };
}

// 7. Match every known commitment and status change against every task in the folder.
// Restatements in other files merge into the earliest commitment (same rule as step 6).
export function matchAll(engine: Engine, tasks: TrackerTask[]): { findings: Finding[]; setAside: Commitment[] } {
  const { state, config, people } = engine;
  const results = [...state.files.values()]
    .sort((a, b) => (a.docDate ?? "9999").localeCompare(b.docDate ?? "9999") || a.name.localeCompare(b.name));
  const commitments = dedupe(structuredClone(results.flatMap((r) => r.commitments)), config.match.dedupeThreshold);
  const withStatus = applyStatusChanges(commitments, results.flatMap((r) => r.statusChanges), config.match);
  const matched = matchFolder(withStatus, tasks, new Set(state.files.keys()), config.match);
  const findings = matched.findings
    .map((f) => withCertainty(f, config.match))
    .map((f) => ({ ...f, proposal: buildProposal(f, state, people) }))
    .filter((f) => !state.dismissed.has(f.fingerprint));
  return { findings, setAside: matched.setAside };
}

export async function runCycle(engine: Engine, fileIds: string[] | "all",
  opts: { trigger: Trigger; full?: boolean }): Promise<CycleSummary> {
  const { gateway, tracker, state, config } = engine;
  const listed = await gateway.listFiles(config.scanFolderId);
  for (const f of listed) state.names.set(f.id, f.name);
  const files = inventory(listed, config.maxFileBytes);
  // A file no longer in the folder drops out of memory.
  const present = new Set(files.map((f) => f.id));
  for (const id of state.files.keys()) if (!present.has(id)) state.files.delete(id);

  const wanted = fileIds === "all" ? files : files.filter((f) => fileIds.includes(f.id));
  state.running = { done: 0, total: wanted.length };
  let aiCalls = 0;
  let scanned = 0;
  const errors: State["errors"] = [];
  await pool(wanted, config.parallelFiles, async (file) => {
    try {
      const r = await scanFile(engine, file, !!opts.full);
      aiCalls += r.aiCalls;
      if (r.scanned) scanned++;
    } catch (err) {
      state.markers.delete(file.id);
      errors.push({ fileId: file.id, message: err instanceof Error ? err.message : String(err) });
    } finally {
      state.running!.done++;
    }
  });
  state.countAiCalls(aiCalls, engine.now());
  state.errors = errors;

  const tasks = (await Promise.all(files.map((f) => tracker.listTasks(f.id)))).flat();
  const { findings, setAside } = matchAll(engine, tasks);
  state.findings = findings;
  state.setAsideCommitments = setAside;

  // 9. Write (apply mode only): high-certainty changes, the audit entries, then metadata last.
  let applied = 0;
  let held = 0;
  if (state.mode === "apply") {
    const ctx: WriteContext = { tracker, audit: engine.audit, state, people: engine.people, now: engine.now };
    for (const f of findings) {
      if (!f.proposal) continue;
      if (f.certainty === "high") {
        if ((await applyFinding(ctx, f, opts.trigger)).status !== "skipped") applied++;
      } else if (await holdFinding(ctx, f, opts.trigger)) held++;
    }
    const at = engine.now().toISOString();
    for (const r of state.files.values()) {
      const marker = scanMarker(r.version);
      if (state.metaMarkers.get(r.id) === marker) continue;
      const open = findings.filter((f) => (f.commitment?.fileId ?? f.task?.fileId) === r.id && f.bucket !== "matched");
      await gateway.setMeta(r.id, {
        hcDocType: r.docType, hcDocDate: r.docDate ?? "", hcLastChecked: at,
        hcOpenFindings: String(open.length), hcLastChange: opts.trigger,
        hcScannedVersion: marker,
      });
      state.metaMarkers.set(r.id, marker);
    }
  }
  state.finishCycle(engine.now(), opts.trigger, wanted.length);
  return { trigger: opts.trigger, filesChecked: wanted.length, filesScanned: scanned, aiCalls, applied, held };
}

export class CycleBusyError extends Error {
  constructor() { super("A cycle is already running"); }
}

// One cycle at a time. Scan now gets a 409 while one runs; webhook and sweep work is queued and
// runs as soon as the current cycle ends.
export class CycleRunner {
  private current?: Promise<CycleSummary>;
  private pending = new Set<string>();
  private pendingAll = false;
  private pendingTrigger: Trigger = "webhook";
  onError: (err: unknown) => void = (err) => console.error("cycle failed:", err);

  constructor(private engine: Engine) {}

  get running(): boolean { return !!this.current; }

  run(fileIds: string[] | "all", opts: { trigger: Trigger; full?: boolean }): Promise<CycleSummary> {
    if (this.current) throw new CycleBusyError();
    const p = runCycle(this.engine, fileIds, opts);
    this.current = p;
    const done = () => { this.current = undefined; this.drain(); };
    p.then(done, (err) => { this.engine.state.running = undefined; done(); this.onError(err); });
    return p;
  }

  enqueue(fileIds: string[] | "all", trigger: Trigger): void {
    if (fileIds === "all") this.pendingAll = true;
    else fileIds.forEach((id) => this.pending.add(id));
    this.pendingTrigger = trigger;
    if (!this.current) this.drain();
  }

  // Resolves once no cycle is running and nothing is queued.
  async idle(): Promise<void> {
    while (this.current) await this.current.catch(() => undefined);
  }

  private drain(): void {
    if (!this.pendingAll && !this.pending.size) return;
    const ids = this.pendingAll ? "all" as const : [...this.pending];
    this.pending.clear();
    this.pendingAll = false;
    this.run(ids, { trigger: this.pendingTrigger }).catch(() => undefined);
  }
}
