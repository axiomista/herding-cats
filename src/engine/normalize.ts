// Owners and dates (spec: How it works, steps 5 and 6). Unresolved owners and dates are flagged,
// never guessed.
import { readFileSync } from "node:fs";
import { token_set_ratio } from "fuzzball";
import { parse } from "yaml";
import type { Commitment } from "../types.js";
import { normalizeText } from "./verify.js";

export interface Person { name: string; aliases?: string[]; user?: string; external?: boolean }
export interface People { users: Record<string, string>; people: Person[] }

export function loadPeople(path = "config/people.yaml"): People {
  const doc = parse(readFileSync(path, "utf8")) as Partial<People>;
  return { users: doc.users ?? {}, people: doc.people ?? [] };
}

export const peopleNames = (people: People) => people.people.map((p) => p.name);

export function userName(people: People, userId: string): string {
  const key = Object.entries(people.users).find(([, id]) => id === userId)?.[0];
  return people.people.find((p) => p.user === key)?.name ?? key ?? userId;
}

const lower = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function findPerson(people: People, written: string): Person[] {
  const w = lower(written);
  const exact = people.people.filter((p) => [p.name, ...(p.aliases ?? [])].some((n) => lower(n) === w));
  if (exact.length) return exact;
  // "Tuxedo Meowtani (COO)" or "Sir Reginald": a known name as whole words inside what was written.
  return people.people.filter((p) => [p.name, ...(p.aliases ?? [])].some((n) =>
    new RegExp(`\\b${lower(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(w)));
}

// In an email, "I" is the sender of the message that contains the evidence.
export function emailSender(text: string, evidence: string): string | undefined {
  const blocks = text.split(/^(?=From:)/m);
  const quote = normalizeText(evidence);
  const block = blocks.find((b) => normalizeText(b).includes(quote));
  const from = block?.match(/^From:\s*(.+)$/m)?.[1];
  return from?.replace(/<[^>]*>/, "").replace(/"/g, "").trim() || undefined;
}

export interface OwnerResult { owner?: string; userId?: string; flags: string[] }

export function resolveOwner(written: string | undefined, people: People,
  ctx: { docType?: string; text: string; evidence: string }): OwnerResult {
  if (!written) return { flags: ["owner missing"] };
  let name = written;
  if (/^(i|me|myself)$/i.test(written.trim())) {
    const sender = ctx.docType === "email thread" ? emailSender(ctx.text, ctx.evidence) : undefined;
    if (!sender) return { owner: written, flags: ["owner unresolved"] };
    name = sender;
  }
  const matches = findPerson(people, name);
  if (matches.length !== 1) {
    return { owner: name, flags: [matches.length ? "owner ambiguous" : "owner unresolved"] };
  }
  const person = matches[0];
  if (person.external) return { owner: person.name, flags: ["owner external"] };
  const userId = person.user ? people.users[person.user] : undefined;
  if (!userId) return { owner: person.name, flags: ["owner has no Box user"] };
  return { owner: person.name, userId, flags: [] };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];

export interface DateResult { due?: string; absolute: boolean; flags: string[] }

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// Resolves a due date as written against the document's date. Only explicit dates resolve;
// relative phrases ("next Friday", "end of month") are flagged.
export function resolveDate(written: string | undefined, docDate: string | undefined): DateResult {
  if (!written) return { absolute: true, flags: [] };
  const isoMatch = written.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) return { due: isoMatch[0], absolute: true, flags: [] };
  const m = written.toLowerCase().match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/);
  if (!m) return { absolute: false, flags: ["date relative"] };
  const month = MONTHS.findIndex((name) => name.startsWith(m[1])) + 1;
  const day = Number(m[2]);
  if (m[3]) return { due: iso(Number(m[3]), month, day), absolute: true, flags: [] };
  if (!docDate) return { absolute: false, flags: ["date unresolved"] };
  const [y] = docDate.split("-").map(Number);
  let due = iso(y, month, day);
  // A month and day before the document's date means the following year.
  if (due < docDate) due = iso(y + 1, month, day);
  return { due, absolute: true, flags: [] };
}

export const similarity = (a: string, b: string) => token_set_ratio(a, b);

// Same owner and action similarity at or above the threshold. The first commitment wins;
// the later ones become its mentions.
export function dedupe(commitments: Commitment[], threshold: number): Commitment[] {
  const kept: Commitment[] = [];
  for (const c of commitments) {
    const owner = c.ownerUserId ?? c.owner;
    const dup = kept.find((k) => owner && (k.ownerUserId ?? k.owner) === owner
      && similarity(k.text, c.text) >= threshold);
    if (!dup) { kept.push(c); continue; }
    dup.mentions = [...(dup.mentions ?? []), { fileId: c.fileId, evidence: c.evidence }, ...(c.mentions ?? [])];
  }
  return kept;
}
