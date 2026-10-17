import assert from "node:assert/strict";
import { test } from "node:test";
import { fileIdsFromEvent, signBody, verifyBoxSignature } from "../../src/triggers/webhook.js";

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

test("events map to the uploaded file or the task's file", () => {
  assert.deepEqual(fileIdsFromEvent({ source: { id: "123", type: "file" } }), ["123"]);
  assert.deepEqual(fileIdsFromEvent({ source: { id: "9", type: "task_assignment", item: { id: "456", type: "file" } } }), ["456"]);
  assert.deepEqual(fileIdsFromEvent({ source: { id: "7", type: "folder" } }), []);
});
