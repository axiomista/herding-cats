// (new) Scores findings against answer_key.json (repo only). Shared by the replay test,
// npm run eval and POST /api/score.
import type { AppState, Commitment, ExtractedItem } from "./types.js";
import { normalizeText } from "./engine/verify.js";

export interface AnswerKey {
  files: Record<string, string>;
  commitments: { id: string; source: string; evidence: string; also_mentioned_in?: { source: string; evidence: string }[] }[];
  tasks: { id: string; message: string; expected: string }[];
  scoring: { untracked_expected: string[] };
  // (new) The format test corpus (seed/formats/). Reported on its own; it never affects the
  // seed scores above, except that its commitments are not counted as false positives.
  formats?: {
    files: Record<string, string>;
    handling: Record<string, { expected: string }>;
    commitments: { id: string; source: string; evidence: string; expected_finding: string }[];
  };
}

export interface FormatFileReport { file: string; name: string; expected: string;
  observed: "not in folder" | "error" | "items extracted" | "no items"; error?: string }
export interface FormatCommitmentReport { id: string; file: string; expected: string;
  found: boolean; bucket?: string; certainty?: string; unverified: boolean }

export interface ScoreReport {
  recall: { found: number; total: number; missing: string[]; c01Count: number };
  falsePositives: { count: number; items: string[] };
  tasks: { id: string; expected: string; actual?: string; ok: boolean }[];
  untracked: { expected: string[]; missing: string[] };
  formats?: { files: FormatFileReport[]; commitments: FormatCommitmentReport[] }; // (new)
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
  const formatFiles = key.formats?.files ?? {};
  const isFormatAnswer = (c: Labeled, a: { source: string; evidence: string }) =>
    quotes(c).some((q) => name(q.fileId) === formatFiles[a.source] && same(q.evidence, a.evidence));
  const fps = labeled.filter((c) => !key.commitments.some((a) => isAnswer(c, a))
    && !(key.formats?.commitments ?? []).some((a) => isFormatAnswer(c, a)));

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
    ...(key.formats ? { formats: scoreFormats(state, key.formats, labeled, isFormatAnswer) } : {}),
  };
}

// (new) What happened to each format test file and commitment. Observations, not pass or fail:
// compare them with the answer key's expected handling.
function scoreFormats(state: AppState, formats: NonNullable<AnswerKey["formats"]>, labeled: Labeled[],
  isFormatAnswer: (c: Labeled, a: { source: string; evidence: string }) => boolean) {
  const idByName = new Map(Object.entries(state.files ?? {}).map(([id, f]) => [f.name, id]));
  const fromFile = (id: string) => [...state.findings.map((f) => f.commitment?.fileId),
    ...state.setAside.map((i) => i.fileId), ...(state.unverified ?? []).map((i) => i.fileId)].includes(id);
  const files: FormatFileReport[] = Object.entries(formats.files).map(([file, name]) => {
    const expected = formats.handling[file]?.expected ?? "";
    const id = idByName.get(name);
    if (!id) return { file, name, expected, observed: "not in folder" };
    const error = state.errors?.find((e) => e.fileId === id)?.message;
    if (error) return { file, name, expected, observed: "error", error };
    return { file, name, expected, observed: fromFile(id) ? "items extracted" : "no items" };
  });
  const commitments: FormatCommitmentReport[] = formats.commitments.map((a) => {
    const finding = state.findings.find((f) => f.commitment && isFormatAnswer(f.commitment, a));
    const found = !!finding || labeled.some((c) => isFormatAnswer(c, a));
    const unverified = (state.unverified ?? []).some((u) =>
      u.fileId === idByName.get(formats.files[a.source]) && same(u.evidence, a.evidence));
    return { id: a.id, file: a.source, expected: a.expected_finding, found,
      bucket: finding?.bucket, certainty: finding?.certainty, unverified };
  });
  return { files, commitments };
}
