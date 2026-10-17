// Box AI calls and the extraction prompt (spec: How it works, steps 2 and 3).
import { readFileSync } from "node:fs";
import type { BoxGateway } from "../box.js";
import type { ExtractedItem } from "../types.js";

export const PROMPT_VERSION = "v1";

// Appended to the prompt on the one retry after invalid JSON. The fake gateway keys on it.
export const RETRY_NOTE = "Your previous reply was not a valid JSON array";

const KINDS = new Set(["commitment", "status_change", "decision", "idea", "open_question"]);
const STATUSES = new Set(["cancelled", "completed", "rescheduled", "reassigned"]);

export function loadPrompt(version = PROMPT_VERSION, dir = "prompts"): string {
  return readFileSync(`${dir}/extract-${version}.txt`, "utf8");
}

export function buildPrompt(template: string, orgName: string, peopleNames: string[]): string {
  return template.replaceAll("{org_name}", orgName).replaceAll("{people_names}", peopleNames.join(", "));
}

const optional = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : undefined;

// The model does not always return only the array: it may wrap it in a code fence or prose, or
// return one bare item, as it did for a document saying "the only task that exists is the one
// below". Take the JSON from inside a fence, or from the first bracket to its last match.
function jsonPart(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.search(/[[{]/);
  if (start < 0) return text;
  const end = text.lastIndexOf(text[start] === "[" ? "]" : "}");
  return end > start ? text.slice(start, end + 1) : text;
}

// Parses the model's answer. A single item counts as a list of one. Throws on anything else that
// is not a JSON array; drops elements that are not objects with a known kind, an action and evidence.
export function parseItems(raw: string): ExtractedItem[] {
  let parsed: unknown = JSON.parse(jsonPart(raw));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "kind" in parsed) parsed = [parsed];
  if (!Array.isArray(parsed)) throw new Error("the reply is JSON but not an array");
  const items: ExtractedItem[] = [];
  for (const el of parsed) {
    if (!el || typeof el !== "object") continue;
    const e = el as Record<string, unknown>;
    const kind = optional(e.kind);
    const action = optional(e.action);
    const evidence = optional(e.evidence);
    if (!kind || !KINDS.has(kind) || !action || !evidence) continue;
    const newStatus = optional(e.new_status);
    items.push({
      kind: kind as ExtractedItem["kind"],
      action,
      owner: optional(e.owner),
      due: optional(e.due),
      refersTo: optional(e.refers_to),
      newStatus: newStatus && STATUSES.has(newStatus) ? newStatus as ExtractedItem["newStatus"] : undefined,
      evidence,
    });
  }
  return items;
}

// One file per call, so every item stays tied to its source. On invalid JSON, retry once with
// the error appended.
export async function extractItems(gateway: BoxGateway, fileId: string, prompt: string)
  : Promise<{ items: ExtractedItem[]; model: string; calls: number }> {
  const first = await gateway.extract(fileId, prompt);
  try {
    return { items: parseItems(first.raw), model: first.model, calls: 1 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retry = await gateway.extract(fileId, `${prompt}\n${RETRY_NOTE} (${message}). Return ONLY the JSON array.`);
    return { items: parseItems(retry.raw), model: retry.model, calls: 2 };
  }
}
