import assert from "node:assert/strict";
import { test } from "node:test";
import { retryOn412 } from "../../src/box.js";

const boxError = (statusCode: number) => Object.assign(new Error(`${statusCode}`), { responseInfo: { statusCode } });

test("a 412 is retried once and the second answer is returned", async () => {
  let calls = 0;
  const result = await retryOn412(async () => {
    if (++calls === 1) throw boxError(412);
    return "ok";
  }, 0);
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("a second 412 fails", async () => {
  let calls = 0;
  await assert.rejects(retryOn412(async () => { calls++; throw boxError(412); }, 0), /412/);
  assert.equal(calls, 2);
});

test("other errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(retryOn412(async () => { calls++; throw boxError(500); }, 0), /500/);
  assert.equal(calls, 1);
});
