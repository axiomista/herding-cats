// TrackerAdapter for Box Tasks. createTask is two calls: create the task, then assign it.
import type { BoxClient } from "box-node-sdk/sdk-gen";
import { dateTimeFromString, dateTimeToString } from "box-node-sdk/sdk-gen/internal/utils";
import { commentCarriesFingerprint } from "../engine/match.js";
import type { TrackerAdapter, TrackerTask } from "../types.js";

// A due date is stored as 5pm Pacific on that day, as seed_tasks.py does.
export const dueAtFor = (date: string) => `${date}T17:00:00-07:00`;

export function pacificDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(iso));
}

export class BoxTasksTracker implements TrackerAdapter {
  constructor(private client: BoxClient) {}

  async listTasks(fileId: string): Promise<TrackerTask[]> {
    const tasks = await this.client.tasks.getFileTasks(fileId);
    return Promise.all((tasks.entries ?? []).map(async (t) => {
      let assignments = t.taskAssignmentCollection?.entries;
      if (!assignments) assignments = (await this.client.taskAssignments.getTaskAssignments(t.id!)).entries;
      return {
        id: t.id!,
        fileId,
        message: t.message ?? "",
        assigneeIds: (assignments ?? []).map((a) => a.assignedTo?.id).filter((id): id is string => !!id),
        due: t.dueAt ? pacificDate(dateTimeToString(t.dueAt)) : undefined,
        completed: t.isCompleted ?? false,
      };
    }));
  }

  // If the assignment fails, the task comes back unassigned with Box's error for the audit entry.
  // Box rejects due dates in the past with a 400; the task is then created without one and
  // `dueError` says why, as seed_tasks.py does.
  async createTask(fileId: string, message: string, assigneeId?: string, due?: string)
    : Promise<TrackerTask & { assignError?: string; dueError?: string }> {
    const create = (withDue: boolean) => this.client.tasks.createTask({
      item: { type: "file", id: fileId },
      action: "complete",
      message,
      completionRule: "any_assignee",
      ...(withDue && due ? { dueAt: dateTimeFromString(dueAtFor(due)) } : {}),
    });
    let task;
    let dueError: string | undefined;
    try {
      task = await create(true);
    } catch (err) {
      const pastDue = pastDueError(err);
      // Only a due date Box rejected is retried. Any other 400 is a real failure.
      if (!due || !pastDue) throw err;
      dueError = pastDue;
      task = await create(false);
    }
    const created: TrackerTask & { assignError?: string; dueError?: string } =
      { id: task.id!, fileId, message, assigneeIds: [], due: dueError ? undefined : due, completed: false, dueError };
    if (!assigneeId) return created;
    try {
      await this.client.taskAssignments.createTaskAssignment({
        task: { type: "task", id: task.id! },
        assignTo: { id: assigneeId },
      });
      created.assigneeIds = [assigneeId];
    } catch (err) {
      created.assignError = err instanceof Error ? err.message : String(err);
    }
    return created;
  }

  async comment(fileId: string, text: string): Promise<string> {
    const created = await this.client.comments.createComment({ message: text, item: { id: fileId, type: "file" } });
    return created.id ?? "";
  }

  async hasComment(fileId: string, fingerprint: string): Promise<boolean> {
    const comments = await this.client.comments.getFileComments(fileId, { queryParams: { fields: ["message"] } });
    return (comments.entries ?? []).some((c) => commentCarriesFingerprint(c.message ?? "", fingerprint));
  }
}

// Box rejects a due date in the past with a 400 whose message says so. Other 400s must surface.
function pastDueError(err: unknown): string | undefined {
  const info = (err as { responseInfo?: { statusCode?: number; body?: { message?: string } } }).responseInfo;
  const message = info?.body?.message ?? (err instanceof Error ? err.message : "");
  if (info?.statusCode !== 400 || !/due date/i.test(message) || !/past/i.test(message)) return undefined;
  return message;
}
