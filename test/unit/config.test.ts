import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../src/config.js";

const env = { FAKE_BOX: "1", DEMO_PASSCODE: "meow" };

test("sweeps are on unless SWEEPS_ENABLED is false", () => {
  assert.equal(loadConfig(env).sweepsEnabled, true);
  assert.equal(loadConfig({ ...env, SWEEPS_ENABLED: "true" }).sweepsEnabled, true);
  assert.equal(loadConfig({ ...env, SWEEPS_ENABLED: "false" }).sweepsEnabled, false);
});

test("SWEEPS_ENABLED rejects anything but true or false", () => {
  assert.throws(() => loadConfig({ ...env, SWEEPS_ENABLED: "off" }), /SWEEPS_ENABLED must be true or false/);
});
