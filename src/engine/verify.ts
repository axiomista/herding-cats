// Evidence quote check: the main guard against invented commitments (spec: How it works, step 4).
import type { ExtractedItem } from "../types.js";

// Normalizes whitespace and quotes, and drops Markdown emphasis markers the model may not copy.
export function normalizeText(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function evidenceInText(evidence: string, text: string): boolean {
  const quote = normalizeText(evidence);
  return quote.length > 0 && normalizeText(text).includes(quote);
}

export function verifyItems<T extends ExtractedItem>(items: T[], text: string): { verified: T[]; unverified: T[] } {
  const verified: T[] = [];
  const unverified: T[] = [];
  for (const item of items) (evidenceInText(item.evidence, text) ? verified : unverified).push(item);
  return { verified, unverified };
}
