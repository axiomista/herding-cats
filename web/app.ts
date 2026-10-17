// The browser script. It keeps a copy of the response shapes it uses from src/types.ts.

type Bucket = "superseded" | "owner_conflict" | "date_conflict" | "misfiled" | "matched" | "untracked" | "orphan";

interface Commitment { fileId: string; text: string; evidence: string; owner?: string; due?: string; status: string;
  flags?: string[]; mentions?: { fileId: string; evidence: string }[]; statusEvidence?: { fileId: string; evidence: string; score?: number } }
interface TrackerTask { id: string; fileId: string; message: string; assigneeIds: string[]; due?: string; completed: boolean }
type Proposal =
  | { kind: "task"; fileId: string; message: string; assigneeName?: string; due?: string }
  | { kind: "comment"; fileId: string; text: string };
interface Finding { id: string; bucket: Bucket; certainty: "high" | "low"; checks: Record<string, boolean>;
  commitment?: Commitment; task?: TrackerTask; score?: number; fingerprint: string; proposal?: Proposal }
interface ExtractedItem { kind: string; action: string; owner?: string; evidence: string; fileId?: string; newStatus?: string }
interface CycleRecord { at: string; trigger: string; filesChecked: number; filesScanned?: number; aiCalls?: number; durationMs?: number }
interface AppState {
  mode: "dry-run" | "apply"; watching: boolean;
  lastCycle?: CycleRecord;
  running?: { done: number; total: number; trigger?: string; startedAt?: string; phase?: "files" | "match" | "write"; file?: string };
  aiCallsThisMonth: number;
  findings: Finding[]; setAside: ExtractedItem[];
  files?: Record<string, { name: string }>; errors?: { fileId: string; message: string }[];
  unverified?: ExtractedItem[];
  recentCycles?: Record<string, CycleRecord | undefined>; folderName?: string; waiting?: string[];
  sweepIntervalMinutes?: number; aiMonthlyBudget?: number;
}
interface AuditEntry { time: string; trigger: string; status: "applied" | "held"; fields: Record<string, string>; raw: string }

// Tile order follows the wireframes; the nickname is the cat name shown under each type.
const BUCKETS: { key: Bucket; name: string; nick: string; blurb: string }[] = [
  { key: "untracked", name: "Not tracked", nick: "🐈 Stray", blurb: "A commitment in a document with no task tracking it." },
  { key: "superseded", name: "Cancelled, still open", nick: "🚪 Door ajar", blurb: "A later document cancelled or completed it, but the task is still open." },
  { key: "owner_conflict", name: "Owner mismatch", nick: "🛋️ Wrong lap", blurb: "The task is assigned to someone other than the owner in the document." },
  { key: "date_conflict", name: "Due date mismatch", nick: "🍽️ Late for dinner", blurb: "The task's due date differs from the document's." },
  { key: "misfiled", name: "Task on wrong file", nick: "📦 Wrong box", blurb: "The task sits on a file that never mentions it." },
  { key: "orphan", name: "Task without a source", nick: "📦 Empty box", blurb: "A task exists, but no document in the folder commits to it. The assignee may know its source." },
  { key: "matched", name: "Matched", nick: "✅ Herded", blurb: "Document and task agree. No action needed." },
];
const bucketInfo = (b: Bucket) => BUCKETS.find((x) => x.key === b)!;

const CHECK_LABELS: Record<string, string> = {
  evidence: "evidence exact", owner: "owner resolved", dueDate: "date absolute", status: "status match clear",
  pairing: "pairing clear", bucket: "bucket safe to apply",
};
const TRIGGER_LABELS: Record<string, string> = { webhook: "upload", sweep: "sweep", full_scan: "full scan", click: "your click" };

type Tab = "findings" | "audit" | "accuracy";
type Notice = { kind: "ok" | "info" | "error"; title: string; text?: string; code?: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dev = new URLSearchParams(location.search).has("dev");
let state: AppState | undefined;
let lastJson = "";
let pollTimer: number | undefined;
let notice: Notice | undefined; // the last action's result, kept across re-renders
let filter: Bucket | "all" = "all";
let selectedId: string | undefined;
let auditEntries: AuditEntry[] = [];
let auditFilter: "all" | "applied" | "held" | "error" = "all";
let ticker: number | undefined;

type Child = Node | string | undefined | false;
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

const fileName = (id: string) => state?.files?.[id]?.name ?? `file ${id}`;
const boxFileUrl = (id: string) => `https://app.box.com/file/${encodeURIComponent(id)}`;
const fileLink = (id: string) => h("a", { href: boxFileUrl(id), target: "_blank", rel: "noopener" }, `📄 ${fileName(id)} ↗`);

const seconds = (ms?: number) => (ms === undefined ? "–" : (ms / 1000).toFixed(ms < 10_000 ? 1 : 0));
const elapsed = (from?: string) => {
  if (!from) return "";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(from)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Due dates are plain YYYY-MM-DD. Format them in UTC so the day never shifts.
function day(iso?: string): string {
  if (!iso) return "none set";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, { credentials: "same-origin", ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (res.status === 401 && path !== "/api/session") showPasscode();
  return res;
}

const post = (path: string, body: unknown = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

function showPasscode(): void {
  $("passcode").hidden = false;
  $("app").hidden = true;
  if (pollTimer) clearTimeout(pollTimer);
}

function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = window.setTimeout(refresh, state?.running ? 3000 : 30000);
}

async function refresh(): Promise<void> {
  try {
    const res = await api("/api/state");
    if (res.status === 401) return; // showPasscode already stopped the timer
    if (!res.ok) { schedulePoll(); return; }
    const json = await res.text();
    state = JSON.parse(json) as AppState;
    $("passcode").hidden = true;
    $("app").hidden = false;
    // Skip identical polls so the page does not redraw under the reader.
    if (json !== lastJson) { lastJson = json; render(); }
    schedulePoll();
  } catch {
    schedulePoll();
  }
}

function setNotice(n: Notice | undefined): void {
  notice = n;
  renderNotice();
}

function render(): void {
  if (!state) return;
  renderHeader(state);
  renderStatus(state);
  renderProgress(state);
  renderNotice();
  renderTiles(state);
  renderList(state);
  renderDetail(state);
  if (dev) renderTimings(state);
}

// Header: file count, mode toggle, scan button

function renderHeader(s: AppState): void {
  const n = Object.keys(s.files ?? {}).length;
  $("files-chip").textContent = `📦 ${s.folderName ? `${s.folderName} · ` : ""}${n} ${n === 1 ? "file" : "files"}`;
  $("mode-dry").setAttribute("aria-pressed", String(s.mode === "dry-run"));
  $("mode-apply").setAttribute("aria-pressed", String(s.mode === "apply"));
  const scan = $("scan-button") as HTMLButtonElement;
  scan.disabled = !!s.running;
  $("scan-label").textContent = s.running ? "Scanning…" : "Scan now";
}

async function setMode(mode: "dry-run" | "apply", applyExisting = false): Promise<void> {
  const res = await post("/api/mode", { mode, applyExisting });
  if (res.status === 409) setNotice({ kind: "error", title: "A cycle is already running.", text: "Try again when it finishes." });
  else if (!res.ok) setNotice({ kind: "error", title: "Could not change mode." });
  else if (mode === "apply") {
    const out = await res.json() as { applied?: number; held?: number };
    setNotice({ kind: "ok", title: "Apply mode is on 📦", text: applyExisting
      ? `Wrote ${out.applied ?? 0}, held ${out.held ?? 0} for review.`
      : "Findings already on the page wait for a click. New findings are applied automatically." });
  } else setNotice({ kind: "info", title: "Dry run.", text: "Later cycles write nothing to Box until you click." });
  lastJson = "";
  await refresh();
}

// Findings that switching to apply would write now: high certainty, with something to write.
const readyToApply = (s: AppState) => s.findings.filter((f) =>
  f.certainty === "high" && f.proposal && f.bucket !== "orphan" && f.bucket !== "misfiled" && f.bucket !== "matched");

function openApplyDialog(): void {
  if (!state || state.mode === "apply") return;
  const ready = readyToApply(state);
  const tasks = ready.filter((f) => f.proposal?.kind === "task").length;
  const box = $("apply-now") as HTMLInputElement;
  box.checked = false;
  box.disabled = !ready.length;
  $("apply-now-title").textContent = ready.length
    ? `Also apply the ${ready.length} ${ready.length === 1 ? "finding" : "findings"} that are ready now`
    : "No findings are ready to apply right now";
  $("apply-now-sub").textContent = ready.length
    ? `${tasks} ${tasks === 1 ? "task" : "tasks"} and ${ready.length - tasks} ${ready.length - tasks === 1 ? "comment" : "comments"}. Otherwise they wait for a click, and only new findings are applied.`
    : "Only new findings will be applied.";
  const dialog = $("apply-dialog") as HTMLDialogElement;
  dialog.returnValue = "";
  dialog.showModal();
}

// Status strip, progress and notices

function statusCell(label: string, value: Child | Child[], sub: string): HTMLElement {
  const values = Array.isArray(value) ? value : [value];
  return h("div", {}, h("span", { class: "eyebrow" }, label), h("span", { class: "value" }, ...values), h("span", { class: "sub" }, sub));
}

function lastCycleLine(c: CycleRecord): string {
  const parts = [`${c.filesChecked} files checked`];
  if (c.filesScanned !== undefined) parts.push(`${c.filesScanned} read`);
  if (c.aiCalls !== undefined) parts.push(`${c.aiCalls} AI ${c.aiCalls === 1 ? "call" : "calls"}`);
  if (c.durationMs !== undefined) parts.push(`${seconds(c.durationMs)} s`);
  return parts.join(" · ");
}

function aiCell(s: AppState): HTMLElement {
  const used = s.aiCallsThisMonth;
  const budget = s.aiMonthlyBudget;
  if (!budget) return statusCell("Box AI calls since start", String(used), "Unchanged files are skipped without an AI call");
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const cell = statusCell("Box AI calls since start", [String(used), h("small", { class: "of" }, `of ${budget.toLocaleString()} a month`)],
    "Box's admin console has the exact monthly figure");
  cell.insertBefore(h("div", { class: "bar thin", role: "progressbar", "aria-label": "Share of monthly Box AI budget",
    "aria-valuemin": "0", "aria-valuemax": String(budget), "aria-valuenow": String(used) }, h("div", { style: `width: ${Math.max(pct, used ? 2 : 0)}%` })),
    cell.lastChild);
  return cell;
}

function renderStatus(s: AppState): void {
  const last = s.lastCycle
    ? `${new Date(s.lastCycle.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${TRIGGER_LABELS[s.lastCycle.trigger] ?? s.lastCycle.trigger}`
    : "None yet";
  $("status").replaceChildren(
    statusCell("Monitoring", [h("span", { class: s.watching ? "dot" : "dot off", "aria-hidden": "true" }), s.watching ? "Active" : "Stopped"],
      !s.watching ? "Not watching the folder"
        : s.sweepIntervalMinutes ? `Uploads checked as they arrive · sweep every ${s.sweepIntervalMinutes} min` : "Watching the folder for changes"),
    statusCell("Mode", s.mode === "apply" ? "Apply" : "Dry run",
      s.mode === "apply" ? "Writes high-certainty fixes to Box" : "Writes nothing to Box until you click"),
    statusCell("Last check", last, s.lastCycle ? lastCycleLine(s.lastCycle) : "Press Scan now to start"),
    aiCell(s),
  );
  const errors = s.errors ?? [];
  const old = document.getElementById("file-errors");
  old?.remove();
  if (errors.length) {
    $("status").after(h("section", { id: "file-errors", class: "file-errors", "aria-label": "Files that failed" },
      h("strong", {}, "Files that failed 😿"),
      h("ul", {}, ...errors.map((e) => h("li", {}, `${fileName(e.fileId)}: ${e.message}`)))));
  }
}

// What each trigger's cycle is called, and the time it should finish in (the spec's targets).
const CYCLE_LABELS: Record<string, { eyebrow: string; target?: string }> = {
  webhook: { eyebrow: "New upload received from Box", target: "1:00" },
  full_scan: { eyebrow: "Full scan", target: "1:30" },
  sweep: { eyebrow: "Scheduled sweep", target: "0:10" },
  click: { eyebrow: "Cycle running" },
};
const PHASES = ["files", "match", "write"] as const;

function renderProgress(s: AppState): void {
  if (!s.running) {
    $("progress").replaceChildren();
    if (ticker) { clearInterval(ticker); ticker = undefined; }
    return;
  }
  const { done, total, file, startedAt } = s.running;
  const phase = s.running.phase ?? "files";
  const label = CYCLE_LABELS[s.running.trigger ?? "click"] ?? CYCLE_LABELS.click;
  const at = PHASES.indexOf(phase);
  const step = (i: number, name: string, sub: string) => {
    const where = i < at ? "done" : i === at ? "current" : "todo";
    return h("li", { class: `step ${where}`, "aria-current": where === "current" ? "step" : "false" },
      h("span", { class: "step-name" }, `${where === "done" ? "✓ " : where === "current" ? "⏳ " : ""}${name}`), h("span", { class: "step-sub" }, sub));
  };
  const timer = h("span", { id: "cycle-timer", class: "mono timer" }, elapsed(startedAt));
  $("progress").replaceChildren(h("section", { class: "progress", "aria-label": "Cycle progress" },
    h("div", { class: "heading-row" },
      h("span", { class: "eyebrow" }, label.eyebrow),
      h("h2", {}, file ? `Checking “${file}” ` : `Checking ${total} ${total === 1 ? "file" : "files"} `, h("span", { "aria-hidden": "true" }, "📬")),
      h("span", { class: "grow" }),
      startedAt && h("span", {}, timer, label.target ? h("span", { class: "muted" }, ` / target under ${label.target}`) : "")),
    h("ol", { class: "steps" },
      step(0, "Read files", `${done} of ${total} · classify, extract, verify`),
      step(1, "Match", "against the folder's Box tasks"),
      step(2, "Write", s.mode === "apply" ? "high-certainty fixes, then the audit log" : "skipped · dry run")),
    h("p", { class: "soft" }, "🐾 Quotes that don't appear word for word in their file are dropped and logged as unverified."),
  ));
  if (!ticker) {
    ticker = window.setInterval(() => {
      const el = document.getElementById("cycle-timer");
      if (el) el.textContent = elapsed(state?.running?.startedAt);
    }, 1000);
  }
}

function renderNotice(): void {
  if (!notice) { $("notice").replaceChildren(); return; }
  const close = h("button", { type: "button", class: "close", "aria-label": "Dismiss message" }, "Close");
  close.onclick = () => setNotice(undefined);
  $("notice").replaceChildren(h("div", { class: `banner ${notice.kind}` },
    h("strong", {}, notice.title),
    notice.text && h("span", { class: "soft" }, notice.text),
    notice.code && h("code", {}, notice.code),
    close));
}

// Bucket tiles

function renderTiles(s: AppState): void {
  const tile = (key: Bucket | "all", count: number, name: string, nick: string) => {
    const b = h("button", { type: "button", class: "tile", "aria-pressed": String(filter === key) },
      h("span", { class: "count" }, String(count)), h("span", { class: "name" }, name), h("span", { class: "nick" }, nick));
    b.onclick = () => { filter = key; renderTiles(s); renderList(s); renderDetail(s); };
    return b;
  };
  const docs = new Set(s.findings.map((f) => f.commitment?.fileId ?? f.task?.fileId)).size;
  $("types-summary").textContent = s.findings.length
    ? `${s.findings.length} findings across ${docs} ${docs === 1 ? "document" : "documents"}. Select a type to filter.`
    : "";
  $("bucket-tiles").replaceChildren(
    tile("all", s.findings.length, "All findings", "the whole litter"),
    ...BUCKETS.map((b) => tile(b.key, s.findings.filter((f) => f.bucket === b.key).length, b.name, b.nick)),
  );
}

// Finding list

function subtitle(f: Finding): string {
  const c = f.commitment;
  const t = f.task;
  switch (f.bucket) {
    case "untracked":
      return [c?.owner, c?.due && `due ${day(c.due)}`, "no task"].filter(Boolean).join(" · ");
    case "superseded":
      return `${c?.status === "completed" ? "Completed" : "Cancelled"}${c?.statusEvidence ? ` in ${fileName(c.statusEvidence.fileId)}` : ""} · task still open`;
    case "owner_conflict":
      return `Doc says ${c?.owner ?? "nobody"} · task is assigned to someone else`;
    case "date_conflict":
      return `Doc says ${day(c?.due)} · task says ${day(t?.due)}`;
    case "misfiled":
      return [t && `Task on ${fileName(t.fileId)}`, c && `commitment is in ${fileName(c.fileId)}`].filter(Boolean).join(" · ");
    case "orphan":
      return `${t ? `Task on ${fileName(t.fileId)} · ` : ""}no source commitment found`;
    case "matched":
      return [c?.owner, c?.due && `due ${day(c.due)}`].filter(Boolean).join(" · ");
  }
}

const titleOf = (f: Finding) => f.commitment?.text ?? f.task?.message ?? "";

function listItem(f: Finding): HTMLElement {
  const info = bucketInfo(f.bucket);
  const b = h("button", { type: "button", class: `item b-${f.bucket}`, "aria-current": String(f.id === selectedId) },
    h("span", { class: "kind" }, `${info.name.toUpperCase()} · ${info.nick}`),
    h("span", { class: "title" }, titleOf(f)),
    h("span", { class: "sub" }, subtitle(f)));
  b.onclick = () => {
    selectedId = f.id;
    if (state) { renderList(state); renderDetail(state); }
    $("finding-detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  return b;
}

function group(cls: string, title: string, emoji: string, blurb: string, items: Finding[]): HTMLElement | undefined {
  if (!items.length) return undefined;
  return h("div", { class: `group ${cls}` },
    h("h3", {}, title, h("span", { "aria-hidden": "true" }, emoji), h("span", { class: "n" }, `· ${items.length}`)),
    h("p", {}, blurb), ...items.map(listItem));
}

function visible(s: AppState): Finding[] {
  if (filter === "all") return s.findings;
  return s.findings.filter((f) => f.bucket === filter);
}

function renderList(s: AppState): void {
  const shown = visible(s);
  if (!shown.some((f) => f.id === selectedId)) {
    // Default to the first finding waiting for a person, then the first ready one.
    const open = shown.filter((f) => f.bucket !== "matched");
    selectedId = (open.find((f) => f.certainty === "low") ?? open[0] ?? shown[0])?.id;
  }
  const open = shown.filter((f) => f.bucket !== "matched");
  const matched = shown.filter((f) => f.bucket === "matched");
  const parts: Child[] = [
    group("review", "Needs review", "👀", "Low certainty. A person decides.", open.filter((f) => f.certainty === "low")),
    group("ready", "Ready to apply", "😺", "All checks passed.", open.filter((f) => f.certainty === "high")),
  ];
  if (filter === "matched") {
    parts.push(group("", "Matched", "✅", "Tracked correctly, no action needed.", matched));
  } else if (matched.length) {
    const fold = h("details", { class: "fold" },
      h("summary", {}, `Matched `, h("span", { "aria-hidden": "true" }, "✅"), ` · ${matched.length} · tracked correctly, no action needed`),
      h("div", { class: "fold-body" }, ...matched.map(listItem)));
    if (matched.some((f) => f.id === selectedId)) fold.setAttribute("open", "");
    parts.push(fold);
  }
  if (filter === "all") parts.push(setAsideFold(s));
  if (!shown.length) {
    parts.unshift(h("p", { class: "empty" }, !s.lastCycle ? "No scan yet. Press Scan now. 🐈"
      : filter === "all" ? "No findings. Every cat is herded. 😺" : "No findings of this type."));
  }
  $("finding-list").replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
}

function setAsideFold(s: AppState): HTMLElement {
  const item = (i: ExtractedItem) => h("li", {}, h("b", {}, `${i.newStatus ?? i.kind.replace("_", " ")}: `), i.action,
    i.fileId ? h("span", { class: "muted" }, ` (${fileName(i.fileId)})`) : "");
  const unverified = s.unverified ?? [];
  return h("details", { class: "fold" },
    h("summary", {}, `Set aside `, h("span", { "aria-hidden": "true" }, "💬"), ` · ${s.setAside.length} · recognized, not tracked`),
    h("div", { class: "fold-body" },
      h("p", {}, "Ideas, decisions, open questions, policies and cancelled commitments the app recognized and chose not to track. Shown so reviewers can see nothing was ignored."),
      s.setAside.length ? h("ul", {}, ...s.setAside.map(item)) : "",
      unverified.length ? h("div", {}, h("b", {}, "Dropped: evidence not found in the file"), h("ul", {}, ...unverified.map(item))) : ""));
}

// Finding detail

function quoteBox(label: string, text: string, fileId: string): HTMLElement {
  return h("div", { class: "quote" }, h("span", { class: "eyebrow" }, label), h("p", {}, `“${text}”`), fileLink(fileId));
}

function fact(k: string, v: string): HTMLElement {
  return h("span", {}, h("span", { class: "k" }, k), v);
}

function renderDetail(s: AppState): void {
  const f = s.findings.find((x) => x.id === selectedId);
  if (!f || !visible(s).includes(f)) { $("finding-detail").replaceChildren(); return; }
  const info = bucketInfo(f.bucket);
  const c = f.commitment;
  const t = f.task;
  const parts: Child[] = [
    h("div", { class: "badges" },
      h("span", { class: `badge bucket b-${f.bucket}` }, `${info.name.toUpperCase()} · ${info.nick}`),
      h("span", { class: `badge ${f.certainty}` }, f.certainty === "high" ? "High certainty" : "Needs review 👀"),
      h("span", { class: "grow" }),
      f.score !== undefined && h("span", { class: "muted" }, `match score ${f.score}`)),
    h("div", { class: "stack-xs" }, h("h2", { id: "detail-title" }, titleOf(f)), h("p", { class: "soft" }, info.blurb)),
  ];

  const quotes: HTMLElement[] = [];
  if (c) quotes.push(quoteBox("Commitment", c.evidence, c.fileId));
  if (c?.statusEvidence) quotes.push(quoteBox(c.status === "completed" ? "Completed by" : "Cancelled by", c.statusEvidence.evidence, c.statusEvidence.fileId));
  if (quotes.length) parts.push(h("div", { class: "two-up" }, ...quotes));
  else if (f.bucket === "orphan") parts.push(h("p", { class: "empty" }, "🔍 No document in the folder commits to this task."));

  if (t) {
    parts.push(h("div", { class: "facts" },
      fact("Box task", t.message),
      fact("Assignee", t.assigneeIds.length ? (c?.owner && f.bucket !== "owner_conflict" ? c.owner : "assigned") : "unassigned"),
      fact("Due", day(t.due)),
      fact("Status", t.completed ? "completed" : "open"),
      fact("On", fileName(t.fileId))));
  } else if (c) {
    parts.push(h("div", { class: "facts" }, fact("Owner", c.owner ?? "not named"), fact("Due", day(c.due)), fact("Task", "none found")));
  }
  if (c?.flags?.length) parts.push(h("p", { class: "soft" }, `Flags: ${c.flags.join(", ")}`));

  const checks = Object.entries(f.checks);
  const passed = checks.filter(([, ok]) => ok).length;
  parts.push(h("div", { class: "stack-xs" },
    h("span", { class: "eyebrow" }, `Checks · ${passed} of ${checks.length} passed`),
    h("ul", { class: "checks" }, ...checks.map(([k, ok]) =>
      h("li", { class: ok ? "pass" : "fail" }, `${ok ? "✓" : "✕"} ${CHECK_LABELS[k] ?? k}`)))));

  let draft: HTMLTextAreaElement | undefined;
  if (f.proposal?.kind === "comment" && f.bucket === "orphan") {
    // An orphan's comment asks a person a question, so it can be reworded before posting.
    draft = h("textarea", { id: "comment-draft", rows: "4", class: "draft" }) as HTMLTextAreaElement;
    draft.value = commentBody(f.proposal.text);
    parts.push(h("div", { class: "stack-xs" },
      h("label", { for: "comment-draft", class: "eyebrow" }, "Comment draft (edit before posting)"),
      draft,
      h("span", { class: "muted small" }, `The fingerprint line is added when it is posted: fingerprint: ${f.fingerprint}`)));
  } else if (f.proposal) {
    const p = f.proposal;
    const preview = p.kind === "task"
      ? `New task on "${fileName(p.fileId)}":\n${p.message}\nAssigned to: ${p.assigneeName ?? "nobody"}\nDue: ${p.due ? day(p.due) : "none"}`
      : `Comment on "${fileName(p.fileId)}":\n${commentBody(p.text)}`;
    parts.push(h("div", { class: "stack-xs" },
      h("span", { class: "eyebrow" }, p.kind === "task" ? "Task this will create" : "Comment preview"),
      h("pre", { class: "mono-block" }, preview, "\n\n", h("span", { class: "fp" }, `fingerprint: ${f.fingerprint}`))));
  }
  if (s.mode === "apply" && f.certainty === "high" && s.waiting?.includes(f.id)) {
    parts.push(h("p", { class: "banner info" }, "⏸ Apply mode won't write this automatically: it was ready before apply mode was turned on. Click to write it."));
  }

  const actions = h("div", { class: "actions" });
  if (f.proposal?.kind === "task") actions.append(button("Create task", () => send(f, "create_task")));
  if (f.proposal?.kind === "comment") {
    actions.append(button(draft ? "Ask for the source" : "Post comment", () => send(f, "comment", draft?.value)));
  }
  if (f.bucket !== "matched") actions.append(button(f.bucket === "orphan" ? "It's fine, dismiss" : "Dismiss", () => send(f, "dismiss"), "ghost"));
  const linkFile = t?.fileId ?? c?.fileId;
  if (linkFile) {
    actions.append(h("span", { class: "grow" }),
      h("a", { href: boxFileUrl(linkFile), target: "_blank", rel: "noopener" }, t ? "Open task's file in Box ↗" : "Open file in Box ↗"));
  }
  parts.push(actions);
  $("finding-detail").replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
}

// A proposal's comment text without its trailing fingerprint line, which the page shows apart.
const commentBody = (text: string) => text.split("\n").filter((l) => !/^\s*fingerprint:/.test(l)).join("\n").trim();

function button(label: string, onClick: () => void, cls = "primary"): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${cls}` }, label) as HTMLButtonElement;
  b.onclick = onClick;
  return b;
}

async function send(f: Finding, action: string, text?: string): Promise<void> {
  if (text !== undefined && !text.trim()) { setNotice({ kind: "error", title: "The comment is empty." }); return; }
  for (const b of $("finding-detail").querySelectorAll("button")) b.disabled = true;
  const title = titleOf(f);
  try {
    const res = await post(`/api/findings/${encodeURIComponent(f.id)}/actions`, text === undefined ? { action } : { action, text });
    const out = await res.json() as { change?: string; outcome?: string; error?: string; status?: string };
    if (out.error) setNotice({ kind: "error", title: "That didn't go through 😿", text: out.error });
    else if (out.status === "dismissed") setNotice({ kind: "info", title: "Dismissed.", text: `“${title}”` });
    else if (out.status === "applied" && (!out.outcome || out.outcome === "ok")) {
      setNotice({ kind: "ok", title: "Done · 😺 Herded", text: out.change ?? title });
    } else if (out.status === "applied") {
      setNotice({ kind: "error", title: "Partly done · 😿 Hairball", text: `${out.change ?? title}. This is in the audit log.`, code: out.outcome });
    } else if (out.status === "failed") {
      setNotice({ kind: "error", title: "Box refused the change 😿", text: out.change ? `${out.change}. This is in the audit log.` : "This is in the audit log.", code: out.outcome });
    } else setNotice({ kind: "info", title: `${out.status ?? "Done"}`, text: out.change });
  } catch {
    setNotice({ kind: "error", title: "Could not reach the server." });
  }
  lastJson = "";
  await refresh();
}

// Tabs

function currentTab(): Tab {
  const t = location.hash.slice(1);
  if (t === "audit") return "audit";
  if (t === "accuracy" && dev) return "accuracy";
  return "findings";
}

function showTab(): void {
  const tab = currentTab();
  for (const name of ["findings", "audit", "accuracy"] as Tab[]) $(`tab-${name}`).hidden = name !== tab;
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".tabs a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (tab === "audit") void loadAudit();
}

// Audit log

const AUDIT_VIA: Record<string, string> = { webhook: "via upload", sweep: "via sweep", "full-scan": "via full scan", click: "via your click" };
const isError = (e: AuditEntry) => e.status === "applied" && !!e.fields.outcome && e.fields.outcome !== "ok";

async function loadAudit(): Promise<void> {
  const date = ($("audit-date") as HTMLInputElement).value;
  const res = await api(`/api/audit?date=${encodeURIComponent(date)}&format=json`);
  if (!res.ok) {
    auditEntries = [];
    $("audit-filters").replaceChildren();
    $("audit-list").replaceChildren(h("li", { class: "empty" }, "Could not load the audit log."));
    return;
  }
  // Newest first, like the wireframe; the day file is oldest first.
  auditEntries = ((await res.json()) as { entries: AuditEntry[] }).entries.reverse();
  renderAudit();
}

function renderAudit(): void {
  const counts = {
    all: auditEntries.length,
    applied: auditEntries.filter((e) => e.status === "applied" && !isError(e)).length,
    held: auditEntries.filter((e) => e.status === "held").length,
    error: auditEntries.filter(isError).length,
  };
  const chip = (key: typeof auditFilter, label: string) => {
    const b = h("button", { type: "button", class: "filter", "aria-pressed": String(auditFilter === key) }, `${label} · ${counts[key]}`);
    b.onclick = () => { auditFilter = key; renderAudit(); };
    return b;
  };
  $("audit-filters").replaceChildren(chip("all", "All"), chip("applied", "Applied"), chip("held", "Held"), chip("error", "Errors"));
  const shown = auditEntries.filter((e) => auditFilter === "all" ? true
    : auditFilter === "error" ? isError(e) : auditFilter === "applied" ? e.status === "applied" && !isError(e) : e.status === "held");
  if (!shown.length) {
    $("audit-list").replaceChildren(h("li", { class: "empty" }, auditEntries.length ? "No entries of this kind." : "No entries for this day. 🐾"));
    return;
  }
  $("audit-list").replaceChildren(...shown.map(auditCard));
}

function auditCard(e: AuditEntry): HTMLElement {
  const err = isError(e);
  const kind = err ? "error" : e.status;
  const f = e.fields;
  const action = (f.finding ?? "").replace(/^\w+: /, "");
  const title = e.status === "held" ? `Held “${action}” for review` : (f.change ?? "").replace(/^./, (c) => c.toUpperCase());
  const row = (k: string, v: string | undefined, cls = "") => v ? [h("span", { class: "k" }, k), h("span", { class: cls }, v)] : [];
  return h("li", { class: `audit-entry ${kind}` },
    h("div", { class: "badges" },
      h("span", { class: "mono soft" }, e.time.slice(11)),
      h("span", { class: `badge status-${kind}` }, err ? "APPLIED · ERROR" : e.status.toUpperCase()),
      h("span", { class: "muted" }, AUDIT_VIA[e.trigger] ?? `via ${e.trigger}`)),
    h("p", { class: "audit-title" }, title),
    h("div", { class: "kv" },
      ...row("Finding", f.finding), ...row("Evidence", f.evidence), ...row("Certainty", f.certainty),
      ...row("Match", f.match), ...row("Model", f.model), ...(err ? row("Outcome", f.outcome, "mono bad") : [])),
    h("details", {}, h("summary", {}, "Show raw entry"), h("pre", { class: "mono-block" }, e.raw)));
}

// Accuracy (dev only)

function renderTimings(s: AppState): void {
  const c = s.recentCycles ?? {};
  const full = c.full_scan;
  const sweep = c.sweep;
  const upload = c.webhook;
  $("timings").replaceChildren(
    scoreTile(full ? `Full scan, ${full.filesChecked} files` : "Full scan", full ? seconds(full.durationMs) : "–", "", "Target under 90 s", " s"),
    scoreTile(sweep?.filesScanned ? `Last sweep, ${sweep.filesScanned} read` : "Last sweep", sweep ? seconds(sweep.durationMs) : "–", "",
      "Target when nothing changed: under 10 s, 0 AI calls",
      sweep ? ` s · ${sweep.aiCalls ?? "–"} AI calls` : " s"),
    scoreTile("Upload cycle", upload ? seconds(upload.durationMs) : "–", "", "Webhook to findings · target under 1 minute", " s"),
  );
}

function scoreTile(label: string, value: string, of: string, note: string, unit = ""): HTMLElement {
  return h("div", { class: "score" }, h("span", { class: "label" }, label),
    h("span", { class: "big" }, value, of && h("small", {}, ` / ${of}`), unit && h("small", {}, unit)), h("span", { class: "muted" }, note));
}

async function score(): Promise<void> {
  const res = await post("/api/score");
  const out = $("eval-result");
  if (!res.ok) { out.replaceChildren(h("p", { class: "empty" }, "Scoring is not available in this build.")); return; }
  const r = await res.json() as { recall: { found: number; total: number; missing: string[]; c01Count: number };
    falsePositives: { count: number; items: string[] }; tasks: { id: string; expected: string; actual?: string; ok: boolean }[];
    untracked: { expected: string[]; missing: string[] } };
  const right = r.tasks.filter((t) => t.ok).length;
  const c01 = r.recall.c01Count;
  out.replaceChildren(
    h("section", { class: "scores", "aria-label": "Scores" },
      scoreTile("Commitments found", String(r.recall.found), String(r.recall.total), `Target ${r.recall.total} of ${r.recall.total} (recall)`),
      scoreTile("False positives", String(r.falsePositives.count), "", "Target at most 1 (precision)"),
      scoreTile("Tasks classified correctly", String(right), String(r.tasks.length), `Target ${r.tasks.length} of ${r.tasks.length}`),
      scoreTile("Untracked found", String(r.untracked.expected.length - r.untracked.missing.length), String(r.untracked.expected.length), "Commitments with no task"),
      scoreTile("C01 copies", String(c01), "", c01 === 1 ? "Counted once, as wanted" : "Want 1")),
    h("section", { class: "panel", "aria-labelledby": "buckets-title" },
      h("h2", { id: "buckets-title" }, "Planted tasks: expected vs. actual"),
      h("div", { class: "scroll-x" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Task"), h("th", { scope: "col" }, "Expected"), h("th", { scope: "col" }, "Got"))),
        h("tbody", {}, ...r.tasks.map((t) => h("tr", {}, h("td", {}, t.id), h("td", {}, t.expected),
          h("td", { class: t.ok ? "ok" : "bad" }, `${t.ok ? "✓ " : "✕ "}${t.actual ?? "none"}`))))))),
  );
}

function pacificToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

// Wiring

$("passcode-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await post("/api/session", { passcode: ($("passcode-input") as HTMLInputElement).value });
  const err = $("passcode-error");
  err.hidden = res.ok;
  err.textContent = res.ok ? ""
    : res.status === 429 ? "Too many wrong passcodes. Try again in a few minutes. 😿" : "That passcode didn't match. Ask your demo host. 😿";
  if (res.ok) { lastJson = ""; await refresh(); showTab(); }
});
$("mode-apply").addEventListener("click", openApplyDialog);
$("mode-dry").addEventListener("click", () => { if (state?.mode === "apply") void setMode("dry-run"); });
$("apply-dialog").addEventListener("close", () => {
  if (($("apply-dialog") as HTMLDialogElement).returnValue === "apply") void setMode("apply", ($("apply-now") as HTMLInputElement).checked);
});
$("scan-button").addEventListener("click", async () => {
  const res = await post("/api/scan");
  setNotice(res.status === 409 ? { kind: "error", title: "A cycle is already running." }
    : res.ok ? { kind: "info", title: "Full scan started. 🐈" } : { kind: "error", title: "Could not start a scan." });
  lastJson = "";
  await refresh();
});
($("audit-date") as HTMLInputElement).value = pacificToday();
$("audit-date").addEventListener("change", loadAudit);
$("score-button").addEventListener("click", score);
document.querySelector<HTMLElement>('.tabs a[data-tab="accuracy"]')!.hidden = !dev;
window.addEventListener("hashchange", showTab);

refresh().then(showTab);
