// (new) The first-hour probes from the work breakdown, one call each, as the service account.
// Read-only by default; `-- --write` also posts a comment and uploads a new version of a scratch
// file in the audit folder (deleted afterwards). Run with: npx tsx scripts/probe.ts
import { Readable } from "node:stream";
import { createBoxClient, RealBoxGateway } from "../src/box.js";
import { loadConfig } from "../src/config.js";
import { buildPrompt, loadPrompt } from "../src/engine/extract.js";
import { loadPeople, peopleNames } from "../src/engine/normalize.js";
import { BoxTasksTracker } from "../src/trackers/box-tasks.js";

const write = process.argv.includes("--write");
const config = loadConfig();
const client = createBoxClient(config);
const gateway = new RealBoxGateway(client, config.auditFolderId);
const tracker = new BoxTasksTracker(client);

async function probe(name: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    console.log(`PASS ${name}: ${typeof out === "string" ? out : JSON.stringify(out)?.slice(0, 300)}`);
  } catch (err) {
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const me = await client.users.getUserMe();
console.log(`Service account: ${me.name} (${me.login}, ${me.id})`);
const files = await gateway.listFiles(config.scanFolderId);
console.log(`Scan folder has ${files.length} files`);
const md = files.find((f) => f.name.endsWith(".md"));
const other = files.find((f) => !/\.(md|txt)$/i.test(f.name));

await probe("audit folder outside scan folder", async () => (await gateway.folderAncestors(config.auditFolderId)).join(" > "));
if (md) {
  await probe(`classify ${md.name}`, () => gateway.classify(md.id));
  await probe(`extract ${md.name} (note the AI units used)`, async () => {
    const prompt = buildPrompt(loadPrompt(), config.orgName, peopleNames(loadPeople()));
    return (await gateway.extract(md.id, prompt)).raw.slice(0, 200);
  });
  await probe(`file text of ${md.name}`, async () => `${(await gateway.fileText(md.id)).length} characters`);
  await probe(`tasks and assignments on ${md.name}`, () => tracker.listTasks(md.id));
}
await probe("extracted_text on a non-text file", async () =>
  other ? `${(await gateway.fileText(other.id)).length} characters from ${other.name}` : "skipped: no non-text file in the folder");
await probe("metadata read", async () => (md ? gateway.getMeta(md.id) : "skipped"));

if (write) {
  const up = await client.uploads.uploadFile({
    attributes: { name: `probe-${Date.now()}.txt`, parent: { id: config.auditFolderId } },
    file: Readable.from(Buffer.from("Herding Cats probe\n")),
  });
  const scratch = up.entries![0].id;
  await probe("post a comment", () => tracker.comment(scratch, "Herding Cats probe comment"));
  await probe("create and assign a task", () => tracker.createTask(scratch, "Herding Cats probe task", me.id));
  await probe("upload a new file version", () => client.uploads.uploadFileVersion(scratch, {
    attributes: { name: up.entries![0].name! }, file: Readable.from(Buffer.from("Herding Cats probe v2\n")) }));
  await probe("delete the scratch file", () => client.files.deleteFileById(scratch));
}
console.log("Create the webhook in the Developer Console or with client.webhooks.createWebhook once the AWS URL exists.");
