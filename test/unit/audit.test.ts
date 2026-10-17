import assert from "node:assert/strict";
import { test } from "node:test";
import { auditDate, AuditLog, formatEntry } from "../../src/audit.js";
import type { BoxGateway } from "../../src/box.js";
import type { AuditEntry, Finding } from "../../src/types.js";

// Copied from the spec's "Audit log" section.
const SAMPLE = `2026-10-17 10:42:07 PT  webhook  APPLIED
change:      task 1844021 created on "2026-09-15 Weekly Sync 01.md", assigned to Dale Henderson
finding:     untracked: Replace the break room tuna dispenser filter, due 2026-10-02
evidence:    "Dale will replace the break room tuna dispenser filter by October 2." (file 2532048604610, version 1)
certainty:   high (evidence exact; owner resolved; date absolute; bucket untracked)
model:       prompt v1; model as reported by Box AI
match:       no task scored above 60
outcome:     ok
fingerprint: untracked|2532048604610|tuna-filter`;

const finding: Finding = {
  id: "f1", bucket: "untracked", certainty: "high",
  checks: { evidence: true, owner: true, dueDate: true, bucket: true },
  commitment: { id: "c", fileId: "2532048604610", fileVersion: "1", text: "Replace the break room tuna dispenser filter",
    evidence: "Dale will replace the break room tuna dispenser filter by October 2.", owner: "Dale Henderson",
    ownerUserId: "u", due: "2026-10-02", dueAbsolute: true, status: "open" },
  score: 43, fingerprint: "untracked|2532048604610|tuna-filter",
};

const entry: AuditEntry = {
  time: "2026-10-17T17:42:07Z", trigger: "webhook", applied: true,
  change: 'task 1844021 created on "2026-09-15 Weekly Sync 01.md", assigned to Dale Henderson',
  finding,
  evidence: { quote: "Dale will replace the break room tuna dispenser filter by October 2.", fileId: "2532048604610", fileVersion: "1" },
  model: "prompt v1; model as reported by Box AI", outcome: "ok",
};

test("formatEntry matches the spec's sample byte for byte", () => {
  assert.equal(formatEntry(entry), SAMPLE);
  assert.ok(Buffer.from(formatEntry(entry)).equals(Buffer.from(SAMPLE)));
});

test("held entries, paired findings and orphans", () => {
  const held = formatEntry({ ...entry, applied: false, change: "held", trigger: "full_scan" });
  assert.match(held.split("\n")[0], /^2026-10-17 10:42:07 PT {2}full-scan {2}HELD$/);
  const paired = formatEntry({ ...entry, matchScore: 100, finding: { ...finding, bucket: "date_conflict", score: 100,
    checks: { ...finding.checks, pairing: true }, task: { id: "T3", fileId: "f", message: "m", assigneeIds: [], completed: false } } });
  assert.match(paired, /^match: {7}task T3 scored 100$/m);
  assert.match(paired, /^certainty: {3}high \(evidence exact; owner resolved; date absolute; pairing 100; bucket date_conflict\)$/m);
  const orphan = formatEntry({ ...entry, evidence: { quote: "", fileId: "f9", fileVersion: "" },
    finding: { ...finding, bucket: "orphan", certainty: "low", checks: { bucket: false }, commitment: undefined,
      task: { id: "T6", fileId: "f9", message: "Repaint the Hall of Ancestral Scratches", assigneeIds: [], due: "2026-11-01", completed: false } } });
  assert.match(orphan, /^finding: {5}orphan: Repaint the Hall of Ancestral Scratches, due 2026-11-01$/m);
  assert.match(orphan, /^evidence: {4}none \(task T6 on file f9\)$/m);
  assert.match(orphan, /^certainty: {3}low \(bucket orphan needs a person\)$/m);
});

test("audit files are per Pacific day", () => {
  assert.equal(auditDate("2026-10-18T06:59:59Z"), "2026-10-17");
  assert.equal(auditDate("2026-10-18T07:00:00Z"), "2026-10-18");
});

test("appends are serialized and separated by blank lines", async () => {
  const days = new Map<string, string>();
  let active = 0;
  const gateway = {
    async appendAudit(date: string, text: string) {
      assert.equal(active++, 0, "appends overlapped");
      await new Promise((r) => setTimeout(r, 5));
      days.set(date, (days.get(date) ?? "") + text);
      active--;
    },
    async readAudit(date: string) { return days.get(date) ?? ""; },
  } as unknown as BoxGateway;
  const log = new AuditLog(gateway);
  await Promise.all([log.append(entry), log.append(entry), log.append(entry)]);
  const text = await log.read("2026-10-17");
  assert.equal(text, `${SAMPLE}\n\n${SAMPLE}\n\n${SAMPLE}\n\n`);
  assert.equal(text.split("\n\n").filter(Boolean).length, 3);
});
