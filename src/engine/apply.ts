// Task, comment and metadata writes. Apply mode and a person's click use the same write path.
// No write deletes or edits existing content.
import type { AuditLog } from "../audit.js";
import type { State } from "../state.js";
import type { AuditEntry, Finding, Proposal, TrackerAdapter, Trigger } from "../types.js";
import { PROMPT_VERSION } from "./extract.js";
import { type People, userName } from "./normalize.js";

export interface WriteContext {
  tracker: TrackerAdapter;
  audit: AuditLog;
  state: State;
  people: People;
  now: () => Date;
}

const fileName = (state: State, id: string) => state.names.get(id) ?? id;

// The exact write a finding proposes; the card shows it before it is sent.
export function buildProposal(f: Omit<Finding, "proposal">, state: State, people: People): Proposal | undefined {
  const c = f.commitment;
  const t = f.task;
  const tail = `\n\nfingerprint: ${f.fingerprint}`;
  const source = c ? `"${fileName(state, c.fileId)}"` : "";
  switch (f.bucket) {
    case "untracked":
      return { kind: "task", fileId: c!.fileId, message: c!.text, assigneeId: c!.ownerUserId,
        assigneeName: c!.owner, due: c!.due };
    case "superseded": {
      const ev = c!.statusEvidence ?? { fileId: c!.fileId, evidence: c!.evidence };
      const verb = c!.status === "cancelled" ? "cancels" : "reports as done";
      return { kind: "comment", fileId: t!.fileId, text:
        `Herding Cats: "${ev.evidence}" (${fileName(state, ev.fileId)}) ${verb} the task "${t!.message}". `
        + `The assignee can close it.${tail}` };
    }
    case "owner_conflict": {
      const assigned = t!.assigneeIds.map((id) => userName(people, id)).join(", ");
      return { kind: "comment", fileId: t!.fileId, text:
        `Herding Cats: the task "${t!.message}" is assigned to ${assigned}, but ${source} says ${c!.owner} owns it: `
        + `"${c!.evidence}"${tail}` };
    }
    case "date_conflict":
      return { kind: "comment", fileId: t!.fileId, text:
        `Herding Cats: the task "${t!.message}" is due ${t!.due}, but ${source} says ${c!.due}: "${c!.evidence}"${tail}` };
    case "misfiled":
      return { kind: "comment", fileId: t!.fileId, text:
        `Herding Cats: the task "${t!.message}" sits on this file, which never mentions it. `
        + `Its source is ${source}: "${c!.evidence}"${tail}` };
    case "orphan":
      return { kind: "comment", fileId: t!.fileId, text:
        `Herding Cats: no document in this folder explains the task "${t!.message}". Is it still needed?${tail}` };
    default:
      return undefined;
  }
}

function auditEvidence(f: Finding, state: State): AuditEntry["evidence"] {
  const c = f.commitment;
  if (!c) return { quote: "", fileId: f.task!.fileId, fileVersion: "" };
  const ev = f.bucket === "superseded" && c.statusEvidence ? c.statusEvidence : { fileId: c.fileId, evidence: c.evidence };
  return { quote: ev.evidence, fileId: ev.fileId, fileVersion: state.files.get(ev.fileId)?.version ?? c.fileVersion };
}

function entry(ctx: WriteContext, f: Finding, trigger: Trigger, applied: boolean, change: string, outcome: string): AuditEntry {
  const fileId = f.commitment?.fileId ?? f.task!.fileId;
  return {
    time: ctx.now().toISOString(), trigger, applied, change, finding: f,
    evidence: auditEvidence(f, ctx.state),
    model: `prompt ${PROMPT_VERSION}; ${ctx.state.files.get(fileId)?.model ?? "none"}`,
    matchScore: f.score, outcome,
  };
}

export type WriteResult = { status: "applied" | "skipped" | "failed"; change: string; outcome: string };

// Makes the finding's proposed write and records it. A comment whose fingerprint is already on
// the file is skipped, so a write is never made twice.
export async function applyFinding(ctx: WriteContext, f: Finding, trigger: Trigger, override?: Proposal)
  : Promise<WriteResult> {
  const p = override ?? f.proposal;
  if (!p) return { status: "skipped", change: "nothing to write", outcome: "ok" };
  let change: string;
  let outcome = "ok";
  try {
    if (p.kind === "task") {
      const task = await ctx.tracker.createTask(p.fileId, p.message, p.assigneeId, p.due) as
        { id: string; assignError?: string; dueError?: string; assigneeIds: string[] };
      const who = task.assigneeIds.length ? `assigned to ${p.assigneeName ?? userName(ctx.people, p.assigneeId!)}` : "unassigned";
      change = `task ${task.id} created on "${fileName(ctx.state, p.fileId)}", ${who}`;
      if (task.dueError) change += `, without due date ${p.due} (Box: ${task.dueError})`;
      if (task.assignError) outcome = `assignment failed: ${task.assignError}`;
    } else {
      if (await ctx.tracker.hasComment(p.fileId, f.fingerprint)) {
        return { status: "skipped", change: "comment already posted", outcome: "ok" };
      }
      await ctx.tracker.comment(p.fileId, p.text);
      change = `comment posted on "${fileName(ctx.state, p.fileId)}"`;
    }
  } catch (err) {
    change = `${p.kind} not written`;
    outcome = err instanceof Error ? err.message : String(err);
  }
  await ctx.audit.append(entry(ctx, f, trigger, true, change, outcome));
  return { status: outcome === "ok" ? "applied" : "failed", change, outcome };
}

// Low-certainty findings in apply mode wait for a person; each is logged as HELD once per process.
export async function holdFinding(ctx: WriteContext, f: Finding, trigger: Trigger): Promise<boolean> {
  if (ctx.state.heldLogged.has(f.fingerprint)) return false;
  ctx.state.heldLogged.add(f.fingerprint);
  await ctx.audit.append(entry(ctx, f, trigger, false, "held", "ok"));
  return true;
}
