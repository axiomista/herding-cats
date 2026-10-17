import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditLog } from "../../src/audit.js";
import { applyFinding, holdFinding } from "../../src/engine/apply.js";
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

function failingAudit(ctx: ReturnType<typeof ctxFor>) {
  ctx.audit = { async append() { throw new Error("Box upload failed"); }, async read() { return ""; } } as unknown as AuditLog;
  return ctx;
}

const quiet = () => {
  const original = console.error;
  console.error = () => {};
  return () => { console.error = original; };
};

test("a task that was created counts as applied when the audit upload fails", async () => {
  const tracker = {
    async listTasks() { return []; },
    async createTask() { return { id: "t1", fileId: "file", message: "Draft the survey", assigneeIds: ["u"], completed: false }; },
    async comment() { return "c1"; },
    async hasComment() { return false; },
  } as TrackerAdapter;
  const restore = quiet();
  try {
    const result = await applyFinding(failingAudit(ctxFor(tracker)), finding, "click");
    assert.equal(result.status, "applied");
    assert.match(result.change, /task t1 created/);
    assert.equal(result.outcome, "ok");
    assert.equal(result.auditError, "Box upload failed");
  } finally { restore(); }
});

const commentFinding = {
  ...finding, bucket: "orphan", fingerprint: "orphan|file|survey",
  proposal: { kind: "comment", fileId: "file", text: "Is it still needed?" },
} as Finding;

test("a comment that was posted counts as applied when the audit upload fails", async () => {
  const tracker = {
    async listTasks() { return []; },
    async createTask() { throw new Error("unexpected"); },
    async comment() { return "c1"; },
    async hasComment() { return false; },
  } as unknown as TrackerAdapter;
  const restore = quiet();
  try {
    const result = await applyFinding(failingAudit(ctxFor(tracker)), commentFinding, "click");
    assert.equal(result.status, "applied");
    assert.match(result.change, /comment c1 posted/);
    assert.equal(result.auditError, "Box upload failed");
  } finally { restore(); }
});

test("a failed write still reports failed when the audit upload also fails", async () => {
  const tracker = {
    async listTasks() { return []; },
    async createTask() { throw new Error("Box 503"); },
    async comment() { return "c1"; },
    async hasComment() { return false; },
  } as TrackerAdapter;
  const restore = quiet();
  try {
    const result = await applyFinding(failingAudit(ctxFor(tracker)), finding, "click");
    assert.equal(result.status, "failed");
    assert.equal(result.outcome, "Box 503");
    assert.equal(result.auditError, "Box upload failed");
  } finally { restore(); }
});

test("holding a finding does not throw when the audit upload fails, and logs it again next time", async () => {
  const ctx = failingAudit(ctxFor({} as TrackerAdapter));
  const restore = quiet();
  try {
    assert.equal(await holdFinding(ctx, finding, "sweep"), true);
    assert.equal(ctx.state.heldLogged.has(finding.fingerprint), false);
  } finally { restore(); }
});
