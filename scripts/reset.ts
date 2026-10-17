// (new) Clears what the app left on the scan folder's files, so a demo run starts fresh:
// the service account's "Herding Cats:" comments (otherwise the fingerprint check skips them on
// the next apply-mode run) and the hc* fields in global/properties metadata (scan markers).
// Tasks are seed_tasks.py --reset's job; audit files are kept.
// Lists what it would remove by default; `-- --yes` removes it. Run with: npx tsx scripts/reset.ts
import { createBoxClient, RealBoxGateway } from "../src/box.js";
import { loadConfig } from "../src/config.js";

const apply = process.argv.includes("--yes");
const config = loadConfig();
const client = createBoxClient(config);
const gateway = new RealBoxGateway(client, config.auditFolderId);

const me = await gateway.serviceUserId();
const files = await gateway.listFiles(config.scanFolderId);
let comments = 0;
let metaFiles = 0;

for (const file of files) {
  const page = await client.comments.getFileComments(file.id, {
    queryParams: { fields: ["message", "created_by"], limit: 1000 },
  });
  const ours = (page.entries ?? []).filter((c) =>
    c.createdBy?.id === me && (c.message ?? "").startsWith("Herding Cats:"));
  for (const c of ours) {
    console.log(`${apply ? "delete" : "would delete"} comment ${c.id} on "${file.name}"`);
    if (apply) await client.comments.deleteCommentById(c.id!);
  }
  comments += ours.length;

  const meta = await gateway.getMeta(file.id);
  const keys = Object.keys(meta).filter((k) => k.startsWith("hc"));
  if (!keys.length) continue;
  console.log(`${apply ? "clear" : "would clear"} ${keys.join(", ")} on "${file.name}"`);
  if (apply) {
    // Remove the whole instance only if it holds nothing but our fields.
    if (keys.length === Object.keys(meta).length) {
      await client.fileMetadata.deleteFileMetadataById(file.id, "global", "properties");
    } else {
      await client.fileMetadata.updateFileMetadataById(file.id, "global", "properties",
        keys.map((k) => ({ op: "remove" as const, path: `/${k}` })));
    }
  }
  metaFiles++;
}

console.log(`${apply ? "Removed" : "Would remove"} ${comments} comment(s) and hc* metadata on ${metaFiles} file(s) ` +
  `across ${files.length} file(s).${apply ? "" : " Run with -- --yes to remove them."}`);
