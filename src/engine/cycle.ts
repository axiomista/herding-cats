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
import { applyStatusChanges, isClosing, matchFolder, type StatusChange } from "./match.js";
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

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
// Prefixes the errors commitWrites records, so the next call can replace them.
const META_WRITE = "metadata write: ";

const SUPPORTED = /\.(txt|md|pdf|docx?|rtf|odt|html?|pptx?|xlsx?)$/i;

export const scanMarker = (version: string) => `${version}@${PROMPT_VERSION}`;

// Saved on the file as hcExtract so a later cycle can restore commitments without another AI call.
// Without it, a webhook after a restart would match one file's promises against every task and
// mis-file the ones that live in a document it did not re-read.
export function snapshotOf(file: FileResult): string {
  return JSON.stringify({
    docType: file.docType, docDate: file.docDate, model: file.model,
    commitments: file.commitments, statusChanges: file.statusChanges,
    setAside: file.setAside, unverified: file.unverified,
  });
}

function restoreFile(state: State, file: BoxFile, raw: string | undefined): boolean {
  if (!raw) return false;
  let snap: Partial<FileResult>;
  try { snap = JSON.parse(raw) as Partial<FileResult>; } catch { return false; }
  if (typeof snap.docType !== "string" || !Array.isArray(snap.commitments)) return false;
  state.files.set(file.id, {
    id: file.id, name: file.name, version: file.version, docType: snap.docType, docDate: snap.docDate,
    model: snap.model ?? "", commitments: snap.commitments, statusChanges: snap.statusChanges ?? [],
    setAside: snap.setAside ?? [], unverified: snap.unverified ?? [],
  });
  return true;
}

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
  // 1. Skip check. Full scans ignore it. A matching marker restores the saved extraction when this
  // process has not seen the file yet, so a restart does not forget the other documents.
  if (!full) {
    let known = state.markers.get(file.id);
    let extract: string | undefined;
    if (!known) {
      const meta = await gateway.getMeta(file.id);
      known = meta.hcScannedVersion;
      extract = meta.hcExtract;
      if (known) state.metaMarkers.set(file.id, known);
      if (meta.hcOpenFindings) state.metaCounts.set(file.id, meta.hcOpenFindings);
    }
    if (known === marker) {
      state.markers.set(file.id, marker);
      if (state.files.has(file.id) || restoreFile(state, file, extract)) return { scanned: false, aiCalls: 0 };
      // The marker is set but the snapshot is missing or unreadable. Re-extract, and write metadata
      // again so the next restart can restore it.
      state.metaMarkers.delete(file.id);
    }
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
    // The model sometimes labels a cancellation a decision but still gives its new status.
    if (item.kind === "status_change" || isClosing(item)) { statusChanges.push(item); return; }
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
  // A fresh extraction (a full scan of the same version too) replaces the snapshot on Box.
  state.metaMarkers.delete(file.id);
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
    .map((f) => withCertainty(f, config.match, state.createdTasks))
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
      errors.push({ fileId: file.id, message: errorMessage(err) });
    } finally {
      state.running!.done++;
    }
  });
  const hydrated = await hydrateOthers(engine, files, new Set(wanted.map((f) => f.id)));
  aiCalls += hydrated.aiCalls;
  scanned += hydrated.scanned;
  state.countAiCalls(aiCalls, engine.now());
  state.errors = [...errors, ...hydrated.errors];

  const tasks = (await Promise.all(files.map((f) => tracker.listTasks(f.id)))).flat();
  const { findings, setAside } = matchAll(engine, tasks);
  state.findings = findings;
  state.setAsideCommitments = setAside;

  // 9. Write (apply mode only): high-certainty changes, the audit entries, then metadata last.
  const { applied, held } = await commitWrites(engine, opts.trigger);
  state.finishCycle(engine.now(), opts.trigger, wanted.length);
  return { trigger: opts.trigger, filesChecked: wanted.length, filesScanned: scanned, aiCalls, applied, held };
}

// Files this cycle was not asked to scan still have to be in memory when their snapshot is on
// Box. Otherwise a one-file webhook after a restart mis-files commitments that live elsewhere.
async function hydrateOthers(engine: Engine, files: BoxFile[], wanted: Set<string>)
  : Promise<{ aiCalls: number; scanned: number; errors: State["errors"] }> {
  const { gateway, state } = engine;
  let aiCalls = 0;
  let scanned = 0;
  const errors: State["errors"] = [];
  for (const file of files) {
    if (wanted.has(file.id) || state.files.has(file.id)) continue;
    // One unreadable file is recorded like a scan error; it must not fail the whole cycle.
    let meta: Record<string, string>;
    try { meta = await gateway.getMeta(file.id); } catch (err) {
      errors.push({ fileId: file.id, message: `metadata read: ${errorMessage(err)}` });
      continue;
    }
    const marker = scanMarker(file.version);
    if (meta.hcScannedVersion !== marker) continue;
    state.markers.set(file.id, marker);
    state.metaMarkers.set(file.id, marker);
    if (meta.hcOpenFindings) state.metaCounts.set(file.id, meta.hcOpenFindings);
    if (restoreFile(state, file, meta.hcExtract)) continue;
    state.metaMarkers.delete(file.id);
    try {
      const r = await scanFile(engine, file, true);
      aiCalls += r.aiCalls;
      if (r.scanned) scanned++;
    } catch (err) {
      state.markers.delete(file.id);
      errors.push({ fileId: file.id, message: errorMessage(err) });
    }
  }
  return { aiCalls, scanned, errors };
}

// Writes the current findings, rematches so a task just created leaves the untracked bucket,
// then writes metadata. Shared by a cycle and by switching the page to apply mode.
export async function commitWrites(engine: Engine, trigger: Trigger): Promise<{ applied: number; held: number }> {
  const { gateway, tracker, state } = engine;
  if (state.mode !== "apply") return { applied: 0, held: 0 };
  const ctx: WriteContext = { tracker, audit: engine.audit, state, people: engine.people, now: engine.now };
  let applied = 0;
  let held = 0;
  const touched = new Set<string>();
  const touch = (f: Finding) => {
    if (f.commitment) touched.add(f.commitment.fileId);
    if (f.task) touched.add(f.task.fileId);
  };
  for (const f of state.findings) {
    if (!f.proposal) continue;
    if (f.certainty === "high") {
      if ((await applyFinding(ctx, f, trigger)).status === "applied") { applied++; touch(f); }
    } else if (await holdFinding(ctx, f, trigger)) { held++; touch(f); }
  }
  const listed = await gateway.listFiles(engine.config.scanFolderId);
  for (const f of listed) state.names.set(f.id, f.name);
  const files = inventory(listed, engine.config.maxFileBytes);
  const tasks = (await Promise.all(files.map((f) => tracker.listTasks(f.id)))).flat();
  const matched = matchAll(engine, tasks);
  state.findings = matched.findings;
  state.setAsideCommitments = matched.setAside;
  const at = engine.now().toISOString();
  const errors: State["errors"] = [];
  for (const r of state.files.values()) {
    const marker = scanMarker(r.version);
    const fresh = state.metaMarkers.get(r.id) !== marker;
    const open = String(state.findings
      .filter((f) => (f.commitment?.fileId ?? f.task?.fileId) === r.id && f.bucket !== "matched").length);
    // Write on a new version, a changed open count, or a write this cycle made for the file. A sweep
    // that changed nothing writes nothing, so 15-minute sweeps do not rewrite every file.
    if (!fresh && state.metaCounts.get(r.id) === open && !touched.has(r.id)) continue;
    const current = { hcLastChecked: at, hcOpenFindings: open, hcLastChange: trigger };
    try {
      // setMeta merges, so an unchanged version sends only the current fields and keeps hcExtract.
      await gateway.setMeta(r.id, fresh ? {
        hcDocType: r.docType, hcDocDate: r.docDate ?? "", ...current,
        hcExtract: snapshotOf(r),
        hcScannedVersion: marker,
      } : current);
    } catch (err) {
      // No marker or count, so the next cycle retries this file.
      state.metaCounts.delete(r.id);
      errors.push({ fileId: r.id, message: `${META_WRITE}${errorMessage(err)}` });
      continue;
    }
    state.metaMarkers.set(r.id, marker);
    state.metaCounts.set(r.id, open);
  }
  // Every file still owed a write was just tried, so these replace earlier write errors. A cycle has
  // already reset state.errors; a mode switch keeps the cycle's scan errors.
  state.errors = [...state.errors.filter((e) => !e.message.startsWith(META_WRITE)), ...errors];
  return { applied, held };
}

export class CycleBusyError extends Error {
  constructor() { super("A cycle is already running"); }
}

// One cycle at a time. Scan now gets a 409 while one runs; webhook and sweep work is queued and
// runs as soon as the current cycle ends.
export class CycleRunner {
  private current?: Promise<unknown>;
  private pending = new Set<string>();
  private pendingAll = false;
  private pendingTrigger: Trigger = "webhook";
  onError: (err: unknown) => void = (err) => console.error("cycle failed:", err);

  constructor(private engine: Engine) {}

  get running(): boolean { return !!this.current; }

  // One cycle, click, or mode switch at a time. Throws CycleBusyError synchronously when busy,
  // so a route can answer 409 before any write starts.
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.current) throw new CycleBusyError();
    const p = fn().finally(() => { this.current = undefined; this.drain(); });
    this.current = p;
    return p;
  }

  run(fileIds: string[] | "all", opts: { trigger: Trigger; full?: boolean }): Promise<CycleSummary> {
    return this.exclusive(() => runCycle(this.engine, fileIds, opts).catch((err) => {
      this.engine.state.running = undefined;
      this.onError(err);
      throw err;
    }));
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
