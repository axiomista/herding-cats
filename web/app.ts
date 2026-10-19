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
interface AppState {
  mode: "dry-run" | "apply"; watching: boolean;
  lastCycle?: { at: string; trigger: string; filesChecked: number };
  running?: { done: number; total: number }; aiCallsThisMonth: number;
  findings: Finding[]; setAside: ExtractedItem[];
  files?: Record<string, { name: string }>; errors?: { fileId: string; message: string }[];
  unverified?: ExtractedItem[];
}

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
}

// Header: file count, mode toggle, scan button

function renderHeader(s: AppState): void {
  const n = Object.keys(s.files ?? {}).length;
  $("files-chip").textContent = `📦 ${n} ${n === 1 ? "file" : "files"}`;
  $("mode-dry").setAttribute("aria-pressed", String(s.mode === "dry-run"));
  $("mode-apply").setAttribute("aria-pressed", String(s.mode === "apply"));
  const scan = $("scan-button") as HTMLButtonElement;
  scan.disabled = !!s.running;
  $("scan-label").textContent = s.running ? "Scanning…" : "Scan now";
}

async function setMode(mode: "dry-run" | "apply"): Promise<void> {
  const res = await post("/api/mode", { mode });
  if (res.status === 409) setNotice({ kind: "error", title: "A cycle is already running.", text: "Try again when it finishes." });
  else if (!res.ok) setNotice({ kind: "error", title: "Could not change mode." });
  else if (mode === "apply") {
    const out = await res.json() as { applied?: number; held?: number };
    setNotice({ kind: "ok", title: "Apply mode is on 📦", text: `Wrote ${out.applied ?? 0}, held ${out.held ?? 0} for review.` });
  } else setNotice({ kind: "info", title: "Dry run.", text: "Later cycles write nothing to Box until you click." });
  lastJson = "";
  await refresh();
}

// Findings that switching to apply would write now: high certainty, with something to write.
const readyToApply = (s: AppState) => s.findings.filter((f) =>
  f.certainty === "high" && f.proposal && f.bucket !== "orphan" && f.bucket !== "misfiled" && f.bucket !== "matched");

function openApplyDialog(): void {
  if (!state || state.mode === "apply") return;
  const ready = readyToApply(state).length;
  $("apply-ready").textContent = ready
    ? `Switching also applies the ${ready} ${ready === 1 ? "finding" : "findings"} that are ready now.`
    : "No findings are ready to apply right now. Only new findings will be applied.";
  const dialog = $("apply-dialog") as HTMLDialogElement;
  dialog.returnValue = "";
  dialog.showModal();
}

// Status strip, progress and notices

function statusCell(label: string, value: Child | Child[], sub: string): HTMLElement {
  const values = Array.isArray(value) ? value : [value];
  return h("div", {}, h("span", { class: "eyebrow" }, label), h("span", { class: "value" }, ...values), h("span", { class: "sub" }, sub));
}

function renderStatus(s: AppState): void {
  const last = s.lastCycle
    ? `${new Date(s.lastCycle.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${TRIGGER_LABELS[s.lastCycle.trigger] ?? s.lastCycle.trigger}`
    : "None yet";
  $("status").replaceChildren(
    statusCell("Monitoring", [h("span", { class: s.watching ? "dot" : "dot off", "aria-hidden": "true" }), s.watching ? "Active" : "Stopped"],
      s.watching ? "Watching the folder for changes" : "Not watching the folder"),
    statusCell("Mode", s.mode === "apply" ? "Apply" : "Dry run",
      s.mode === "apply" ? "Writes high-certainty fixes to Box" : "Writes nothing to Box until you click"),
    statusCell("Last check", last, s.lastCycle ? `${s.lastCycle.filesChecked} files checked` : "Press Scan now to start"),
    statusCell("Box AI calls since start", String(s.aiCallsThisMonth), "Unchanged files are skipped without an AI call"),
  );
  const errors = s.errors ?? [];
  const old = document.getElementById("file-errors");
  old?.remove();
  if (errors.length) {
    $("status").after(h("section", { id: "file-errors", class: "file-errors", "aria-label": "Files that failed" },
      h("strong", {}, "Files that failed 😿"),
      h("ul", {}, ...errors.map((e) => h("li", {}, `${fileName(e.fileId)}: ${e.message}`,
        button("Dismiss", () => void dismissFileError(e.fileId), "ghost"))))));
  }
}

// The server logs the dismissal to the audit log and skips this version of the file until a new one is uploaded.
async function dismissFileError(fileId: string): Promise<void> {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#file-errors button")) b.disabled = true;
  const name = fileName(fileId);
  try {
    const res = await post(`/api/files/${encodeURIComponent(fileId)}/dismiss-error`, {});
    const out = await res.json() as { status?: string; error?: string };
    if (out.error) setNotice({ kind: "error", title: "That didn't go through 😿", text: out.error });
    else setNotice({ kind: "info", title: "Dismissed.", text: `“${name}” is skipped until a new version is uploaded. This is in the audit log.` });
  } catch {
    setNotice({ kind: "error", title: "Could not reach the server." });
  }
  lastJson = "";
  await refresh();
}

function renderProgress(s: AppState): void {
  if (!s.running) { $("progress").replaceChildren(); return; }
  const { done, total } = s.running;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("progress").replaceChildren(h("section", { class: "progress", "aria-label": "Cycle progress" },
    h("div", { class: "heading-row" }, h("span", { class: "eyebrow" }, "Cycle running"),
      h("h2", {}, `Checking ${done} of ${total} files `, h("span", { "aria-hidden": "true" }, "📬"))),
    h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done) },
      h("div", { style: `width: ${pct}%` })),
    h("p", { class: "soft" }, "🐾 Quotes that don't appear word for word in their file are dropped and logged as unverified."),
  ));
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

  if (f.proposal) {
    const p = f.proposal;
    const preview = p.kind === "task"
      ? `New task on "${fileName(p.fileId)}":\n${p.message}\nAssigned to: ${p.assigneeName ?? "nobody"}\nDue: ${p.due ? day(p.due) : "none"}`
      : `Comment on "${fileName(p.fileId)}":\n${p.text}`;
    parts.push(h("div", { class: "stack-xs" },
      h("span", { class: "eyebrow" }, p.kind === "task" ? "Task this will create" : "Comment preview"),
      h("pre", { class: "mono-block" }, preview, "\n\n", h("span", { class: "fp" }, `fingerprint: ${f.fingerprint}`))));
  }

  const actions = h("div", { class: "actions" });
  if (f.proposal?.kind === "task") actions.append(button("Create task", () => send(f, "create_task")));
  if (f.proposal?.kind === "comment") actions.append(button("Post comment", () => send(f, "comment")));
  if (f.bucket !== "matched") actions.append(button(f.bucket === "orphan" ? "It's fine, dismiss" : "Dismiss", () => send(f, "dismiss"), "ghost"));
  const linkFile = t?.fileId ?? c?.fileId;
  if (linkFile) {
    actions.append(h("span", { class: "grow" }),
      h("a", { href: boxFileUrl(linkFile), target: "_blank", rel: "noopener" }, t ? "Open task's file in Box ↗" : "Open file in Box ↗"));
  }
  parts.push(actions);
  $("finding-detail").replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
}

function button(label: string, onClick: () => void, cls = "primary"): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${cls}` }, label) as HTMLButtonElement;
  b.onclick = onClick;
  return b;
}

async function send(f: Finding, action: string): Promise<void> {
  for (const b of $("finding-detail").querySelectorAll("button")) b.disabled = true;
  const title = titleOf(f);
  try {
    const res = await post(`/api/findings/${encodeURIComponent(f.id)}/actions`, { action });
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

async function loadAudit(): Promise<void> {
  const date = ($("audit-date") as HTMLInputElement).value;
  const res = await api(`/api/audit?date=${encodeURIComponent(date)}`);
  $("audit-text").textContent = res.ok ? (await res.text()) || "No entries for this day." : "Could not load the audit log.";
}

// Accuracy (dev only)

function scoreTile(label: string, value: string, of: string, note: string): HTMLElement {
  return h("div", { class: "score" }, h("span", { class: "label" }, label),
    h("span", { class: "big" }, value, of && h("small", {}, ` / ${of}`)), h("span", { class: "muted" }, note));
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
  if (($("apply-dialog") as HTMLDialogElement).returnValue === "apply") void setMode("apply");
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
