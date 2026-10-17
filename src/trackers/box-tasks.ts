// TrackerAdapter for Box Tasks. createTask is two calls: create the task, then assign it.
import type { BoxClient } from "box-node-sdk/sdk-gen";
import { dateTimeFromString, dateTimeToString } from "box-node-sdk/sdk-gen/internal/utils";
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
      if (!due || (err as { responseInfo?: { statusCode?: number } }).responseInfo?.statusCode !== 400) throw err;
      dueError = (err as { responseInfo?: { body?: { message?: string } } }).responseInfo?.body?.message
        ?? (err instanceof Error ? err.message : String(err));
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

  async comment(fileId: string, text: string): Promise<void> {
    await this.client.comments.createComment({ message: text, item: { id: fileId, type: "file" } });
  }

  async hasComment(fileId: string, fingerprint: string): Promise<boolean> {
    const comments = await this.client.comments.getFileComments(fileId, { queryParams: { fields: ["message"] } });
    return (comments.entries ?? []).some((c) => (c.message ?? "").includes(fingerprint));
  }
}
