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
  if ("pairing" in checks) phrases.push(checks.pairing ? `pairing ${f.score}` : "pairing not clear");
  phrases.push(checks.bucket ? `bucket ${f.bucket}` : `bucket ${f.bucket} needs a person`);
  return `${f.certainty} (${phrases.join("; ")})`;
}

function matchLine(e: AuditEntry): string {
  const f = e.finding;
  if (f.bucket === "untracked") return `no task scored above ${MATCH_DEFAULTS.possibleThreshold}`;
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
