import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type AnswerKey, score } from "../../src/score.js";
import type { AppState, Commitment, Finding } from "../../src/types.js";

const key = JSON.parse(readFileSync("seed/answer_key.json", "utf8")) as AnswerKey;
const formats = key.formats!;
const evidence = (id: string) => formats.commitments.find((c) => c.id === id)!.evidence;

const untracked = (fileId: string, text: string, ev: string): Finding => ({
  id: text, bucket: "untracked", certainty: "low", checks: {}, fingerprint: text,
  commitment: { id: text, fileId, fileVersion: "1", text, evidence: ev, status: "open" } as Commitment,
});

const state = (findings: Finding[], extra: Partial<AppState> = {}): AppState => ({
  mode: "dry-run", watching: false, aiCallsThisMonth: 0, findings, setAside: [],
  files: { s: { name: formats.files.standup_docx }, e: { name: formats.files.encrypted_pdf },
    w: { name: formats.files.whiteboard_png } },
  ...extra,
});

test("the format corpus is in the answer key with a known handling for every file", () => {
  assert.equal(Object.keys(formats.files).length, 19);
  for (const file of Object.keys(formats.files)) assert.ok(formats.handling[file]?.expected, file);
  for (const c of formats.commitments) assert.ok(formats.files[c.source], `${c.id} names a known file`);
  const ids = [...key.commitments, ...formats.commitments].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "commitment IDs are unique across the seed and format corpora");
});

test("format commitments are reported on their own and are never false positives", () => {
  const report = score(state([
    untracked("s", "Finalize the seating chart", evidence("C10")),
    untracked("s", "Water the plastic ficus", "Dale will water the plastic ficus by Friday."),
  ], { errors: [{ fileId: "e", message: "No extracted_text representation for file e" }] }), key);

  assert.deepEqual(report.falsePositives.items, ["Water the plastic ficus"], "only the unknown commitment is a false positive");
  assert.equal(report.recall.total, 9, "the seed recall is unchanged");

  const c10 = report.formats!.commitments.find((c) => c.id === "C10")!;
  assert.deepEqual([c10.found, c10.bucket, c10.certainty], [true, "untracked", "low"]);
  assert.equal(report.formats!.commitments.find((c) => c.id === "C30")!.found, false);

  const observed = Object.fromEntries(report.formats!.files.map((f) => [f.file, f.observed]));
  assert.equal(observed.standup_docx, "items extracted");
  assert.equal(observed.encrypted_pdf, "error");
  assert.equal(observed.whiteboard_png, "no items", "listed in the folder but skipped");
  assert.equal(observed.oversize_pdf, "not in folder");
});
