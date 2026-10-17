import assert from "node:assert/strict";
import { test } from "node:test";
import { MATCH_DEFAULTS } from "../../src/config.js";
import { withCertainty } from "../../src/engine/certainty.js";
import type { Bucket, Commitment, TrackerTask } from "../../src/types.js";

const c: Commitment = { id: "c", fileId: "f", fileVersion: "1", text: "Do it", evidence: "e",
  owner: "Dale Henderson", ownerUserId: "u1", due: "2026-10-10", dueAbsolute: true, status: "open", flags: [] };
const t: TrackerTask = { id: "t", fileId: "f", message: "Do it", assigneeIds: ["u1"], completed: false };
const finding = (bucket: Bucket, over: { commitment?: Commitment | undefined; task?: TrackerTask | undefined; score?: number; rivalScore?: number } = {}) =>
  withCertainty({ id: "x", fingerprint: "fp", bucket, commitment: c, task: t, score: 100, rivalScore: 40, ...over }, MATCH_DEFAULTS);

test("high when every check passes", () => {
  for (const b of ["superseded", "owner_conflict", "date_conflict", "matched"] as Bucket[]) {
    assert.equal(finding(b).certainty, "high", b);
  }
  assert.equal(finding("untracked", { task: undefined, score: 40 }).certainty, "high");
});

test("orphan and misfiled always need a person", () => {
  assert.equal(finding("misfiled").certainty, "low");
  assert.equal(finding("misfiled").checks.bucket, false);
  const orphan = finding("orphan", { commitment: undefined, score: 30 });
  assert.equal(orphan.certainty, "low");
  assert.deepEqual(orphan.checks, { bucket: false });
});

test("owner must resolve to a Box user with no flag", () => {
  assert.equal(finding("untracked", { task: undefined, commitment: { ...c, ownerUserId: undefined } }).checks.owner, false);
  assert.equal(finding("untracked", { task: undefined, commitment: { ...c, flags: ["owner external"] } }).certainty, "low");
});

test("due date must be absolute or absent", () => {
  assert.equal(finding("untracked", { task: undefined, score: 40, commitment: { ...c, due: undefined, dueAbsolute: true } }).certainty, "high");
  const rel = finding("untracked", { task: undefined, score: 40, commitment: { ...c, due: undefined, dueAbsolute: false, flags: ["date relative"] } });
  assert.equal(rel.checks.dueDate, false);
  assert.equal(rel.certainty, "low");
});

test("pairing needs 90 or more with no rival within 10 points", () => {
  assert.equal(finding("date_conflict", { score: 90, rivalScore: 80 }).checks.pairing, true);
  assert.equal(finding("date_conflict", { score: 89, rivalScore: 20 }).checks.pairing, false);
  assert.equal(finding("date_conflict", { score: 95, rivalScore: 86 }).checks.pairing, false);
  assert.equal(finding("date_conflict", { score: 95, rivalScore: 86 }).certainty, "low");
});

test("untracked findings have no pairing check", () => {
  assert.ok(!("pairing" in finding("untracked", { task: undefined, score: 40 }).checks));
});

test("untracked is low when a task scored as a possible match but went elsewhere", () => {
  const f = finding("untracked", { task: undefined, score: 100 });
  assert.equal(f.checks.pairing, false);
  assert.equal(f.certainty, "low");
  assert.equal(finding("untracked", { task: undefined, score: 59 }).certainty, "high");
});
