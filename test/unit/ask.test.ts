// "Ask Box AI" on a finding: which files it reads, what it asks, and that it is read-only and cached.
import assert from "node:assert/strict";
import { test } from "node:test";
import { askAboutFinding, askFiles, askPrompt } from "../../src/engine/ask.js";
import { runCycle } from "../../src/engine/cycle.js";
import { fakeEngine } from "../../src/fake-box.js";

async function scanned() {
  const made = await fakeEngine({ mode: "apply" });
  await runCycle(made.engine, "all", { trigger: "full_scan", full: true });
  made.box.writes = []; // the scan's own writes are not under test here
  return made;
}

const byBucket = (engine: Awaited<ReturnType<typeof scanned>>["engine"], bucket: string) => {
  const f = engine.state.findings.find((x) => x.bucket === bucket);
  assert.ok(f, `a ${bucket} finding`);
  return f;
};

test("ask reads the files behind the finding", async () => {
  const { engine } = await scanned();
  const superseded = byBucket(engine, "superseded");
  const files = askFiles(superseded, engine.state);
  const c = superseded.commitment!;
  assert.ok(files.includes(c.fileId), "the commitment's file");
  assert.ok(files.includes(c.statusEvidence!.fileId), "the file that cancelled it");
  assert.equal(new Set(files).size, files.length, "no file twice");

  const orphan = byBucket(engine, "orphan");
  assert.equal(askFiles(orphan, engine.state).length, engine.state.files.size, "an orphan reads the whole folder");
});

test("ask names the finding, the evidence and the task, and asks the bucket's question", async () => {
  const { engine } = await scanned();
  const f = byBucket(engine, "date_conflict");
  const prompt = askPrompt(f, engine.state, engine.people);
  assert.match(prompt, /^Finding: Date conflict/m);
  assert.match(prompt, new RegExp(`^Evidence: "${f.commitment!.evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "m"));
  assert.match(prompt, /^Task: "Install 12 sunbeam lamps on Floor 3"\. Assigned to: .+\. Due: 2026-11-21\./m);
  assert.match(prompt, /when is this commitment due/);
  assert.ok(prompt.length < 10_000, "Box AI Ask limits prompts to 10,000 characters");
});

test("ask is read-only, counts one AI call, and answers again from memory", async () => {
  const { engine, box } = await scanned();
  const f = byBucket(engine, "untracked");
  const calls = engine.state.aiCallsThisMonth;
  const [first, second] = await Promise.all([askAboutFinding(engine, f), askAboutFinding(engine, f)]);
  assert.equal(first, second, "a double click asks once");
  assert.equal(box.asks.length, 1);
  assert.equal(engine.state.aiCallsThisMonth, calls + 1);
  assert.deepEqual(box.writes, [], "asking writes nothing to Box");
  assert.equal(first.citations[0]?.content, f.commitment!.evidence);

  await askAboutFinding(engine, f);
  assert.equal(box.asks.length, 1, "a second ask is answered from memory");
  assert.equal(engine.state.toAppState().asks?.[f.fingerprint], first, "the page sees the answer");
});
