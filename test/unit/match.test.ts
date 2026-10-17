import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MATCH_DEFAULTS } from "../../src/config.js";
import { applyStatusChanges, bucketFor, commentCarriesFingerprint, fingerprint, matchFolder, slug } from "../../src/engine/match.js";
import { withCertainty } from "../../src/engine/certainty.js";
import { loadPeople } from "../../src/engine/normalize.js";
import type { Commitment, TrackerTask } from "../../src/types.js";

// Commitments and tasks taken straight from the answer key; file IDs are the key's file keys.
const key = JSON.parse(readFileSync("seed/answer_key.json", "utf8"));
const people = loadPeople();
const userFor = (owner: string) => people.users[key.owners[owner]];

function seedCommitments(): Commitment[] {
  return key.commitments.map((a: any) => ({
    id: a.id, fileId: a.source, fileVersion: "1", text: a.action, evidence: a.evidence,
    owner: a.owner, ownerUserId: userFor(a.owner), due: a.due, dueAbsolute: true,
    status: a.status === "cancelled" ? "cancelled" : "open",
    mentions: (a.also_mentioned_in ?? []).map((m: any) => ({ fileId: m.source, evidence: m.evidence })),
  }));
}

const seedTasks = (): TrackerTask[] => key.tasks.map((t: any) => ({
  id: t.id, fileId: t.file, message: t.message, assigneeIds: [people.users[t.assignee]], due: t.due, completed: false,
}));

const allFiles = new Set(Object.keys(key.files));

test("every seed task lands in the spec's bucket", () => {
  const { findings } = matchFolder(seedCommitments(), seedTasks(), allFiles, MATCH_DEFAULTS);
  for (const t of key.tasks) {
    const f = findings.find((x) => x.task?.id === t.id);
    assert.equal(f?.bucket, t.expected.split(" ")[0], `${t.id}: ${t.message}`);
  }
});

test("C03, C07 and C09 are untracked; nothing else is", () => {
  const { findings } = matchFolder(seedCommitments(), seedTasks(), allFiles, MATCH_DEFAULTS);
  assert.deepEqual(findings.filter((f) => f.bucket === "untracked").map((f) => f.commitment!.id).sort(),
    key.scoring.untracked_expected);
});

test("pairing is one to one: a task is never claimed twice", () => {
  const cs = seedCommitments();
  cs.push({ ...cs[0], id: "C01-copy", ownerUserId: people.users.vanessa });
  const { findings } = matchFolder(cs, seedTasks(), allFiles, MATCH_DEFAULTS);
  const t1 = findings.filter((f) => f.task?.id === "T1");
  assert.equal(t1.length, 1);
  assert.equal(findings.find((f) => f.commitment?.id === "C01-copy")?.bucket, "untracked");
});

test("a cancelled commitment with no task is set aside, not a finding", () => {
  const c5 = seedCommitments().find((c) => c.id === "C05")!;
  const { findings, setAside } = matchFolder([c5], [], allFiles, MATCH_DEFAULTS);
  assert.equal(findings.length, 0);
  assert.deepEqual(setAside.map((c) => c.id), ["C05"]);
});

test("orphans are reported only for tasks on scanned files", () => {
  const t6 = seedTasks().filter((t) => t.id === "T6");
  assert.equal(matchFolder([], t6, new Set(["sync02"]), MATCH_DEFAULTS).findings[0]?.bucket, "orphan");
  assert.equal(matchFolder([], t6, new Set(["kickoff"]), MATCH_DEFAULTS).findings.length, 0);
});

test("a completed task is matched, never a conflict or orphan", () => {
  const [c2] = seedCommitments().filter((c) => c.id === "C02");
  const t2 = { ...seedTasks().find((t) => t.id === "T2")!, completed: true };
  assert.equal(bucketFor(c2, t2, MATCH_DEFAULTS), "matched");
  const t6 = { ...seedTasks().find((t) => t.id === "T6")!, completed: true };
  assert.equal(matchFolder([], [t6], allFiles, MATCH_DEFAULTS).findings.length, 0);
});

const base: Commitment = { id: "c", fileId: "f", fileVersion: "1", text: "Do the thing", evidence: "x",
  ownerUserId: "u1", due: "2026-10-10", status: "open" };
const task: TrackerTask = { id: "t", fileId: "f", message: "Do the thing", assigneeIds: ["u1"], due: "2026-10-10", completed: false };

test("bucket order: superseded beats every conflict", () => {
  assert.equal(bucketFor({ ...base, status: "cancelled" }, { ...task, assigneeIds: ["u2"], due: "2026-12-01", fileId: "g" }, MATCH_DEFAULTS), "superseded");
  assert.equal(bucketFor({ ...base, status: "done" }, task, MATCH_DEFAULTS), "superseded");
});

test("an unassigned task is never an owner conflict", () => {
  assert.equal(bucketFor(base, { ...task, assigneeIds: [] }, MATCH_DEFAULTS), "matched");
  assert.equal(bucketFor(base, { ...task, assigneeIds: ["u2"] }, MATCH_DEFAULTS), "owner_conflict");
});

test("due dates within 1 day are not a conflict", () => {
  assert.equal(bucketFor(base, { ...task, due: "2026-10-11" }, MATCH_DEFAULTS), "matched");
  assert.equal(bucketFor(base, { ...task, due: "2026-10-12" }, MATCH_DEFAULTS), "date_conflict");
  assert.equal(bucketFor(base, { ...task, due: undefined }, MATCH_DEFAULTS), "matched");
});

test("a task on a file that only mentions the commitment is not misfiled", () => {
  assert.equal(bucketFor(base, { ...task, fileId: "g" }, MATCH_DEFAULTS), "misfiled");
  assert.equal(bucketFor({ ...base, mentions: [{ fileId: "g", evidence: "y" }] }, { ...task, fileId: "g" }, MATCH_DEFAULTS), "matched");
});

test("scores of 60 to 84 pair as a possible match; below 60 do not pair", () => {
  const c = { ...base, text: "Install 12 sunbeam lamps on Floor 3 and Floor 4 for the executive nap team" };
  const t = { ...task, message: "Install 12 sunbeam lamps on Floor 3" };
  const possible = matchFolder([{ ...c, text: "Install sunbeam lamps for the executives" }], [t], new Set(), MATCH_DEFAULTS).findings[0];
  assert.ok(possible.score! >= 60 && possible.score! < 85, `score ${possible.score}`);
  assert.equal(possible.bucket, "matched");
  const none = matchFolder([{ ...c, text: "Replace the break room tuna dispenser filter" }], [t], new Set(), MATCH_DEFAULTS).findings[0];
  assert.equal(none.bucket, "untracked");
});

test("a cancellation in one document updates the commitment from another", () => {
  const cs = applyStatusChanges(seedCommitments(), [{ kind: "status_change", action: "Cancel the box order",
    refersTo: "the Human Acclimation Lab box order", newStatus: "cancelled", fileId: "sync02",
    evidence: "The Human Acclimation Lab box order is cancelled." }], MATCH_DEFAULTS);
  const c5 = cs.find((c) => c.id === "C05")!;
  assert.equal(c5.status, "cancelled");
  const { score, ...ev } = c5.statusEvidence!;
  assert.deepEqual(ev, { fileId: "sync02", evidence: "The Human Acclimation Lab box order is cancelled." });
  assert.ok(score! >= MATCH_DEFAULTS.matchThreshold, `score ${score}`);
});

test("a cancellation with no commitment in memory still finds the open task", () => {
  const cs = applyStatusChanges([], [{ kind: "status_change", action: "Cancel the box order",
    refersTo: "Order 50 cardboard boxes for the Human Acclimation Lab", newStatus: "cancelled", fileId: "sync02",
    evidence: "The Human Acclimation Lab box order is cancelled." }], MATCH_DEFAULTS);
  const { findings } = matchFolder(cs, seedTasks(), new Set(), MATCH_DEFAULTS);
  assert.equal(findings.find((f) => f.task?.id === "T4")?.bucket, "superseded");
});

// Live run, 2026-10-17: the model labeled the cancellation a decision, with no refers_to, and
// gave C05 its short wording. The cancellation scores 45 against that text but 83 against C05's
// evidence, and no other commitment comes within the rival gap.
test("a cancellation that matches only the commitment's evidence still supersedes its task", () => {
  const cs = seedCommitments().map((c) => c.id === "C05" ? { ...c, text: "order 50 cardboard boxes" } : c);
  const out = applyStatusChanges(cs, [{ kind: "decision", action: "Cancel Human Acclimation Lab box order",
    newStatus: "cancelled", fileId: "sync02", evidence: "The Human Acclimation Lab box order is cancelled." }],
  MATCH_DEFAULTS);
  const c5 = out.find((c) => c.id === "C05")!;
  assert.equal(c5.status, "cancelled");
  assert.ok(c5.statusEvidence!.score! < MATCH_DEFAULTS.matchThreshold, `score ${c5.statusEvidence!.score}`);
  assert.equal(out.length, cs.length, "attached to C05, not added as a commitment of its own");

  const f = matchFolder(out, seedTasks(), allFiles, MATCH_DEFAULTS).findings.find((x) => x.task?.id === "T4")!;
  assert.equal(f.bucket, "superseded");
  const checked = withCertainty(f, MATCH_DEFAULTS);
  assert.equal(checked.checks.status, false);
  assert.equal(checked.certainty, "low", "a weak status match waits for a person");
});

test("a cancellation with no clear best commitment changes none of them", () => {
  const cs: Commitment[] = [
    { ...base, id: "a", text: "Order 50 cardboard boxes", evidence: "Biscuits will order 50 cardboard boxes." },
    { ...base, id: "b", text: "Order 40 cardboard boxes", evidence: "Dale will order 40 cardboard boxes." },
  ];
  const out = applyStatusChanges(cs, [{ kind: "decision", action: "Cancel the cardboard box order",
    newStatus: "cancelled", fileId: "f2", evidence: "The cardboard box order is cancelled." }], MATCH_DEFAULTS);
  assert.deepEqual(out.slice(0, 2).map((c) => c.status), ["open", "open"]);
});

test("fingerprints are stable and readable, and a shared prefix does not collide", () => {
  const words = "replace break room tuna dispenser filter";
  const hash = createHash("sha1").update(words).digest("hex").slice(0, 6);
  assert.equal(slug("Replace the break room tuna dispenser filter"), `replace-break-room-tuna-${hash}`);
  assert.notEqual(
    slug("Replace the break room tuna dispenser filter"),
    slug("Replace the break room tuna dispenser housing"),
  );
  assert.equal(fingerprint("untracked", { ...base, fileId: "2532048604610", text: "Replace the break room tuna dispenser filter" }),
    `untracked|2532048604610|replace-break-room-tuna-${hash}`);
  assert.equal(fingerprint("orphan", undefined, { ...task, id: "T6", fileId: "sync02" }), "orphan|sync02|task-T6");
  const short = "untracked|1|book";
  const longer = "untracked|1|book-the-hall";
  assert.equal(commentCarriesFingerprint(`Herding Cats: hello\n\nfingerprint: ${longer}`, short), false);
  assert.equal(commentCarriesFingerprint(`Herding Cats: hello\n\nfingerprint: ${short}`, short), true);
});

test("a restatement worded too differently to merge folds into the commitment holding its task", () => {
  const cs = seedCommitments();
  const c01 = cs.find((c) => c.id === "C01")!;
  c01.mentions = [];
  // The live model's wording of the sync01 restatement: 59 against C01, 100 against T1.
  cs.push({ ...c01, id: "C01-live", fileId: "sync01", text: "book the Great Hall",
    evidence: "Tuxedo is still working on booking the Great Hall for the all-paws." });
  const { findings } = matchFolder(cs, seedTasks(), allFiles, MATCH_DEFAULTS);
  assert.equal(findings.find((f) => f.task?.id === "T1")?.bucket, "matched");
  assert.ok(!findings.some((f) => f.commitment?.id === "C01-live"), "no untracked finding for the restatement");
  assert.deepEqual(c01.mentions.map((m) => m.fileId), ["sync01"]);
});

test("a different owner's commitment that loses the task stays untracked", () => {
  const cs = seedCommitments();
  const c01 = cs.find((c) => c.id === "C01")!;
  cs.push({ ...c01, id: "other", owner: "Pixel", ownerUserId: people.users.vanessa, text: "book the Great Hall" });
  const f = matchFolder(cs, seedTasks(), allFiles, MATCH_DEFAULTS).findings.find((x) => x.commitment?.id === "other");
  assert.equal(f?.bucket, "untracked");
  assert.equal(f?.score, 100);
});
