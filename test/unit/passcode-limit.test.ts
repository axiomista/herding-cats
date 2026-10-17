import assert from "node:assert/strict";
import { test } from "node:test";
import { PasscodeLimiter } from "../../src/passcode-limit.js";

const minute = 60 * 1000;

test("blocks an address after 10 wrong passcodes in 15 minutes", () => {
  const limiter = new PasscodeLimiter();
  for (let i = 0; i < 9; i++) limiter.fail("1.2.3.4", i * minute);
  assert.equal(limiter.retryAfter("1.2.3.4", 9 * minute), 0);
  limiter.fail("1.2.3.4", 9 * minute);
  // The first failure, at minute 0, leaves the window at minute 15.
  assert.equal(limiter.retryAfter("1.2.3.4", 10 * minute), 5 * 60);
  assert.equal(limiter.retryAfter("5.6.7.8", 10 * minute), 0);
  assert.equal(limiter.retryAfter("1.2.3.4", 15 * minute), 0);
});

test("a correct passcode clears the address's failures", () => {
  const limiter = new PasscodeLimiter(2, 15 * minute);
  limiter.fail("1.2.3.4", 0);
  limiter.succeed("1.2.3.4");
  limiter.fail("1.2.3.4", minute);
  assert.equal(limiter.retryAfter("1.2.3.4", minute), 0);
});
