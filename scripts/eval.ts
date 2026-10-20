// npm run eval: scans the live folder in dry run and scores it against the answer key.
// `npm run eval -- --record` saves each file's AI answers under test/fixtures/<version>-live/.
// `--record-dir <dir>` chooses another folder. Neither path may be the hand-written guard
// fixtures in test/fixtures/<version>/. `-- --state <file>` saves the full findings as JSON.
// When seed/answer_key_formats.json exists, the format corpus is scored too. `-- --runs <n>`
// repeats the scan n times, each with a fresh engine, and prints which results changed between runs.
// Uses AI units: run it after prompt or matching changes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { inventory, runCycle } from "../src/engine/cycle.js";
import { PROMPT_VERSION } from "../src/engine/extract.js";
import type { Fixture } from "../src/fake-box.js";
import { type AnswerKey, type FormatsKey, type FormatsReport, type ScoreReport, score, scoreFormats } from "../src/score.js";
import { buildEngine } from "../src/server.js";

const recordDir = (): string | undefined => {
  const flag = process.argv.indexOf("--record-dir");
  const requested = flag > 0 ? process.argv[flag + 1] : undefined;
  if (!process.argv.includes("--record") && !requested) return undefined;
  const dir = requested ?? `test/fixtures/${PROMPT_VERSION}-live`;
  const guarded = `test/fixtures/${PROMPT_VERSION}`;
  if (!dir || dir.replace(/\/+$/, "") === guarded) {
    throw new Error(`Refusing to record into ${guarded}; that folder holds the hand-written guard fixtures. Use --record-dir.`);
  }
  return dir;
};
const record = recordDir();
const stateArg = process.argv.indexOf("--state");
const statePath = stateArg > 0 ? process.argv[stateArg + 1] : undefined;
const key = JSON.parse(readFileSync("seed/answer_key.json", "utf8")) as AnswerKey;
const FORMATS_KEY = "seed/answer_key_formats.json";
const formatsKey = existsSync(FORMATS_KEY) ? JSON.parse(readFileSync(FORMATS_KEY, "utf8")) as FormatsKey : undefined;
const runsArg = process.argv.indexOf("--runs");
const runs = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 1;
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive whole number");
if (runs > 1 && record) throw new Error("--record saves one run's answers; drop --runs");

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

type Run = { seconds: number; summary: Awaited<ReturnType<typeof runCycle>>; report: ScoreReport; formats?: FormatsReport };

async function scan(e: typeof engine): Promise<Run> {
  const started = Date.now();
  const summary = await runCycle(e, "all", { trigger: "full_scan", full: true });
  const state = e.state.toAppState();
  const scanned = new Set(inventory(await e.gateway.listFiles(config.scanFolderId), config.maxFileBytes).map((f) => f.id));
  return { seconds: (Date.now() - started) / 1000, summary, report: score(state, key),
    formats: formatsKey && scoreFormats(state, formatsKey, scanned) };
}

const results: Run[] = [];
for (let i = 0; i < runs; i++) {
  const e = i === 0 ? engine : await buildEngine(config);
  e.state.mode = "dry-run";
  results.push(await scan(e));
  if (i === 0 && statePath) writeFileSync(statePath, `${JSON.stringify(engine.state.toAppState(), null, 2)}\n`);
}
console.log(JSON.stringify(runs === 1 ? results[0] : results, null, 2));

if (record) {
  const dir = record;
  mkdirSync(dir, { recursive: true });
  const keyByName = new Map(Object.entries((key as unknown as { files: Record<string, string> }).files).map(([k, n]) => [n, k]));
  for (const fx of recorded.values()) {
    const name = keyByName.get(fx.file.name) ?? fx.file.id;
    writeFileSync(`${dir}/${name}.json`, `${JSON.stringify(fx, null, 2)}\n`);
  }
  console.log(`Recorded ${recorded.size} fixtures in ${dir}`);
}

const seedPass = (r: ScoreReport) => r.recall.found === r.recall.total && r.recall.c01Count === 1
  && r.falsePositives.count <= 1 && r.tasks.every((t) => t.ok) && !r.untracked.missing.length;
// Conditional expectations (ok undefined) are reported but never fail the run.
const formatsPass = (f?: FormatsReport) => !f || ![...f.commitments, ...f.files].some((x) => x.ok === false);

// One line per result, one column per run, so a result that changed between runs stands out.
const observed = (o: FormatsReport["commitments"][number]["observed"]) =>
  o.state === "finding" ? `${o.bucket}/${o.certainty}${o.fuzzy ? "~" : ""}` : o.state;
const mark = (ok?: boolean) => ok === undefined ? "?" : ok ? "ok" : "FAIL";
const rows: [string, string[]][] = [
  ["seed recall", results.map((r) => `${r.report.recall.found}/${r.report.recall.total}`)],
  ["seed false positives", results.map((r) => String(r.report.falsePositives.count))],
  ...key.tasks.map((t): [string, string[]] => [t.id, results.map((r) => {
    const x = r.report.tasks.find((y) => y.id === t.id)!; return `${x.actual ?? "-"} ${mark(x.ok)}`; })]),
  ...(formatsKey?.commitments ?? []).map((a): [string, string[]] => [`${a.id} ${a.source}`, results.map((r) => {
    const x = r.formats!.commitments.find((y) => y.id === a.id)!; return `${observed(x.observed)} ${mark(x.ok)}`; })]),
  ...Object.keys(formatsKey?.files ?? {}).map((k): [string, string[]] => [`file ${k}`, results.map((r) => {
    const x = r.formats!.files.find((y) => y.source === k)!; return `${x.actual.slice(0, 40)} ${mark(x.ok)}`; })]),
  ...(formatsKey ? [["format false positives", results.map((r) => String(r.formats!.falsePositives.length))] as [string, string[]]] : []),
  ["pass", results.map((r) => seedPass(r.report) && formatsPass(r.formats) ? "yes" : "no")],
];
const width = Math.max(...rows.map(([label]) => label.length));
for (const [label, cells] of rows) {
  const changed = new Set(cells).size > 1 ? "  <- changed" : "";
  console.error(`${label.padEnd(width)}  ${cells.join(" | ")}${changed}`);
}

process.exit(results.every((r) => seedPass(r.report) && formatsPass(r.formats)) ? 0 : 1);
