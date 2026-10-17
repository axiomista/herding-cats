// Pairing and buckets (spec: Matching and certainty). Plain code with fixed thresholds, so every
// result can be explained in one sentence and reproduced in a test.
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { Bucket, Commitment, ExtractedItem, Finding, TrackerTask } from "../types.js";
import { similarity } from "./normalize.js";

export type StatusChange = ExtractedItem & { fileId: string };

const STOPWORDS = new Set(["the", "a", "an", "for", "of", "on", "in", "to", "by", "and", "with", "at"]);

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter((w) => w && !STOPWORDS.has(w)).slice(0, 4).join("-");
}

export function fingerprint(bucket: Bucket, c?: Commitment, t?: TrackerTask): string {
  return c ? `${bucket}|${c.fileId}|${slug(c.text)}` : `${bucket}|${t!.fileId}|task-${t!.id}`;
}

export const findingId = (fp: string) => createHash("sha1").update(fp).digest("hex").slice(0, 12);

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

// Applies cancellations and completions to the commitments they refer to. A status change whose
// commitment is not in memory becomes a commitment of its own, so it can still find the open
// task created from another document.
export function applyStatusChanges(commitments: Commitment[], changes: StatusChange[],
  cfg: Config["match"]): Commitment[] {
  const out = [...commitments];
  for (const sc of changes) {
    if (sc.newStatus !== "cancelled" && sc.newStatus !== "completed") continue;
    const status = sc.newStatus === "cancelled" ? "cancelled" : "done";
    const ref = sc.refersTo ?? sc.action;
    let best: Commitment | undefined;
    let bestScore = -1;
    for (const c of out) {
      const s = similarity(ref, c.text);
      if (s > bestScore) { best = c; bestScore = s; }
    }
    if (best && bestScore >= cfg.matchThreshold) {
      best.status = status;
      best.statusEvidence = { fileId: sc.fileId, evidence: sc.evidence };
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

  commitments.forEach((c, ci) => {
    const pair = pairedC.get(ci);
    if (!pair) {
      const best = Math.max(0, ...scores[ci]);
      if (c.status === "open") add("untracked", c, undefined, best);
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
