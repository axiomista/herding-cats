// (new) Scores findings against answer_key.json (repo only). Shared by the replay test,
// npm run eval and POST /api/score. scoreFormats does the same for answer_key_formats.json.
import type { AppState, Bucket, Commitment, ExtractedItem } from "./types.js";
import { similarity } from "./engine/normalize.js";
import { normalizeText } from "./engine/verify.js";

export interface AnswerKey {
  files: Record<string, string>;
  commitments: { id: string; source: string; evidence: string; also_mentioned_in?: { source: string; evidence: string }[] }[];
  tasks: { id: string; message: string; expected: string }[];
  scoring: { untracked_expected: string[] };
}

export interface ScoreReport {
  recall: { found: number; total: number; missing: string[]; c01Count: number };
  falsePositives: { count: number; items: string[] };
  tasks: { id: string; expected: string; actual?: string; ok: boolean }[];
  untracked: { expected: string[]; missing: string[] };
}

type Labeled = { fileId: string; evidence: string; text: string; mentions?: { fileId: string; evidence: string }[] };

const same = (a: string, b: string) => normalizeText(a) === normalizeText(b);

export function score(state: AppState, key: AnswerKey): ScoreReport {
  const name = (fileId: string) => state.files?.[fileId]?.name ?? fileId;
  const fromFindings: Labeled[] = state.findings.map((f) => f.commitment)
    .filter((c): c is Commitment => !!c && !(c.flags ?? []).includes("from status change"));
  const fromSetAside: Labeled[] = state.setAside.filter((i: ExtractedItem) => i.kind === "commitment")
    .map((i) => ({ fileId: i.fileId ?? "", evidence: i.evidence, text: i.action }));
  const labeled = [...fromFindings, ...fromSetAside];

  // Does a commitment the tool reported carry this answer-key evidence, as itself or as a mention?
  const quotes = (c: Labeled) => [{ fileId: c.fileId, evidence: c.evidence }, ...(c.mentions ?? [])];
  const carries = (c: Labeled, source: string, evidence: string) =>
    quotes(c).some((q) => name(q.fileId) === key.files[source] && same(q.evidence, evidence));
  const isAnswer = (c: Labeled, a: AnswerKey["commitments"][number]) =>
    carries(c, a.source, a.evidence) || (a.also_mentioned_in ?? []).some((m) => carries(c, m.source, m.evidence));

  const missing = key.commitments.filter((a) => !labeled.some((c) => isAnswer(c, a))).map((a) => a.id);
  const c01 = key.commitments.find((a) => a.id === "C01");
  const c01Count = c01 ? labeled.filter((c) => isAnswer(c, c01)).length : 0;
  // Only this key's files count: the format corpus and other files are scored elsewhere.
  const keyed = new Set(Object.values(key.files));
  const fps = labeled.filter((c) => keyed.has(name(c.fileId)) && !key.commitments.some((a) => isAnswer(c, a)));

  const tasks = key.tasks.map((t) => {
    const expected = t.expected.split(" ")[0];
    const actual = state.findings.find((f) => f.task?.message === t.message)?.bucket;
    return { id: t.id, expected, actual, ok: actual === expected };
  });

  const untrackedMissing = key.scoring.untracked_expected.filter((id) => {
    const a = key.commitments.find((x) => x.id === id)!;
    return !state.findings.some((f) => f.bucket === "untracked" && f.commitment && isAnswer(f.commitment, a));
  });

  return {
    recall: { found: key.commitments.length - missing.length, total: key.commitments.length, missing, c01Count },
    falsePositives: { count: fps.length, items: fps.map((c) => c.text) },
    tasks,
    untracked: { expected: key.scoring.untracked_expected, missing: untrackedMissing },
  };
}

// The format corpus key: one file per format or edge case, with the handling each should get.
export interface FormatsKey {
  files: Record<string, { name: string; format: string; expected_handling: string }>;
  commitments: { id: string; source: string; evidence: string; expected_finding: string }[];
  non_commitments: { source: string; kind: string; text: string }[];
}

export interface Expectation { found: boolean; bucket?: string; low: boolean; conditional: boolean }

// Reads an expected_finding such as "untracked (low certainty; no due date)", "not found (file
// skipped)" or "untracked if speaker notes are extracted; otherwise not found (record which)".
// A conditional expectation is reported but never fails the run.
export function expectation(text: string): Expectation {
  const found = !/^not found/i.test(text);
  return { found, bucket: found ? text.split(/[\s;(]/)[0] : undefined,
    low: /low certainty/i.test(text), conditional: /\bif\b/i.test(text) };
}

// What happened to one key commitment: a finding (with its bucket), set aside, dropped by the
// evidence check, or missing. OCR'd evidence rarely matches the key word for word, so a commitment
// from the same file at similarity >= 85 counts, marked fuzzy.
export type Observed = { state: "finding"; bucket: Bucket; certainty: "high" | "low"; fuzzy: boolean }
  | { state: "set aside" | "unverified"; fuzzy: boolean } | { state: "missing" };

export interface FormatsReport {
  commitments: { id: string; source: string; expected: string; observed: Observed; ok?: boolean }[];
  files: { source: string; name: string; expected: string; actual: string; items: number; ok?: boolean }[];
  falsePositives: { source: string; text: string; evidence: string; knownNonCommitment: boolean }[];
}

const FUZZY = 85;

// scanned: IDs of files the inventory kept (the rest were skipped as unsupported or too large).
export function scoreFormats(state: AppState, key: FormatsKey, scanned: ReadonlySet<string>): FormatsReport {
  const idByName = new Map(Object.entries(state.files ?? {}).map(([id, f]) => [f.name, id]));
  const sourceOf = new Map(Object.entries(key.files).map(([k, f]) => [idByName.get(f.name) ?? "", k]));
  type Item = { fileId: string; evidence: string; text: string; observed: Observed };
  const items: Item[] = [
    ...state.findings.flatMap((f) => f.commitment && !(f.commitment.flags ?? []).includes("from status change")
      ? [{ fileId: f.commitment.fileId, evidence: f.commitment.evidence, text: f.commitment.text,
        observed: { state: "finding" as const, bucket: f.bucket, certainty: f.certainty, fuzzy: false } }] : []),
    ...state.setAside.filter((i) => i.kind === "commitment").map((i) => ({ fileId: i.fileId ?? "",
      evidence: i.evidence, text: i.action, observed: { state: "set aside" as const, fuzzy: false } })),
    ...(state.unverified ?? []).filter((i) => i.kind === "commitment").map((i) => ({ fileId: i.fileId,
      evidence: i.evidence, text: i.action, observed: { state: "unverified" as const, fuzzy: false } })),
  ].filter((i) => sourceOf.has(i.fileId));

  const used = new Set<Item>();
  const commitments = key.commitments.map((a) => {
    const fileId = idByName.get(key.files[a.source]?.name ?? "");
    const mine = items.filter((i) => i.fileId === fileId);
    let hit = mine.find((i) => normalizeText(i.evidence) === normalizeText(a.evidence));
    let fuzzy = false;
    if (!hit) {
      const best = mine.map((i) => ({ i, s: similarity(i.evidence, a.evidence) })).sort((x, y) => y.s - x.s)[0];
      if (best && best.s >= FUZZY) { hit = best.i; fuzzy = true; }
    }
    if (hit) used.add(hit);
    const observed: Observed = hit ? { ...hit.observed, fuzzy } as Observed : { state: "missing" };
    const want = expectation(a.expected_finding);
    const ok = want.conditional ? undefined : want.found
      ? observed.state === "finding" && observed.bucket === want.bucket && (!want.low || observed.certainty === "low")
      : observed.state === "missing";
    return { id: a.id, source: a.source, expected: a.expected_finding, observed, ok };
  });

  const errors = new Map((state.errors ?? []).map((e) => [e.fileId, e.message]));
  const files = Object.entries(key.files).map(([source, f]) => {
    const id = idByName.get(f.name);
    const actual = !id ? "not in folder" : !scanned.has(id) ? "skipped"
      : errors.has(id) ? `error: ${errors.get(id)}` : "scanned";
    const count = items.filter((i) => i.fileId === id).length;
    const h = f.expected_handling;
    const ok = /\bif\b/.test(h) ? undefined
      : h.startsWith("skip_or_error") ? actual === "skipped" || actual.startsWith("error")
      : h.startsWith("skip") ? actual === "skipped"
      : h === "no_findings_no_crash" ? actual === "scanned" && count === 0
      : actual === "scanned";
    return { source, name: f.name, expected: h, actual, items: count, ok };
  });

  const nonCommitments = (source: string, i: Item) => key.non_commitments.some((n) => n.source === source
    && (normalizeText(n.text) === normalizeText(i.evidence) || similarity(n.text, i.evidence) >= FUZZY));
  // Only findings count: a cancelled row is set aside, and the evidence check's drops are never
  // reported as commitments.
  const falsePositives = items.filter((i) => !used.has(i) && i.observed.state === "finding").map((i) => {
    const source = sourceOf.get(i.fileId)!;
    return { source, text: i.text, evidence: i.evidence, knownNonCommitment: nonCommitments(source, i) };
  });
  return { commitments, files, falsePositives };
}
