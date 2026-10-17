// The browser script. It keeps a copy of the response shapes it uses from src/types.ts.

type Bucket = "superseded" | "owner_conflict" | "date_conflict" | "misfiled" | "matched" | "untracked" | "orphan";

interface Commitment { fileId: string; text: string; evidence: string; owner?: string; due?: string; status: string;
  flags?: string[]; mentions?: { fileId: string; evidence: string }[]; statusEvidence?: { fileId: string; evidence: string } }
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

const BUCKETS: { key: Bucket; title: string; blurb: string }[] = [
  { key: "superseded", title: "Superseded", blurb: "The plan cancelled or completed it; the task is still open." },
  { key: "owner_conflict", title: "Owner conflict", blurb: "The task is assigned to someone other than the owner." },
  { key: "date_conflict", title: "Date conflict", blurb: "The task's due date differs from the document's." },
  { key: "misfiled", title: "Misfiled", blurb: "The task sits on a file that never mentions it." },
  { key: "untracked", title: "Untracked", blurb: "A promise with no task." },
  { key: "orphan", title: "Orphan", blurb: "A task no document explains." },
  { key: "matched", title: "Matched", blurb: "Document and task agree." },
];

const CHECK_LABELS: Record<string, string> = {
  evidence: "evidence exact", owner: "owner resolved", dueDate: "date absolute", pairing: "pairing clear", bucket: "safe to apply",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dev = new URLSearchParams(location.search).has("dev");
let state: AppState | undefined;
let pollTimer: number | undefined;
let notice = ""; // the last action's result, kept across re-renders

type Child = Node | string | undefined | false;
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

const fileName = (id: string) => state?.files?.[id]?.name ?? `file ${id}`;
const fileLink = (id: string) => h("a", { href: `https://app.box.com/file/${encodeURIComponent(id)}`, target: "_blank", rel: "noopener" }, fileName(id));

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
    state = await res.json() as AppState;
    $("passcode").hidden = true;
    $("app").hidden = false;
    render();
    schedulePoll();
  } catch {
    schedulePoll();
  }
}

function render(): void {
  if (!state) return;
  renderStatus(state);
  renderFindings(state);
  renderSetAside(state);
  $("eval").hidden = !dev;
}

function stat(value: string, label: string): HTMLElement {
  return h("div", { class: "stat" }, h("b", {}, value), h("span", {}, label));
}

function renderStatus(s: AppState): void {
  const last = s.lastCycle
    ? `${new Date(s.lastCycle.at).toLocaleTimeString()} · ${s.lastCycle.trigger.replace("_", " ")} · ${s.lastCycle.filesChecked} files`
    : "none yet";
  const scan = h("button", { type: "button" }, s.running ? `Scanning ${s.running.done}/${s.running.total}…` : "Scan now") as HTMLButtonElement;
  scan.disabled = !!s.running;
  scan.onclick = async () => {
    const res = await post("/api/scan");
    notice = res.status === 409 ? "A cycle is already running." : "Full scan started.";
    await refresh();
  };
  const other = s.mode === "apply" ? "dry-run" : "apply";
  const mode = h("button", { type: "button", class: "secondary" }, `Switch to ${other}`);
  mode.onclick = async () => {
    const res = await post("/api/mode", { mode: other });
    if (res.status === 409) notice = "A cycle is already running.";
    else if (!res.ok) notice = "Could not change mode.";
    else if (other === "apply") {
      const out = await res.json() as { applied?: number; held?: number };
      notice = `Apply mode: wrote ${out.applied ?? 0}, held ${out.held ?? 0}.`;
    } else notice = "Dry run. Later cycles write nothing.";
    await refresh();
  };
  const errors = (s.errors ?? []).map((e) => h("li", {}, `${fileName(e.fileId)}: ${e.message}`));
  $("status").replaceChildren(
    h("div", { class: "row spread" }, h("h2", {}, "Status"), h("div", { class: "row" }, scan, mode)),
    h("div", { class: "stats" },
      stat(s.watching ? "Watching" : "Stopped", "watcher"),
      stat(s.mode === "apply" ? "Apply" : "Dry run", s.mode === "apply" ? "writes high-certainty fixes" : "writes nothing"),
      stat(last, "last cycle"),
      stat(String(s.aiCallsThisMonth), "AI calls since start")),
    h("p", { id: "status-msg", class: "muted" }, notice),
    errors.length ? h("div", {}, h("b", {}, "Files that failed"), h("ul", { class: "plain" }, ...errors)) : "",
  );
}

function quote(text: string, fileId: string): HTMLElement {
  return h("blockquote", {}, `“${text}”`, " ", fileLink(fileId));
}

function card(f: Finding): HTMLElement {
  const c = f.commitment;
  const t = f.task;
  const title = c?.text ?? t?.message ?? "";
  const meta = [c?.owner && `owner ${c.owner}`, c?.due && `due ${c.due}`, f.score !== undefined && `score ${f.score}`]
    .filter(Boolean).join(" · ");
  const checks = h("ul", { class: "checks" }, ...Object.entries(f.checks).map(([k, ok]) =>
    h("li", { class: ok ? "pass" : "fail" }, `${ok ? "✓" : "✗"} ${CHECK_LABELS[k] ?? k}`)));
  const body: Child[] = [
    h("div", { class: "row spread" }, h("b", {}, title), h("span", { class: `badge ${f.certainty}` }, `${f.certainty} certainty`)),
    meta && h("div", { class: "muted" }, meta),
  ];
  if (c) body.push(quote(c.evidence, c.fileId));
  if (c?.statusEvidence) body.push(h("div", { class: "muted" }, `Cancelled or completed by:`), quote(c.statusEvidence.evidence, c.statusEvidence.fileId));
  if (c?.flags?.length) body.push(h("div", { class: "muted" }, `Flags: ${c.flags.join(", ")}`));
  if (t) {
    body.push(h("div", {}, "Task: ", h("b", {}, t.message), ` · due ${t.due ?? "none"} · on `, fileLink(t.fileId),
      ` · ${t.assigneeIds.length ? `assigned` : "unassigned"}`));
  }
  body.push(checks);
  if (f.proposal) {
    const p = f.proposal;
    const preview = p.kind === "task"
      ? `New task on "${fileName(p.fileId)}":\n${p.message}\nAssigned to: ${p.assigneeName ?? "nobody"}\nDue: ${p.due ?? "none"}`
      : `Comment on "${fileName(p.fileId)}":\n${p.text}`;
    body.push(h("div", { class: "muted" }, "This is exactly what will be sent:"), h("pre", { class: "proposal" }, preview));
  }
  const actions = h("div", { class: "row" });
  const send = async (action: string) => {
    const res = await post(`/api/findings/${encodeURIComponent(f.id)}/actions`, { action });
    const out = await res.json() as { change?: string; outcome?: string; error?: string; status?: string };
    notice = out.error ?? `${out.status}: ${out.change ?? ""} ${out.outcome && out.outcome !== "ok" ? `(${out.outcome})` : ""}`;
    await refresh();
  };
  if (f.proposal?.kind === "task") actions.append(button("Create task", () => send("create_task")));
  if (f.proposal?.kind === "comment") actions.append(button("Post comment", () => send("comment")));
  if (f.bucket !== "matched") actions.append(button("Dismiss", () => send("dismiss"), "secondary"));
  body.push(actions);
  return h("article", { class: `card ${f.certainty}` }, ...body);
}

function button(label: string, onClick: () => void, cls = ""): HTMLElement {
  const b = h("button", { type: "button", class: cls }, label);
  b.onclick = onClick;
  return b;
}

function renderFindings(s: AppState): void {
  const groups = BUCKETS.map(({ key, title, blurb }) => {
    // Low-certainty cards on top: they are the ones waiting for a person.
    const items = s.findings.filter((f) => f.bucket === key)
      .sort((a, b) => (a.certainty === b.certainty ? 0 : a.certainty === "low" ? -1 : 1));
    if (!items.length) return undefined;
    return h("div", { "data-bucket": key }, h("h3", {}, `${title} (${items.length})`), h("p", { class: "muted" }, blurb), ...items.map(card));
  });
  const empty = !s.findings.length && h("p", { class: "panel muted" }, s.lastCycle ? "No findings." : "No scan yet. Press Scan now.");
  $("findings").replaceChildren(h("h2", {}, "Findings"), ...groups.filter((g): g is HTMLElement => !!g), empty || "");
}

function renderSetAside(s: AppState): void {
  const item = (i: ExtractedItem) => h("li", {}, h("b", {}, `${i.newStatus ?? i.kind.replace("_", " ")}: `), i.action,
    i.fileId ? h("span", { class: "muted" }, ` (${fileName(i.fileId)})`) : "");
  const unverified = s.unverified ?? [];
  $("set-aside").replaceChildren(
    h("h2", {}, "Recognized and set aside"),
    h("p", { class: "muted" }, "Decisions, ideas, open questions and cancelled commitments: read, but not findings."),
    h("ul", { class: "plain" }, ...s.setAside.map(item)),
    unverified.length ? h("div", {}, h("b", {}, "Dropped: evidence not found in the file"), h("ul", { class: "plain" }, ...unverified.map(item))) : "",
  );
}

async function loadAudit(): Promise<void> {
  const date = ($("audit-date") as HTMLInputElement).value;
  const res = await api(`/api/audit?date=${encodeURIComponent(date)}`);
  $("audit-text").textContent = res.ok ? (await res.text()) || "No entries for this day." : "Could not load the audit log.";
}

async function score(): Promise<void> {
  const res = await post("/api/score");
  const out = $("eval-result");
  if (!res.ok) { out.textContent = "Scoring is not available."; return; }
  const r = await res.json() as { recall: { found: number; total: number; missing: string[]; c01Count: number };
    falsePositives: { count: number; items: string[] }; tasks: { id: string; expected: string; actual?: string; ok: boolean }[];
    untracked: { expected: string[]; missing: string[] } };
  const right = r.tasks.filter((t) => t.ok).length;
  const c01 = r.recall.c01Count;
  out.replaceChildren(
    h("div", { class: "stats" },
      stat(`${r.recall.found} of ${r.recall.total}`, "commitment recall"),
      stat(String(r.falsePositives.count), "false positives"),
      stat(`${right} of ${r.tasks.length}`, "tasks in the expected bucket"),
      stat(`${r.untracked.expected.length - r.untracked.missing.length} of ${r.untracked.expected.length}`, "untracked found"),
      stat(String(c01), c01 === 1 ? "C01 counted once" : "C01 copies (want 1)")),
    h("table", {}, h("tr", {}, h("th", {}, "Task"), h("th", {}, "Expected"), h("th", {}, "Got")),
      ...r.tasks.map((t) => h("tr", {}, h("td", {}, t.id), h("td", {}, t.expected), h("td", {}, `${t.ok ? "✓ " : "✗ "}${t.actual ?? "none"}`)))),
  );
}

function pacificToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

$("passcode-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await post("/api/session", { passcode: ($("passcode-input") as HTMLInputElement).value });
  $("passcode-error").textContent = res.ok ? ""
    : res.status === 429 ? "Too many wrong passcodes. Try again in a few minutes." : "That passcode did not work.";
  if (res.ok) { await refresh(); await loadAudit(); }
});
($("audit-date") as HTMLInputElement).value = pacificToday();
$("audit-date").addEventListener("change", loadAudit);
$("score-button").addEventListener("click", score);

refresh().then(loadAudit);
