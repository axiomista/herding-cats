import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditLog } from "../../src/audit.js";
import { applyFinding } from "../../src/engine/apply.js";
import { State } from "../../src/state.js";
import type { Finding, TrackerAdapter } from "../../src/types.js";

const finding = {
  id: "f1", bucket: "untracked", certainty: "high", checks: {}, fingerprint: "untracked|file|survey",
  proposal: { kind: "task", fileId: "file", message: "Draft the survey", assigneeId: "u", assigneeName: "Dale" },
  commitment: { id: "c", fileId: "file", fileVersion: "1", text: "Draft the survey", evidence: "Dale will.", status: "open" },
} as Finding;

function ctxFor(tracker: TrackerAdapter) {
  const state = new State("apply");
  state.names.set("file", "notes.md");
  const audit = { async append() {}, async read() { return ""; } } as unknown as AuditLog;
  return { tracker, audit, state, people: { users: {}, people: [] }, now: () => new Date("2026-10-17T17:00:00Z") };
}

test("a task whose assignment fails still counts as applied", async () => {
  const tracker = {
    async listTasks() { return []; },
    async createTask() {
      return { id: "t1", fileId: "file", message: "Draft the survey", assigneeIds: [], completed: false, assignError: "nope" };
    },
    async comment() { return "c1"; },
    async hasComment() { return false; },
  } as TrackerAdapter;
  const result = await applyFinding(ctxFor(tracker), finding, "click");
  assert.equal(result.status, "applied");
  assert.match(result.change, /task t1 created/);
  assert.match(result.outcome, /assignment failed: nope/);
});

test("an overlapping write of the same finding does not create a second task", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let creates = 0;
  const tracker = {
    async listTasks() { return []; },
    async createTask() {
      creates++;
      await gate;
      return { id: "t1", fileId: "file", message: "Draft the survey", assigneeIds: ["u"], completed: false };
    },
    async comment() { return "c1"; },
    async hasComment() { return false; },
  } as TrackerAdapter;
  const ctx = ctxFor(tracker);
  const first = applyFinding(ctx, finding, "click");
  const second = await applyFinding(ctx, finding, "click");
  assert.equal(second.status, "skipped");
  assert.equal(second.change, "already writing");
  release();
  const done = await first;
  assert.equal(done.status, "applied");
  assert.equal(creates, 1);
});
