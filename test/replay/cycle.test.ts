// Replays a whole cycle over the 7 seed files with recorded AI answers and fails below the
// spec's success criteria. Never calls Box or Box AI.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { commitWrites, runCycle } from "../../src/engine/cycle.js";
import { PROMPT_VERSION } from "../../src/engine/extract.js";
import { FakeBox, fakeEngine } from "../../src/fake-box.js";
import { type AnswerKey, score } from "../../src/score.js";

const key = JSON.parse(readFileSync("seed/answer_key.json", "utf8")) as AnswerKey & { files: Record<string, string> };
// The fake Box uses the real file IDs recorded in each fixture.
const fileId = (k: string): string => JSON.parse(readFileSync(`test/fixtures/v1/${k}.json`, "utf8")).file.id;

const writesOf = (box: FakeBox, op: string) => box.writes.filter((w) => w.op === op);
const auditText = (box: FakeBox) => [...box.audit.values()].join("");
const entries = (box: FakeBox) => auditText(box).split("\n\n").filter(Boolean);

test("fixtures exist for every seed file under the current prompt version", () => {
  for (const k of Object.keys(key.files)) {
    const path = `test/fixtures/${PROMPT_VERSION}/${k}.json`;
    assert.ok(existsSync(path), `missing fixture ${path}; the hand-written guard fixtures belong in this folder`);
    const fx = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(fx.promptVersion, PROMPT_VERSION);
    assert.equal(fx.file.name, key.files[k]);
  }
});

test("dry-run full scan meets the success criteria and writes nothing", async () => {
  const { engine, box } = await fakeEngine({ mode: "dry-run" });
  const started = Date.now();
  const summary = await runCycle(engine, "all", { trigger: "full_scan", full: true });
  assert.ok(Date.now() - started < 90_000, "full scan of 7 files under 90 seconds");
  assert.equal(summary.filesChecked, 7);

  const report = score(engine.state.toAppState(), key);
  assert.equal(report.recall.found, 9, `recall 9 of 9; missing ${report.recall.missing}`);
  assert.equal(report.recall.c01Count, 1, "C01 and its sync01 restatement count once");
  assert.ok(report.falsePositives.count <= 1, `at most 1 false positive: ${report.falsePositives.items}`);
  for (const t of report.tasks) assert.ok(t.ok, `${t.id}: expected ${t.expected}, got ${t.actual}`);
  assert.deepEqual(report.untracked.missing, [], "C03, C07 and C09 untracked");
  for (const id of ["C03", "C07", "C09"]) assert.ok(report.untracked.expected.includes(id));

  assert.deepEqual(box.writes, [], "dry run makes zero writes");
});

test("the guards fire: invalid JSON retried, paraphrase dropped, mislabel held back", async () => {
  const { engine } = await fakeEngine();
  const summary = await runCycle(engine, "all", { trigger: "full_scan", full: true });
  assert.equal(summary.aiCalls, 7 * 2 + 1, "two calls per file plus one retry for the invalid first reply");
  const state = engine.state.toAppState();
  assert.deepEqual(state.unverified?.map((u) => u.action), ["Investigate the tuna dispenser flow"]);
  const mislabel = state.findings.find((f) => f.commitment?.text === "Install a laser pointer in every conference room");
  assert.equal(mislabel?.bucket, "untracked");
  assert.equal(mislabel?.certainty, "low", "an idea labeled as a commitment, with no owner, is never written automatically");
  const c09 = state.findings.find((f) => f.commitment?.text === "Send the signed PO to Laser Dynamics");
  assert.equal(c09?.commitment?.owner, "Pixel", "'I' in the email resolves to its sender");
  assert.equal(c09?.commitment?.due, "2026-10-20");
});

test("apply mode makes exactly the high-certainty writes, audits each, and writes metadata last", async () => {
  const { engine, box } = await fakeEngine({ mode: "apply" });
  await runCycle(engine, "all", { trigger: "full_scan", full: true });
  const users = engine.people.users;

  // Untracked -> a task on the source file, assigned to the owner, with the due date.
  const tasks = writesOf(box, "createTask").map((w: any) => ({ fileId: w.fileId, message: w.message, due: w.due }));
  assert.deepEqual(tasks.sort((a, b) => a.message.localeCompare(b.message)), [
    { fileId: fileId("kickoff"), message: "Draft the Human Gratitude Survey (10 questions max)", due: "2026-10-09" },
    { fileId: fileId("sync01"), message: "Replace the break room tuna dispenser filter", due: "2026-10-02" },
    { fileId: fileId("email"), message: "Send the signed PO to Laser Dynamics", due: "2026-10-20" },
  ].sort((a, b) => a.message.localeCompare(b.message)));
  const assigns = writesOf(box, "assign").map((w: any) => w.assigneeId).sort();
  assert.deepEqual(assigns, [users.zaq, users.vanessa, users.zaq].sort(), "survey and PO to zaq, tuna filter to vanessa");

  // Superseded, owner and date conflicts -> a comment on the task's file, carrying the fingerprint.
  const comments = writesOf(box, "comment") as { fileId: string; text: string }[];
  assert.equal(comments.length, 3);
  const commentFor = (bucket: string) => comments.find((c) => c.text.includes(`fingerprint: ${bucket}|`));
  assert.equal(commentFor("superseded")?.fileId, fileId("sync01"));
  assert.match(commentFor("superseded")!.text, /The Human Acclimation Lab box order is cancelled\./);
  assert.equal(commentFor("owner_conflict")?.fileId, fileId("kickoff"));
  assert.equal(commentFor("date_conflict")?.fileId, fileId("sync01"));
  assert.match(commentFor("date_conflict")!.text, /due 2026-10-31, but .* says 2026-10-15/);

  // Nothing else is written: no edits, no deletes, nothing for matched, misfiled or orphan findings.
  const ops = new Set(box.writes.map((w) => w.op));
  assert.deepEqual([...ops].sort(), ["appendAudit", "assign", "comment", "createTask", "setMeta"]);

  // One APPLIED entry per write; low-certainty findings are logged as HELD.
  const applied = entries(box).filter((e) => e.split("\n")[0].endsWith("APPLIED"));
  const held = entries(box).filter((e) => e.split("\n")[0].endsWith("HELD"));
  assert.equal(applied.length, 6);
  assert.equal(applied.filter((e) => /^change: +task new-\d+ created on/m.test(e)).length, 3);
  assert.equal(applied.filter((e) => /^change: +comment \S+ posted on/m.test(e)).length, 3);
  assert.ok(applied.every((e) => /^outcome: +ok$/m.test(e)));
  assert.deepEqual(held.map((e) => e.match(/^finding: +(\w+):/m)![1]).sort(), ["misfiled", "orphan", "untracked"]);

  // Metadata: one write per file, after every other write, with the scan marker.
  const lastOther = box.writes.map((w) => w.op).lastIndexOf("appendAudit");
  const metaIdx = box.writes.flatMap((w, i) => (w.op === "setMeta" ? [i] : []));
  assert.equal(metaIdx.length, 7);
  assert.ok(metaIdx.every((i) => i > lastOther), "metadata is written after tasks, comments and audit entries");
  for (const i of metaIdx) {
    const w = box.writes[i] as { fileId: string; values: Record<string, string> };
    assert.equal(Object.keys(w.values).at(-1), "hcScannedVersion", "the marker is the last field written");
    assert.equal(w.values.hcScannedVersion, `${box.fixtures.get(w.fileId)!.file.version}@${PROMPT_VERSION}`);
    for (const f of ["hcDocType", "hcDocDate", "hcLastChecked", "hcOpenFindings", "hcLastChange"]) assert.ok(f in w.values, f);
  }
});

test("a second apply-mode run creates no duplicates", async () => {
  const { engine, box } = await fakeEngine({ mode: "apply" });
  await runCycle(engine, "all", { trigger: "full_scan", full: true });
  const before = box.writes.length;
  const auditBefore = auditText(box);
  const second = await runCycle(engine, "all", { trigger: "full_scan", full: true });
  const newWrites = box.writes.slice(before).filter((w) => w.op !== "setMeta");
  assert.deepEqual(newWrites, [], "no new tasks, assignments, comments or audit entries");
  assert.equal(second.applied, 0);
  assert.equal(auditText(box), auditBefore);
  // The tasks the first run created now match their commitments.
  const state = engine.state.toAppState();
  for (const text of ["Draft the Human Gratitude Survey (10 questions max)", "Replace the break room tuna dispenser filter",
    "Send the signed PO to Laser Dynamics"]) {
    assert.equal(state.findings.find((f) => f.commitment?.text === text)?.bucket, "matched", text);
  }
});

test("a sweep with no changes makes 0 AI calls, in apply mode and in dry run", async () => {
  for (const mode of ["apply", "dry-run"] as const) {
    const { engine, box } = await fakeEngine({ mode });
    await runCycle(engine, "all", { trigger: "full_scan", full: true });
    const calls = box.aiCalls;
    const started = Date.now();
    const sweep = await runCycle(engine, "all", { trigger: "sweep" });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(box.aiCalls - calls, 0, `${mode}: no AI calls`);
    assert.equal(sweep.filesScanned, 0);
    assert.equal(sweep.filesChecked, 7);
  }
});

test("after a restart, scan markers in metadata keep the sweep at 0 AI calls", async () => {
  const first = await fakeEngine({ mode: "apply" });
  await runCycle(first.engine, "all", { trigger: "full_scan", full: true });
  const { engine } = await fakeEngine({ mode: "apply" });
  engine.gateway = first.box; // same Box, fresh process memory
  engine.tracker = first.box;
  const calls = first.box.aiCalls;
  const sweep = await runCycle(engine, "all", { trigger: "sweep" });
  assert.equal(first.box.aiCalls - calls, 0);
  assert.equal(sweep.filesScanned, 0);
});

test("a new version of one file is the only file rescanned", async () => {
  const { engine, box } = await fakeEngine({ mode: "dry-run" });
  await runCycle(engine, "all", { trigger: "full_scan", full: true });
  const id = fileId("handbook");
  box.uploadVersion(id, `${box.texts.get(id)}\n`);
  const calls = box.aiCalls;
  const sweep = await runCycle(engine, "all", { trigger: "sweep" });
  assert.equal(sweep.filesScanned, 1);
  assert.equal(box.aiCalls - calls, 2);
});

test("an edit that removes a commitment turns its task into a low-certainty orphan", async () => {
  const { engine, box } = await fakeEngine({ mode: "dry-run" });
  await runCycle(engine, "all", { trigger: "full_scan", full: true });
  const id = fileId("sync01");
  const items = JSON.parse(box.fixtures.get(id)!.extract[0].raw)
    .filter((i: { action: string }) => i.action !== "Complete Augmentation Module 1");
  box.uploadVersion(id, box.texts.get(id)!.replace("- Dale will complete Augmentation Module 1 by October 10.\n", ""),
    [{ raw: JSON.stringify(items), model: "edited" }]);
  await runCycle(engine, [id], { trigger: "webhook" });
  const t5 = engine.state.findings.find((f) => f.task?.message === "Complete Augmentation Module 1 (Advanced Can Opening)");
  assert.equal(t5?.bucket, "orphan");
  assert.equal(t5?.certainty, "low");
});

test("switching to apply writes the findings already on the page", async () => {
  const { engine, box } = await fakeEngine({ mode: "dry-run" });
  await runCycle(engine, "all", { trigger: "full_scan", full: true });
  assert.equal(box.writes.length, 0);
  engine.state.mode = "apply";
  const summary = await commitWrites(engine, "click");
  assert.equal(writesOf(box, "createTask").length, 3);
  assert.equal(writesOf(box, "comment").length, 3);
  assert.equal(summary.applied, 6);
  assert.equal(summary.held, 3);
  for (const text of ["Draft the Human Gratitude Survey (10 questions max)", "Replace the break room tuna dispenser filter",
    "Send the signed PO to Laser Dynamics"]) {
    assert.equal(engine.state.findings.find((f) => f.commitment?.text === text)?.bucket, "matched", text);
  }
});

test("after a restart, a one-file webhook still supersedes T4 and misfiles T7", async () => {
  const first = await fakeEngine({ mode: "apply" });
  await runCycle(first.engine, "all", { trigger: "full_scan", full: true });
  const second = await fakeEngine({ mode: "dry-run" });
  second.engine.gateway = first.box;
  second.engine.tracker = first.box;
  const calls = first.box.aiCalls;
  const sweep = await runCycle(second.engine, [fileId("sync02")], { trigger: "webhook" });
  assert.equal(first.box.aiCalls - calls, 0, "restored from hcExtract, no AI calls");
  assert.equal(sweep.filesScanned, 0);
  const findings = second.engine.state.findings;
  assert.equal(findings.find((f) => f.task?.message.startsWith("Order 50 cardboard boxes"))?.bucket, "superseded");
  assert.equal(findings.find((f) => f.task?.message.startsWith("Submit revised R&D treat budget"))?.bucket, "misfiled");
  for (const text of ["Draft the Human Gratitude Survey (10 questions max)", "Replace the break room tuna dispenser filter",
    "Send the signed PO to Laser Dynamics"]) {
    assert.equal(findings.find((f) => f.commitment?.text === text)?.bucket, "matched", text);
  }
});
