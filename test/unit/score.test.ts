import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { expectation, type FormatsKey, scoreFormats } from "../../src/score.js";
import type { AppState, Commitment, Finding } from "../../src/types.js";

const key = JSON.parse(readFileSync("seed/answer_key_formats.json", "utf8")) as FormatsKey;
const ev = (id: string) => key.commitments.find((c) => c.id === id)!.evidence;

test("expectation reads the key's expected_finding wording", () => {
  assert.deepEqual(expectation("untracked"), { found: true, bucket: "untracked", low: false, conditional: false });
  assert.deepEqual(expectation("untracked (low certainty; no due date)"),
    { found: true, bucket: "untracked", low: true, conditional: false });
  assert.deepEqual(expectation("untracked; owner unresolved, so low certainty"),
    { found: true, bucket: "untracked", low: true, conditional: false });
  assert.deepEqual(expectation("not found (file skipped)"), { found: false, bucket: undefined, low: false, conditional: false });
  assert.equal(expectation("untracked if speaker notes are extracted; otherwise not found (record which)").conditional, true);
  assert.equal(expectation("untracked (low certainty) if all pages are read; missing if only 5 are").conditional, true);
  // Every expectation in the key parses to a known bucket or an expected miss.
  for (const c of key.commitments) {
    const e = expectation(c.expected_finding);
    assert.ok(!e.found || e.bucket === "untracked", `${c.id}: ${c.expected_finding}`);
  }
});

const commitment = (fileId: string, evidence: string, text = "x"): Commitment =>
  ({ id: `${fileId}:0`, fileId, fileVersion: "1", text, evidence, status: "open" });
const finding = (c: Commitment, certainty: "high" | "low", bucket: Finding["bucket"] = "untracked"): Finding =>
  ({ id: c.id, bucket, certainty, checks: {}, commitment: c, fingerprint: c.id });

function state(findings: Finding[], extra: Partial<AppState> = {}): AppState {
  const files = Object.fromEntries(Object.values(key.files).map((f, i) => [`f${i}`, { name: f.name }]));
  return { mode: "dry-run", watching: false, aiCallsThisMonth: 0, findings, setAside: [], files, ...extra };
}
const id = (source: string) => `f${Object.keys(key.files).indexOf(source)}`;
const allIds = new Set(Object.keys(key.files).map(id));

test("scoreFormats grades found, low-certainty and expected-missing commitments", () => {
  const report = scoreFormats(state([
    finding(commitment(id("sync03_docx"), ev("C10")), "high"),
    finding(commitment(id("decree_scan"), ev("C17")), "high"), // OCR'd: must be low
    finding(commitment(id("oversize_pdf"), ev("C30")), "low"), // file should have been skipped
  ]), key, allIds);
  const by = (cid: string) => report.commitments.find((c) => c.id === cid)!;
  assert.equal(by("C10").ok, true);
  assert.equal(by("C17").ok, false, "OCR finding reported at high certainty");
  assert.equal(by("C30").ok, false, "commitment from a file that should be skipped");
  assert.equal(by("C11").ok, false, "missing");
  assert.equal(by("C31").ok, true, "expected miss");
  assert.equal(by("C14").ok, undefined, "conditional on speaker notes");
});

test("scoreFormats accepts OCR evidence that is close, and flags it fuzzy", () => {
  const ocr = ev("C22").replace(/\.$/, "").replace(/o/, "0");
  const report = scoreFormats(state([finding(commitment(id("whiteboard_png"), ocr), "low")]), key, allIds);
  const c22 = report.commitments.find((c) => c.id === "C22")!;
  assert.deepEqual(c22.observed, { state: "finding", bucket: "untracked", certainty: "low", fuzzy: true });
  assert.equal(c22.ok, true);
});

test("scoreFormats grades file handling and lists false positives", () => {
  const scanned = new Set([...allIds].filter((f) => f !== id("recording_mp4") && f !== id("whiteboard_png")));
  const report = scoreFormats(state([
    finding(commitment(id("stapler_pdf"), key.non_commitments.find((n) => n.source === "stapler_pdf")!.text), "high"),
  ], { errors: [{ fileId: id("encrypted_pdf"), message: "Box 415" }],
    setAside: [{ kind: "commitment", action: "Requisition three bags of premium catnip", newStatus: "cancelled",
      evidence: "Pixel\tRequisition three bags of premium catnip\t2026-10-01\tCancelled", fileId: id("tracker_xlsx") }] }),
  key, scanned);
  const file = (s: string) => report.files.find((f) => f.source === s)!;
  assert.equal(file("recording_mp4").ok, true, "unsupported file skipped");
  assert.equal(file("whiteboard_png").ok, false, "image should be scanned");
  assert.equal(file("encrypted_pdf").actual, "error: Box 415");
  assert.equal(file("encrypted_pdf").ok, true, "error audited and the cycle continued");
  assert.equal(file("empty_txt").ok, true);
  assert.deepEqual(report.falsePositives.map((f) => [f.source, f.knownNonCommitment]), [["stapler_pdf", true]],
    "the cancelled row is set aside, not a false positive");
});
