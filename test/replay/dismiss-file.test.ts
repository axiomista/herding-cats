// Dismissing a file the cycle could not process: logged, hidden, and skipped until a new version.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatFileDismissal } from "../../src/audit.js";
import { CycleRunner, runCycle } from "../../src/engine/cycle.js";
import { fakeEngine } from "../../src/fake-box.js";
import { createApp } from "../../src/server.js";

const fileId = (k: string): string => JSON.parse(readFileSync(`test/fixtures/v1/${k}.json`, "utf8")).file.id;
const UNPROCESSABLE = "422 unprocessable_entity Unprocessable Entity";

test("formatFileDismissal writes a DISMISSED block in the audit layout", () => {
  assert.equal(formatFileDismissal({
    time: "2026-10-19T02:51:00Z", fileId: "42", fileName: "Plan.pdf", fileVersion: "7", error: UNPROCESSABLE,
  }), `2026-10-18 19:51:00 PT  click  DISMISSED
change:      file error dismissed; this version is skipped until a new version is uploaded
file:        "Plan.pdf" (file 42, version 7)
error:       ${UNPROCESSABLE}
outcome:     ok`);
});

async function setup() {
  const { engine, box } = await fakeEngine({ mode: "dry-run" });
  const id = fileId("handbook");
  const tries = { count: 0 };
  const classify = box.classify.bind(box);
  box.classify = async (f: string) => {
    if (f === id) { tries.count++; throw new Error(UNPROCESSABLE); }
    return classify(f);
  };
  const runner = new CycleRunner(engine);
  const server = createApp(engine, runner, { secureCookies: false, serviceUserId: "svc" }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signIn = await fetch(`${base}/api/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "test" }),
  });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  const dismiss = (f: string) => fetch(`${base}/api/files/${f}/dismiss-error`, { method: "POST", headers: { cookie } });
  return { engine, box, id, tries, server, dismiss };
}

test("a dismissed file is logged, hidden and not retried until a new version", async (t) => {
  const { engine, box, id, tries, server, dismiss } = await setup();
  t.after(() => server.close());
  await runCycle(engine, "all", { trigger: "full_scan", full: true });
  assert.deepEqual(engine.state.toAppState().errors, [{ fileId: id, message: UNPROCESSABLE }]);

  const res = await dismiss(id);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "dismissed" });
  assert.deepEqual(engine.state.toAppState().errors, []);
  const audit = [...box.audit.values()].join("");
  assert.match(audit, /click {2}DISMISSED\n/);
  assert.ok(audit.includes(`file ${id}, version `) && audit.includes(`error:       ${UNPROCESSABLE}`));

  await runCycle(engine, "all", { trigger: "full_scan", full: true });
  assert.equal(tries.count, 1, "the dismissed file costs no AI call on the next full scan");
  assert.deepEqual(engine.state.toAppState().errors, []);

  box.uploadVersion(id, box.texts.get(id)!);
  await runCycle(engine, [id], { trigger: "webhook" });
  assert.equal(engine.state.dismissedFiles.has(id), false, "a new version ends the dismissal");
  assert.equal(tries.count, 2);
  assert.deepEqual(engine.state.toAppState().errors, [{ fileId: id, message: UNPROCESSABLE }]);
});

test("a dismissal the audit log cannot record does not take effect", async (t) => {
  const { engine, box, id, server, dismiss } = await setup();
  t.after(() => server.close());
  await runCycle(engine, "all", { trigger: "full_scan", full: true });
  box.appendAudit = async () => { throw new Error("Box 503"); };

  const res = await dismiss(id);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /audit log could not be written \(Box 503\)/);
  assert.equal(engine.state.dismissedFiles.has(id), false);
  assert.deepEqual(engine.state.toAppState().errors, [{ fileId: id, message: UNPROCESSABLE }]);
});

test("only a file the page shows as failed can be dismissed", async (t) => {
  const { engine, server, dismiss } = await setup();
  t.after(() => server.close());
  await runCycle(engine, "all", { trigger: "full_scan", full: true });
  assert.equal((await dismiss(fileId("memo"))).status, 404);
});
