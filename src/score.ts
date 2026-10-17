// (new) Scores findings against answer_key.json (repo only). Shared by the replay test,
// npm run eval and POST /api/score.
import type { AppState, Commitment, ExtractedItem } from "./types.js";
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
  const fps = labeled.filter((c) => !key.commitments.some((a) => isAnswer(c, a)));

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
