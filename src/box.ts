// The one BoxClient (CCG), behind BoxGateway: every Box call the engine makes outside tasks.
// The fake implementation used by tests and FAKE_BOX=1 is in fake-box.ts.
import { Readable } from "node:stream";
import { BoxClient, BoxCcgAuth, CcgConfig } from "box-node-sdk/sdk-gen";
import type { Config } from "./config.js";
import type { BoxFile } from "./types.js";

export interface BoxGateway {
  listFiles(folderId: string): Promise<{ id: string; name: string; version: string; size: number }[]>;
  // The file's own text layer: "" for an image or a scan, which Box gives no text.
  fileText(fileId: string): Promise<string>;
  // (new) A transcription of an image or scan by Box AI. /ai/extract cannot read scanned PDFs, but
  // /ai/extract_structured can.
  ocrText(fileId: string): Promise<{ text: string; model: string }>;
  classify(fileId: string): Promise<{ docType: string; docDate?: string; author?: string; model: string }>;
  // content, when given, is read instead of the file: the OCR transcription of a scan.
  extract(fileId: string, prompt: string, content?: string): Promise<{ raw: string; model: string }>;
  getMeta(fileId: string): Promise<Record<string, string>>;
  setMeta(fileId: string, values: Record<string, string>): Promise<void>;
  appendAudit(date: string, text: string): Promise<void>;
  readAudit(date: string): Promise<string>;
  // (new) The service account's user ID, so webhook events it caused can be ignored.
  serviceUserId(): Promise<string>;
  // (new) A folder's ancestors from the root, for the audit-folder startup check.
  folderAncestors(folderId: string): Promise<string[]>;
}

export const DOC_TYPES = ["meeting notes", "memo", "email thread", "brainstorm", "policy", "spec", "other"];

// Classification fields, defined in code (spec: How it works, step 2).
export const CLASSIFY_FIELDS = [
  { key: "docType", type: "enum", displayName: "Document type",
    description: "What kind of document this is", options: DOC_TYPES.map((key) => ({ key })) },
  { key: "docDate", type: "date", displayName: "Document date",
    description: "The date the document was written or the meeting took place" },
  { key: "author", type: "string", displayName: "Author",
    description: "Who wrote the document: the note-taker, memo sender, or first email sender" },
];

export const auditFileName = (date: string) => `audit-${date}.txt`;

export type MetadataOp = { op: "add" | "replace" | "remove"; path: string; value?: string };

// Box rejects `add` once a key exists, and rejects an empty string. Use `replace` for keys already
// on the file, `add` for new ones, and `remove` to clear a key we would otherwise write as "".
export function metadataPatch(existing: Record<string, string>, values: Record<string, string>): MetadataOp[] {
  const ops: MetadataOp[] = [];
  for (const [key, value] of Object.entries(values)) {
    const path = `/${key}`;
    if (!value) {
      if (key in existing) ops.push({ op: "remove", path });
      continue;
    }
    ops.push({ op: key in existing ? "replace" : "add", path, value });
  }
  return ops;
}

const TEXT_EXTENSIONS = /\.(txt|md)$/i;

const OCR_FIELDS = [{ key: "text", type: "string", description: "The full text of the document, verbatim",
  prompt: "Transcribe all the text in the document verbatim, every page, in reading order." }];

async function streamToString(stream: Readable | undefined): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const statusCode = (err: unknown) =>
  (err as { responseInfo?: { statusCode?: number } }).responseInfo?.statusCode;

// Box AI returns 412 ("The resource has been modified") while a file is still settling after an
// upload or conversion. Retry once after a short delay; a second 412 fails the scan as before.
export async function retryOn412<T>(fn: () => Promise<T>, delayMs = 3000): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (statusCode(err) !== 412) throw err;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fn();
  }
}

function modelName(info: { models?: readonly { name?: string; provider?: string }[] } | undefined): string {
  const names = (info?.models ?? []).map((m) => m.name).filter(Boolean);
  return names.length ? names.join(", ") : "unknown";
}

export function createBoxClient(config: Config): BoxClient {
  const auth = new BoxCcgAuth({
    config: new CcgConfig({
      clientId: config.boxClientId,
      clientSecret: config.boxClientSecret,
      enterpriseId: config.boxEnterpriseId,
    }),
  });
  return new BoxClient({ auth });
}

export class RealBoxGateway implements BoxGateway {
  private auditFileIds = new Map<string, string>();

  constructor(private client: BoxClient, private auditFolderId: string) {}

  async listFiles(folderId: string): Promise<BoxFile[]> {
    const files: BoxFile[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.client.folders.getFolderItems(folderId, {
        queryParams: { fields: ["id", "name", "type", "size", "file_version"], limit: 1000, offset },
      });
      const entries = page.entries ?? [];
      for (const e of entries) {
        if (e.type !== "file") continue;
        const f = e as { id: string; name?: string; size?: number; fileVersion?: { id: string } };
        files.push({ id: f.id, name: f.name ?? "", version: f.fileVersion?.id ?? "", size: f.size ?? 0 });
      }
      offset += entries.length;
      if (!entries.length || offset >= (page.totalCount ?? 0)) return files;
    }
  }

  async fileText(fileId: string): Promise<string> {
    const file = await this.client.files.getFileById(fileId, {
      queryParams: { fields: ["name", "representations"] },
      headers: { xRepHints: "[extracted_text]" },
    });
    if (TEXT_EXTENSIONS.test(file.name ?? "")) {
      return streamToString((await this.client.downloads.downloadFile(fileId)) as Readable | undefined);
    }
    const rep = file.representations?.entries?.find((r) => r.representation === "extracted_text");
    const template = rep?.content?.urlTemplate;
    if (!template) return "";
    const authHeader = await this.client.auth.retrieveAuthorizationHeader();
    const res = await fetch(template.replace("{+asset_path}", ""), { headers: { Authorization: authHeader } });
    if (res.status === 202) throw new Error(`extracted_text for file ${fileId} is still being generated`);
    if (!res.ok) throw new Error(`extracted_text for file ${fileId}: HTTP ${res.status}`);
    return res.text();
  }

  async classify(fileId: string) {
    const res = await retryOn412(() => this.client.ai.createAiExtractStructured({
      items: [{ id: fileId, type: "file" }],
      fields: CLASSIFY_FIELDS,
    }));
    const answer = res.answer as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return {
      docType: str(answer.docType) ?? "other",
      docDate: str(answer.docDate)?.slice(0, 10),
      author: str(answer.author),
      model: modelName(res.aiAgentInfo),
    };
  }

  async ocrText(fileId: string) {
    const res = await retryOn412(() => this.client.ai.createAiExtractStructured({
      items: [{ id: fileId, type: "file" }],
      fields: OCR_FIELDS,
    }));
    const text = (res.answer as Record<string, unknown>).text;
    return { text: typeof text === "string" ? text : "", model: modelName(res.aiAgentInfo) };
  }

  async extract(fileId: string, prompt: string, content?: string) {
    const res = await retryOn412(() => this.client.ai.createAiExtract({ prompt,
      items: [{ id: fileId, type: "file", ...(content === undefined ? {} : { content }) }] }));
    return { raw: res.answer, model: modelName(res.aiAgentInfo) };
  }

  async getMeta(fileId: string): Promise<Record<string, string>> {
    try {
      const md = await this.client.fileMetadata.getFileMetadataById(fileId, "global", "properties");
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(md.extraData ?? {})) {
        if (!k.startsWith("$") && typeof v === "string") out[k] = v;
      }
      return out;
    } catch (err) {
      if ((err as { responseInfo?: { statusCode?: number } }).responseInfo?.statusCode === 404) return {};
      throw err;
    }
  }

  async setMeta(fileId: string, values: Record<string, string>): Promise<void> {
    const existing = await this.getMeta(fileId);
    const ops = metadataPatch(existing, values);
    if (!ops.length) return;
    if (Object.keys(existing).length === 0) {
      const created: Record<string, string> = {};
      for (const op of ops) if (op.value !== undefined) created[op.path.slice(1)] = op.value;
      try {
        await this.client.fileMetadata.createFileMetadataById(fileId, "global", "properties", created);
        return;
      } catch (err) {
        if (statusCode(err) !== 409) throw err;
      }
    }
    const current = Object.keys(existing).length === 0 ? await this.getMeta(fileId) : existing;
    const patch = metadataPatch(current, values);
    if (patch.length) await this.client.fileMetadata.updateFileMetadataById(fileId, "global", "properties", patch);
  }

  private async findAuditFile(date: string): Promise<string | undefined> {
    const cached = this.auditFileIds.get(date);
    if (cached) return cached;
    const name = auditFileName(date);
    const match = (await this.listFiles(this.auditFolderId)).find((f) => f.name === name);
    if (match) this.auditFileIds.set(date, match.id);
    return match?.id;
  }

  async readAudit(date: string): Promise<string> {
    const id = await this.findAuditFile(date);
    if (!id) return "";
    return streamToString((await this.client.downloads.downloadFile(id)) as Readable | undefined);
  }

  // Each append uploads a new version of the day's file. audit.ts serializes calls.
  async appendAudit(date: string, text: string): Promise<void> {
    const name = auditFileName(date);
    const id = await this.findAuditFile(date);
    if (!id) {
      const res = await this.client.uploads.uploadFile({
        attributes: { name, parent: { id: this.auditFolderId } },
        file: Readable.from(Buffer.from(text, "utf8")),
      });
      const newId = res.entries?.[0]?.id;
      if (newId) this.auditFileIds.set(date, newId);
      return;
    }
    const current = await this.readAudit(date);
    await this.client.uploads.uploadFileVersion(id, {
      attributes: { name },
      file: Readable.from(Buffer.from(current + text, "utf8")),
    });
  }

  async serviceUserId(): Promise<string> {
    return (await this.client.users.getUserMe()).id;
  }

  async folderAncestors(folderId: string): Promise<string[]> {
    const folder = await this.client.folders.getFolderById(folderId, { queryParams: { fields: ["path_collection"] } });
    return (folder.pathCollection?.entries ?? []).map((e) => e.id);
  }
}
