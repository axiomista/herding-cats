// (new) "Ask Box AI" on one finding: a second opinion from Box AI Ask over the files behind it,
// with citations. Read-only and advisory: it writes nothing to Box, and certainty never reads it.
// Answers are kept per finding fingerprint, so asking again costs no AI units.
import { ASK_MAX_FILES } from "../box.js";
import type { State } from "../state.js";
import type { AskAnswer, Bucket, Finding } from "../types.js";
import type { Engine } from "./cycle.js";
import { type People, userName } from "./normalize.js";

const LABELS: Record<Bucket, string> = {
  superseded: "Superseded: the plan cancelled or completed this, but its task is still open",
  owner_conflict: "Owner conflict: the task is assigned to someone other than the owner in the document",
  date_conflict: "Date conflict: the task's due date differs from the document's",
  misfiled: "Misfiled: the task sits on a file that never mentions it",
  matched: "Matched: the document and the task agree",
  untracked: "Untracked: a commitment with no task",
  orphan: "Orphan: a task no document explains",
};

const QUESTIONS: Record<Bucket, string> = {
  untracked: "Is this still an open commitment someone should track, or do the documents show it was cancelled, completed or handed to someone else?",
  superseded: "Do the documents show this commitment was cancelled or completed, so the open task can be closed?",
  owner_conflict: "According to the documents, who owns this commitment?",
  date_conflict: "According to the documents, when is this commitment due? Did the date change anywhere?",
  misfiled: "Which document is the source of this task?",
  orphan: "Does any document mention or justify this task?",
  matched: "Do the documents and the task agree on the owner, the due date and the status?",
};

const name = (state: State, id: string) => state.names.get(id) ?? `file ${id}`;

// The files Box AI reads: the ones behind the finding, or the whole folder when the question is
// whether any document mentions the task.
export function askFiles(f: Finding, state: State): string[] {
  const c = f.commitment;
  const ids = f.bucket === "orphan" || f.bucket === "misfiled"
    ? [...(c ? [c.fileId] : []), ...(f.task ? [f.task.fileId] : []), ...state.files.keys()]
    : [c?.fileId, c?.statusEvidence?.fileId, ...(c?.mentions ?? []).map((m) => m.fileId), f.task?.fileId];
  return [...new Set(ids.filter((id): id is string => !!id))].slice(0, ASK_MAX_FILES);
}

export function askPrompt(f: Finding, state: State, people: People): string {
  const c = f.commitment;
  const t = f.task;
  const lines = [
    "You are checking one finding from Herding Cats, a tool that compares commitments written in documents with the Box Tasks meant to track them.",
    "Answer only from the attached documents. If they do not say, answer \"The documents don't say.\"",
    "",
    `Finding: ${LABELS[f.bucket]}.`,
  ];
  if (c) {
    lines.push(`Commitment: ${c.text}. Owner: ${c.owner ?? "not stated"}. Due: ${c.due ?? "not stated"}.`);
    lines.push(`Evidence: "${c.evidence}" (from "${name(state, c.fileId)}")`);
    if (c.statusEvidence) lines.push(`Status evidence: "${c.statusEvidence.evidence}" (from "${name(state, c.statusEvidence.fileId)}")`);
    for (const m of c.mentions ?? []) lines.push(`Also mentioned: "${m.evidence}" (from "${name(state, m.fileId)}")`);
  }
  if (t) {
    const assignees = t.assigneeIds.length ? t.assigneeIds.map((id) => userName(people, id)).join(", ") : "nobody";
    lines.push(`Task: "${t.message}". Assigned to: ${assignees}. Due: ${t.due ?? "none"}. Attached to: "${name(state, t.fileId)}".`);
  }
  lines.push("", `Question: ${QUESTIONS[f.bucket]}`,
    "Reply in two short parts: your answer in one or two plain sentences, then the one sentence from the documents that best supports it, copied exactly.");
  return lines.join("\n");
}

export async function askAboutFinding(engine: Engine, f: Finding): Promise<AskAnswer> {
  const { state } = engine;
  const cached = state.asks.get(f.fingerprint);
  if (cached) return cached;
  const inFlight = state.asking.get(f.fingerprint);
  if (inFlight) return inFlight;
  const run = (async () => {
    const fileIds = askFiles(f, state);
    if (!fileIds.length) throw new Error("this finding has no files to ask about");
    const question = askPrompt(f, state, engine.people);
    state.countAiCalls(1, engine.now());
    const res = await engine.gateway.ask(fileIds, question);
    const answer: AskAnswer = { question, answer: res.answer.trim(), model: res.model,
      at: engine.now().toISOString(), fileIds, citations: res.citations };
    state.asks.set(f.fingerprint, answer);
    return answer;
  })();
  state.asking.set(f.fingerprint, run);
  try { return await run; } finally { state.asking.delete(f.fingerprint); }
}
