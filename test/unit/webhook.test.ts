import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebhookHandler, fileIdsFromEvent, signBody, verifyBoxSignature } from "../../src/triggers/webhook.js";

const keys = { primary: "primary-key", secondary: "secondary-key" };
const now = new Date("2026-10-17T17:00:00Z");
const body = Buffer.from(JSON.stringify({ id: "evt-1", trigger: "FILE.UPLOADED", source: { id: "123", type: "file" } }));
const ts = "2026-10-17T16:58:00Z";
const headers = (h: Record<string, string>) => ({ "box-delivery-timestamp": ts, ...h });

test("valid primary signature", () => {
  assert.equal(verifyBoxSignature(body, headers({ "box-signature-primary": signBody(body, ts, keys.primary) }), keys, now), true);
});

test("valid secondary signature (primary key rotated)", () => {
  const h = headers({ "box-signature-primary": signBody(body, ts, "old-primary"), "box-signature-secondary": signBody(body, ts, keys.secondary) });
  assert.equal(verifyBoxSignature(body, h, keys, now), true);
});

test("bad signature", () => {
  assert.equal(verifyBoxSignature(body, headers({ "box-signature-primary": signBody(body, ts, "wrong") }), keys, now), false);
  assert.equal(verifyBoxSignature(body, headers({ "box-signature-primary": "not-base64-at-all" }), keys, now), false);
  assert.equal(verifyBoxSignature(body, headers({}), keys, now), false);
  // A valid signature for a different body.
  const other = Buffer.from(`${body.toString()} `);
  assert.equal(verifyBoxSignature(other, headers({ "box-signature-primary": signBody(body, ts, keys.primary) }), keys, now), false);
});

test("stale timestamp", () => {
  const old = "2026-10-17T16:49:59Z"; // 10 minutes and 1 second earlier
  const h = { "box-delivery-timestamp": old, "box-signature-primary": signBody(body, old, keys.primary) };
  assert.equal(verifyBoxSignature(body, h, keys, now), false);
  const edge = "2026-10-17T16:50:00Z";
  assert.equal(verifyBoxSignature(body, { "box-delivery-timestamp": edge, "box-signature-primary": signBody(body, edge, keys.primary) }, keys, now), true);
  assert.equal(verifyBoxSignature(body, { "box-signature-primary": signBody(body, "", keys.primary) }, keys, now), false);
});

test("the handler answers immediately, ignores own events, and drops duplicate ids", () => {
  const queued: string[][] = [];
  const handler = createWebhookHandler({
    keys, now: () => now,
    serviceUserId: "service-account",
    runner: { enqueue: (ids) => { queued.push(ids === "all" ? [] : ids); } },
  });
  const deliver = (event: unknown, id = "evt-1") => {
    const raw = Buffer.from(JSON.stringify(event));
    const res = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; } };
    handler({ body: raw, headers: headers({ "box-delivery-id": id, "box-signature-primary": signBody(raw, ts, keys.primary) }) } as never, res as never);
    return res;
  };
  const uploaded = deliver({ id: "evt-1", created_by: { id: "someone" }, source: { id: "123", type: "file" } });
  assert.equal(uploaded.statusCode, 200);
  assert.deepEqual(uploaded.body, { queued: 1 });
  assert.deepEqual(queued, [["123"]]);
  const own = deliver({ id: "evt-2", created_by: { id: "service-account" }, source: { id: "123", type: "file" } }, "evt-2");
  assert.deepEqual(own.body, { queued: 0, ignored: "own event" });
  const again = deliver({ id: "evt-1", created_by: { id: "someone" }, source: { id: "123", type: "file" } });
  assert.deepEqual(again.body, { queued: 0, duplicate: true });
  assert.equal(queued.length, 1);
});

test("events map to the uploaded file or the task's file", () => {
  assert.deepEqual(fileIdsFromEvent({ source: { id: "123", type: "file" } }), ["123"]);
  assert.deepEqual(fileIdsFromEvent({ source: { id: "9", type: "task_assignment", item: { id: "456", type: "file" } } }), ["456"]);
  assert.deepEqual(fileIdsFromEvent({ source: { id: "7", type: "folder" } }), []);
});
