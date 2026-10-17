// (new) A fake Box for tests and FAKE_BOX=1: the seed documents, the planted tasks from the
// answer key, and recorded AI answers from test/fixtures/. It never touches the network and logs
// every write so tests can check what the app would have done.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BoxGateway } from "./box.js";
import { auditFileName } from "./box.js";
import { RETRY_NOTE } from "./engine/extract.js";
import { commentCarriesFingerprint } from "./engine/match.js";
import type { People } from "./engine/normalize.js";
import type { BoxFile, TrackerAdapter, TrackerTask } from "./types.js";

export interface Fixture {
  promptVersion: string;
  file: { id: string; name: string; version: string };
  classify: { docType: string; docDate?: string; author?: string; model: string };
  extract: { raw: string; model: string }[]; // the first answer, then the answer to the retry
}

export type FakeWrite =
  | { op: "createTask"; fileId: string; taskId: string; message: string; due?: string }
  | { op: "assign"; taskId: string; assigneeId: string }
  | { op: "comment"; fileId: string; text: string; commentId: string }
  | { op: "setMeta"; fileId: string; values: Record<string, string> }
  | { op: "appendAudit"; date: string; text: string };

export function loadFixtures(dir: string): Fixture[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture);
}

interface AnswerKeyTask { id: string; file: string; assignee: string; due: string; message: string }

export interface FakeBoxOptions {
  fixturesDir?: string;
  docsDir?: string;
  answerKeyPath?: string;
  people: People;
  auditFolderId: string;
  latencyMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeBox implements BoxGateway, TrackerAdapter {
  fixtures = new Map<string, Fixture>();
  texts = new Map<string, string>();
  tasks: TrackerTask[] = [];
  comments = new Map<string, string[]>();
  meta = new Map<string, Record<string, string>>();
  audit = new Map<string, string>();
  writes: FakeWrite[] = [];
  aiCalls = 0;
  private nextTaskId = 1;
  private nextCommentId = 1;
  private latencyMs: number;

  constructor(private opts: FakeBoxOptions) {
    const fixturesDir = opts.fixturesDir ?? "test/fixtures/v1";
    const docsDir = opts.docsDir ?? "seed/docs";
    this.latencyMs = opts.latencyMs ?? 0;
    for (const fx of loadFixtures(fixturesDir)) {
      this.fixtures.set(fx.file.id, fx);
      this.texts.set(fx.file.id, readFileSync(join(docsDir, fx.file.name), "utf8"));
    }
    const key = JSON.parse(readFileSync(opts.answerKeyPath ?? "seed/answer_key.json", "utf8")) as
      { files: Record<string, string>; tasks: AnswerKeyTask[] };
    const idByName = new Map([...this.fixtures.values()].map((fx) => [fx.file.name, fx.file.id]));
    for (const t of key.tasks) {
      const fileId = idByName.get(key.files[t.file]);
      if (!fileId) continue;
      const assignee = opts.people.users[t.assignee];
      this.tasks.push({ id: `seed-${t.id}`, fileId, message: t.message,
        assigneeIds: assignee ? [assignee] : [], due: t.due, completed: false });
    }
  }

  // Simulates a new version of a file: new text and, optionally, new recorded answers.
  uploadVersion(fileId: string, text: string, extract?: Fixture["extract"]): void {
    const fx = this.fixtures.get(fileId)!;
    fx.file.version = String(Number(fx.file.version) + 1);
    this.texts.set(fileId, text);
    if (extract) fx.extract = extract;
  }

  private async ai(): Promise<void> {
    this.aiCalls++;
    if (this.latencyMs) await sleep(this.latencyMs);
  }

  private fixture(fileId: string): Fixture {
    const fx = this.fixtures.get(fileId);
    if (!fx) throw new Error(`No fixture for file ${fileId}`);
    return fx;
  }

  // BoxGateway

  async listFiles(folderId: string): Promise<BoxFile[]> {
    if (folderId === this.opts.auditFolderId) {
      return [...this.audit.keys()].map((date) => ({ id: `audit-${date}`, name: auditFileName(date), version: "1",
        size: Buffer.byteLength(this.audit.get(date)!) }));
    }
    return [...this.fixtures.values()].map(({ file }) => ({ ...file,
      size: Buffer.byteLength(this.texts.get(file.id) ?? "") }));
  }

  async fileText(fileId: string): Promise<string> { return this.texts.get(fileId) ?? ""; }

  async classify(fileId: string) {
    await this.ai();
    return { ...this.fixture(fileId).classify };
  }

  async extract(fileId: string, prompt: string) {
    await this.ai();
    const answers = this.fixture(fileId).extract;
    return answers[prompt.includes(RETRY_NOTE) ? answers.length - 1 : 0];
  }

  async getMeta(fileId: string) { return { ...(this.meta.get(fileId) ?? {}) }; }

  async setMeta(fileId: string, values: Record<string, string>) {
    this.meta.set(fileId, { ...(this.meta.get(fileId) ?? {}), ...values });
    this.writes.push({ op: "setMeta", fileId, values });
  }

  async appendAudit(date: string, text: string) {
    this.audit.set(date, (this.audit.get(date) ?? "") + text);
    this.writes.push({ op: "appendAudit", date, text });
  }

  async readAudit(date: string) { return this.audit.get(date) ?? ""; }

  async serviceUserId() { return "fake-service-account"; }

  async folderAncestors() { return ["0"]; }

  // TrackerAdapter

  async listTasks(fileId: string): Promise<TrackerTask[]> {
    return this.tasks.filter((t) => t.fileId === fileId).map((t) => ({ ...t, assigneeIds: [...t.assigneeIds] }));
  }

  async createTask(fileId: string, message: string, assigneeId?: string, due?: string): Promise<TrackerTask> {
    const task: TrackerTask = { id: `new-${this.nextTaskId++}`, fileId, message, assigneeIds: [], due, completed: false };
    this.tasks.push(task);
    this.writes.push({ op: "createTask", fileId, taskId: task.id, message, due });
    if (assigneeId) {
      task.assigneeIds.push(assigneeId);
      this.writes.push({ op: "assign", taskId: task.id, assigneeId });
    }
    return { ...task, assigneeIds: [...task.assigneeIds] };
  }

  async comment(fileId: string, text: string): Promise<string> {
    const commentId = `c${this.nextCommentId++}`;
    this.comments.set(fileId, [...(this.comments.get(fileId) ?? []), text]);
    this.writes.push({ op: "comment", fileId, text, commentId });
    return commentId;
  }

  async hasComment(fileId: string, fingerprint: string): Promise<boolean> {
    return (this.comments.get(fileId) ?? []).some((c) => commentCarriesFingerprint(c, fingerprint));
  }
}

export const fixturesExist = (dir = "test/fixtures/v1") => {
  try { return statSync(dir).isDirectory(); } catch { return false; }
};

// Wires an engine to a FakeBox with config defaults, for tests and FAKE_BOX=1.
export async function fakeEngine(overrides: { mode?: "dry-run" | "apply"; latencyMs?: number; now?: () => Date;
  fixturesDir?: string; } = {}) {
  const { loadConfig } = await import("./config.js");
  const { loadPeople } = await import("./engine/normalize.js");
  const { loadPrompt } = await import("./engine/extract.js");
  const { State } = await import("./state.js");
  const { AuditLog } = await import("./audit.js");
  const config = loadConfig({ FAKE_BOX: "1", DEMO_PASSCODE: "test", MODE: overrides.mode ?? "dry-run" });
  const people = loadPeople();
  const box = new FakeBox({ people, auditFolderId: config.auditFolderId, latencyMs: overrides.latencyMs,
    fixturesDir: overrides.fixturesDir });
  const state = new State(config.mode);
  const engine = {
    config, gateway: box, tracker: box, people, state, audit: new AuditLog(box),
    promptTemplate: loadPrompt(), now: overrides.now ?? (() => new Date()),
  };
  return { engine, box };
}
