// Pairing and buckets (spec: Matching and certainty). Plain code with fixed thresholds, so every
// result can be explained in one sentence and reproduced in a test.
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { Bucket, Commitment, ExtractedItem, Finding, TrackerTask } from "../types.js";
import { similarity } from "./normalize.js";

export type StatusChange = ExtractedItem & { fileId: string };

const STOPWORDS = new Set(["the", "a", "an", "for", "of", "on", "in", "to", "by", "and", "with", "at"]);

export function slug(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter((w) => w && !STOPWORDS.has(w));
  const readable = words.slice(0, 4).join("-") || "item";
  // The readable prefix can collide ("book the hall" vs "book the hall tonight"). The hash is of
  // every significant word, so two different actions do not share a fingerprint.
  const hash = createHash("sha1").update(words.join(" ")).digest("hex").slice(0, 6);
  return `${readable}-${hash}`;
}

export function fingerprint(bucket: Bucket, c?: Commitment, t?: TrackerTask): string {
  return c ? `${bucket}|${c.fileId}|${slug(c.text)}` : `${bucket}|${t!.fileId}|task-${t!.id}`;
}

// Comments end with a line `fingerprint: <fingerprint>`. Match that line exactly: a shorter
// fingerprint must not count as already posted when it is a prefix of a longer one.
export function commentCarriesFingerprint(message: string, fingerprint: string): boolean {
  const line = `fingerprint: ${fingerprint}`;
  return message.split(/\r?\n/).some((part) => part.trim() === line);
}

export const findingId = (fp: string) => createHash("sha1").update(fp).digest("hex").slice(0, 12);

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

export const isClosing = (item: ExtractedItem) => item.newStatus === "cancelled" || item.newStatus === "completed";

// How well a status change refers to a commitment. Both the commitment's short text and its
// evidence sentence count: "The Human Acclimation Lab box order is cancelled." shares little
// with "order 50 cardboard boxes" but most of the sentence that committed to it.
function statusScore(sc: StatusChange, c: Commitment): number {
  const refs = [sc.refersTo ?? sc.action, sc.evidence];
  return Math.max(...refs.flatMap((r) => [similarity(r, c.text), similarity(r, c.evidence)]));
}

// Applies cancellations and completions to the commitments they refer to. A clear best match
// below the match threshold still applies, if it beats every other commitment by the rival gap;
// its certainty check then fails, so a person confirms it. A status change whose commitment is
// not in memory becomes a commitment of its own, so it can still find the open task created
// from another document.
export function applyStatusChanges(commitments: Commitment[], changes: StatusChange[],
  cfg: Config["match"]): Commitment[] {
  const out = [...commitments];
  for (const sc of changes) {
    if (!isClosing(sc)) continue;
    const status = sc.newStatus === "cancelled" ? "cancelled" : "done";
    const ref = sc.refersTo ?? sc.action;
    let best: Commitment | undefined;
    let bestScore = -1;
    let rival = 0;
    for (const c of out) {
      const s = statusScore(sc, c);
      if (s > bestScore) { rival = Math.max(rival, bestScore); best = c; bestScore = s; } else rival = Math.max(rival, s);
    }
    const clear = bestScore >= cfg.matchThreshold
      || (bestScore >= cfg.possibleThreshold && bestScore - rival >= cfg.rivalGap);
    if (best && clear) {
      best.status = status;
      best.statusEvidence = { fileId: sc.fileId, evidence: sc.evidence, score: bestScore };
    } else {
      out.push({
        id: `status:${sc.fileId}:${slug(ref)}`, fileId: sc.fileId, fileVersion: "", text: ref,
        evidence: sc.evidence, status, flags: ["owner missing", "from status change"],
        statusEvidence: { fileId: sc.fileId, evidence: sc.evidence },
      });
    }
  }
  return out;
}

export function bucketFor(c: Commitment, t: TrackerTask, cfg: Config["match"]): Bucket {
  if (t.completed) return "matched";
  if (c.status !== "open") return "superseded";
  if (t.assigneeIds.length && c.ownerUserId && !t.assigneeIds.includes(c.ownerUserId)) return "owner_conflict";
  if (c.due && t.due && daysBetween(c.due, t.due) > cfg.dateToleranceDays) return "date_conflict";
  const mentioned = t.fileId === c.fileId || (c.mentions ?? []).some((m) => m.fileId === t.fileId);
  if (!mentioned) return "misfiled";
  return "matched";
}

export interface MatchResult { findings: Omit<Finding, "certainty" | "checks">[]; setAside: Commitment[] }

// Pairs every commitment with every task in the folder: greedy, highest score first, one to one.
// Orphans are reported only for tasks on files this process has scanned.
export function matchFolder(commitments: Commitment[], tasks: TrackerTask[], scannedFileIds: Set<string>,
  cfg: Config["match"]): MatchResult {
  const scores = commitments.map((c) => tasks.map((t) => similarity(c.text, t.message)));
  const candidates: { ci: number; ti: number; s: number }[] = [];
  scores.forEach((row, ci) => row.forEach((s, ti) => { if (s >= cfg.possibleThreshold) candidates.push({ ci, ti, s }); }));
  candidates.sort((a, b) => b.s - a.s || a.ci - b.ci || a.ti - b.ti);

  const pairedC = new Map<number, { ti: number; s: number }>();
  const pairedT = new Set<number>();
  for (const { ci, ti, s } of candidates) {
    if (pairedC.has(ci) || pairedT.has(ti)) continue;
    pairedC.set(ci, { ti, s });
    pairedT.add(ti);
  }

  const findings: MatchResult["findings"] = [];
  const setAside: Commitment[] = [];
  const add = (bucket: Bucket, c: Commitment | undefined, t: TrackerTask | undefined, score?: number, rival?: number) => {
    const fp = fingerprint(bucket, c, t);
    findings.push({ id: findingId(fp), bucket, commitment: c, task: t, score, rivalScore: rival, fingerprint: fp });
  };

  // An unpaired commitment whose best task is already paired with the same owner's commitment is
  // a restatement of it, worded too differently to merge by text ("book the Great Hall").
  const ownerKey = (c: Commitment) => c.ownerUserId ?? c.owner;
  const claimedBySameOwner = (ci: number): number | undefined => {
    const best = Math.max(0, ...scores[ci]);
    if (best < cfg.matchThreshold || !ownerKey(commitments[ci])) return undefined;
    const ti = scores[ci].indexOf(best);
    const holder = [...pairedC].find(([, p]) => p.ti === ti)?.[0];
    return holder !== undefined && ownerKey(commitments[holder]) === ownerKey(commitments[ci]) ? holder : undefined;
  };

  commitments.forEach((c, ci) => {
    const pair = pairedC.get(ci);
    if (!pair) {
      const best = Math.max(0, ...scores[ci]);
      const holder = c.status === "open" ? claimedBySameOwner(ci) : undefined;
      if (holder !== undefined) {
        const h = commitments[holder];
        h.mentions = [...(h.mentions ?? []), { fileId: c.fileId, evidence: c.evidence }, ...(c.mentions ?? [])];
      } else if (c.status === "open") add("untracked", c, undefined, best);
      else setAside.push(c);
      return;
    }
    const t = tasks[pair.ti];
    // The best competing score on either side of the pair.
    const rival = Math.max(0,
      ...scores[ci].filter((_, ti) => ti !== pair.ti),
      ...scores.filter((_, i) => i !== ci).map((row) => row[pair.ti]));
    add(bucketFor(c, t, cfg), c, t, pair.s, rival);
  });

  tasks.forEach((t, ti) => {
    if (pairedT.has(ti) || t.completed || !scannedFileIds.has(t.fileId)) return;
    add("orphan", undefined, t, Math.max(0, ...scores.map((row) => row[ti])));
  });
  return { findings, setAside };
}
