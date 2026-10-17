import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoxClient } from "box-node-sdk/sdk-gen";
import { BoxTasksTracker } from "../../src/trackers/box-tasks.js";

// A stand-in for the SDK client that rejects due dates in the past the way Box does.
function fakeClient(opts: { rejectDue?: boolean; failWith?: number } = {}) {
  const calls: { dueAt?: unknown }[] = [];
  const client = {
    tasks: {
      async createTask(body: { dueAt?: unknown }) {
        calls.push(body);
        if (opts.failWith) throw Object.assign(new Error("boom"), { responseInfo: { statusCode: opts.failWith } });
        if (opts.rejectDue && body.dueAt) {
          throw Object.assign(new Error("400"), { responseInfo: { statusCode: 400, body: { message: "Task provided due date is in the past" } } });
        }
        return { id: "t1" };
      },
    },
    taskAssignments: { async createTaskAssignment() { return {}; } },
  } as unknown as BoxClient;
  return { client, calls };
}

test("createTask sends the due date when Box accepts it", async () => {
  const { client, calls } = fakeClient();
  const t = await new BoxTasksTracker(client).createTask("f", "m", "u", "2026-11-01");
  assert.equal(calls.length, 1);
  assert.equal(t.due, "2026-11-01");
  assert.equal((t as { dueError?: string }).dueError, undefined);
  assert.deepEqual(t.assigneeIds, ["u"]);
});

test("createTask retries without a past due date and says why", async () => {
  const { client, calls } = fakeClient({ rejectDue: true });
  const t = await new BoxTasksTracker(client).createTask("f", "m", "u", "2026-10-02");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].dueAt, undefined);
  assert.equal(t.due, undefined);
  assert.equal((t as { dueError?: string }).dueError, "Task provided due date is in the past");
  assert.deepEqual(t.assigneeIds, ["u"]);
});

test("createTask does not drop the due date on an unrelated 400", async () => {
  const { client, calls } = fakeClient({ failWith: 400 });
  await assert.rejects(new BoxTasksTracker(client).createTask("f", "m", "u", "2026-10-02"));
  assert.equal(calls.length, 1);
});

test("createTask does not retry other errors", async () => {
  const { client, calls } = fakeClient({ failWith: 403 });
  await assert.rejects(new BoxTasksTracker(client).createTask("f", "m", "u", "2026-10-02"));
  assert.equal(calls.length, 1);
});

// A comments endpoint paged by offset/limit like Box's, recording each offset asked for.
function commentsClient(messages: string[], opts: { omitTotal?: boolean } = {}) {
  const offsets: number[] = [];
  const client = {
    comments: {
      async getFileComments(_fileId: string, o: { queryParams: { limit: number; offset: number } }) {
        const { limit, offset } = o.queryParams;
        offsets.push(offset);
        const entries = messages.slice(offset, offset + limit).map((message) => ({ message }));
        return { entries, offset, limit, ...(opts.omitTotal ? {} : { totalCount: messages.length }) };
      },
    },
  } as unknown as BoxClient;
  return { client, offsets };
}

const fp = "hc:abc123";
const filler = (n: number) => Array.from({ length: n }, (_, i) => `comment ${i}`);

test("hasComment finds a fingerprint on the last page", async () => {
  const { client, offsets } = commentsClient([...filler(2000), `done\nfingerprint: ${fp}`]);
  assert.equal(await new BoxTasksTracker(client).hasComment("f", fp), true);
  assert.deepEqual(offsets, [0, 1000, 2000]);
});

test("hasComment stops paging once the fingerprint is found", async () => {
  const { client, offsets } = commentsClient([...filler(500), `done\nfingerprint: ${fp}`, ...filler(3000)]);
  assert.equal(await new BoxTasksTracker(client).hasComment("f", fp), true);
  assert.deepEqual(offsets, [0]);
});

test("hasComment walks every page and returns false when absent", async () => {
  const { client, offsets } = commentsClient(filler(2000));
  assert.equal(await new BoxTasksTracker(client).hasComment("f", fp), false);
  assert.deepEqual(offsets, [0, 1000]);
});

test("hasComment ends on an empty page when Box gives no totalCount", async () => {
  const { client, offsets } = commentsClient(filler(1500), { omitTotal: true });
  assert.equal(await new BoxTasksTracker(client).hasComment("f", fp), false);
  assert.deepEqual(offsets, [0, 1000, 1500]);
});
