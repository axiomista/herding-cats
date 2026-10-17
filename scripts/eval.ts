// npm run eval: scans the live folder in dry run and scores it against the answer key.
// `npm run eval -- --record` also saves each file's AI answers under the prompt version, as
// fixtures for the replay test. Uses AI units: run it after prompt or matching changes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { runCycle } from "../src/engine/cycle.js";
import { PROMPT_VERSION } from "../src/engine/extract.js";
import type { Fixture } from "../src/fake-box.js";
import { type AnswerKey, score } from "../src/score.js";
import { buildEngine } from "../src/server.js";

const record = process.argv.includes("--record");
const key = JSON.parse(readFileSync("seed/answer_key.json", "utf8")) as AnswerKey;

const config = loadConfig({ ...process.env, MODE: "dry-run" });
const engine = await buildEngine(config);
engine.state.mode = "dry-run"; // eval never writes to Box

const recorded = new Map<string, Fixture>();
if (record) {
  const real = engine.gateway;
  const files = new Map((await real.listFiles(config.scanFolderId)).map((f) => [f.id, f]));
  const fixture = (id: string): Fixture => {
    let fx = recorded.get(id);
    if (!fx) {
      const f = files.get(id)!;
      fx = { promptVersion: PROMPT_VERSION, file: { id, name: f.name, version: f.version },
        classify: { docType: "other", model: "" }, extract: [] };
      recorded.set(id, fx);
    }
    return fx;
  };
  engine.gateway = {
    listFiles: (id) => real.listFiles(id),
    fileText: (id) => real.fileText(id),
    getMeta: (id) => real.getMeta(id),
    setMeta: (id, v) => real.setMeta(id, v),
    appendAudit: (d, t) => real.appendAudit(d, t),
    readAudit: (d) => real.readAudit(d),
    serviceUserId: () => real.serviceUserId(),
    folderAncestors: (id) => real.folderAncestors(id),
    classify: async (id) => { const r = await real.classify(id); fixture(id).classify = r; return r; },
    extract: async (id, prompt) => { const r = await real.extract(id, prompt); fixture(id).extract.push(r); return r; },
  };
}

const started = Date.now();
const summary = await runCycle(engine, "all", { trigger: "full_scan", full: true });
const report = score(engine.state.toAppState(), key);
console.log(JSON.stringify({ seconds: (Date.now() - started) / 1000, summary, report }, null, 2));

if (record) {
  const dir = `test/fixtures/${PROMPT_VERSION}`;
  mkdirSync(dir, { recursive: true });
  const keyByName = new Map(Object.entries((key as unknown as { files: Record<string, string> }).files).map(([k, n]) => [n, k]));
  for (const fx of recorded.values()) {
    const name = keyByName.get(fx.file.name) ?? fx.file.id;
    writeFileSync(`${dir}/${name}.json`, `${JSON.stringify(fx, null, 2)}\n`);
  }
  console.log(`Recorded ${recorded.size} fixtures in ${dir}`);
}

const pass = report.recall.found === report.recall.total && report.recall.c01Count === 1
  && report.falsePositives.count <= 1 && report.tasks.every((t) => t.ok) && !report.untracked.missing.length;
process.exit(pass ? 0 : 1);
