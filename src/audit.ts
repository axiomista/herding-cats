// Formats and appends audit entries: blocks of `field: value` lines separated by blank lines,
// one plain-text file per day in the audit folder.
import type { BoxGateway } from "./box.js";
import { MATCH_DEFAULTS } from "./config.js";
import type { AuditEntry, Finding, Trigger } from "./types.js";

const TZ = "America/Los_Angeles";

function pacificParts(iso: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

export function auditDate(iso: string): string {
  const p = pacificParts(iso);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatTime(iso: string): string {
  const p = pacificParts(iso);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} PT`;
}

const TRIGGER_LABELS: Record<Trigger, string> = { webhook: "webhook", sweep: "sweep", full_scan: "full-scan", click: "click" };

function certaintyLine(f: Finding): string {
  const phrases: string[] = [];
  const { checks } = f;
  if ("evidence" in checks) phrases.push(checks.evidence ? "evidence exact" : "evidence not found");
  if ("owner" in checks) phrases.push(checks.owner ? "owner resolved" : "owner unresolved");
  if ("dueDate" in checks) {
    phrases.push(!checks.dueDate ? "date relative or unresolved" : f.commitment?.due ? "date absolute" : "no date");
  }
  if ("status" in checks) {
    phrases.push(`status match ${f.commitment?.statusEvidence?.score}${checks.status ? "" : " needs a person"}`);
  }
  if ("pairing" in checks) phrases.push(checks.pairing ? `pairing ${f.score}` : "pairing not clear");
  phrases.push(checks.bucket ? `bucket ${f.bucket}` : `bucket ${f.bucket} needs a person`);
  return `${f.certainty} (${phrases.join("; ")})`;
}

function matchLine(e: AuditEntry): string {
  const f = e.finding;
  if (f.bucket === "untracked") {
    return (f.score ?? 0) >= MATCH_DEFAULTS.possibleThreshold
      ? `best task scored ${f.score} but is paired with another commitment`
      : `no task scored above ${MATCH_DEFAULTS.possibleThreshold}`;
  }
  if (f.bucket === "orphan") return `no commitment scored above ${MATCH_DEFAULTS.possibleThreshold}`;
  return `task ${f.task?.id} scored ${e.matchScore ?? f.score}`;
}

export function formatEntry(e: AuditEntry): string {
  const f = e.finding;
  const action = f.commitment?.text ?? f.task?.message ?? "";
  const due = f.commitment?.due ?? f.task?.due;
  const evidence = e.evidence.quote
    ? `"${e.evidence.quote}" (file ${e.evidence.fileId}, version ${e.evidence.fileVersion})`
    : `none (task ${f.task?.id} on file ${e.evidence.fileId})`;
  const fields: [string, string][] = [
    ["change", e.change],
    ["finding", `${f.bucket}: ${action}${due ? `, due ${due}` : ""}`],
    ["evidence", evidence],
    ["certainty", certaintyLine(f)],
    ["model", e.model],
    ["match", matchLine(e)],
    ["outcome", e.outcome],
    ["fingerprint", f.fingerprint],
  ];
  const header = `${formatTime(e.time)}  ${TRIGGER_LABELS[e.trigger]}  ${e.applied ? "APPLIED" : "HELD"}`;
  return [header, ...fields.map(([k, v]) => `${`${k}:`.padEnd(13)}${v}`)].join("\n");
}

// (new) One audit entry read back from a day file, for the page's audit view.
export interface ParsedAuditEntry {
  time: string; trigger: string; status: "applied" | "held";
  fields: Record<string, string>;   // change, finding, evidence, certainty, model, match, outcome, fingerprint
  raw: string;
}

const HEADER = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} PT) {2}(\S+) {2}(APPLIED|HELD)$/;
const FIELD = /^(change|finding|evidence|certainty|model|match|outcome|fingerprint): +(.*)$/;

// Reads formatEntry's output back into entries. A line that is not a field continues the field
// before it, since a quote can hold a line break. A block with no header (a quote with a blank
// line in it) continues the entry before it.
export function parseEntries(text: string): ParsedAuditEntry[] {
  const out: ParsedAuditEntry[] = [];
  let lastField: string | undefined;
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.replace(/\s+$/, "").split("\n");
    if (!lines[0]) continue;
    const head = HEADER.exec(lines[0]);
    const prev = out[out.length - 1];
    if (!head) {
      if (prev && lastField) {
        prev.fields[lastField] += `\n\n${lines.join("\n")}`;
        prev.raw += `\n\n${lines.join("\n")}`;
      }
      continue;
    }
    const entry: ParsedAuditEntry = { time: head[1], trigger: head[2], status: head[3] === "APPLIED" ? "applied" : "held",
      fields: {}, raw: lines.join("\n") };
    lastField = undefined;
    for (const line of lines.slice(1)) {
      const f = FIELD.exec(line);
      if (f) { lastField = f[1]; entry.fields[lastField] = f[2]; } else if (lastField) entry.fields[lastField] += `\n${line}`;
    }
    out.push(entry);
  }
  return out;
}

// Appends are serialized so parallel files do not race on the day file's version.
export class AuditLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(private gateway: BoxGateway) {}

  append(entry: AuditEntry): Promise<void> {
    const next = this.queue.then(() => this.gateway.appendAudit(auditDate(entry.time), `${formatEntry(entry)}\n\n`));
    this.queue = next.catch(() => undefined);
    return next;
  }

  read(date: string): Promise<string> {
    return this.gateway.readAudit(date);
  }
}
