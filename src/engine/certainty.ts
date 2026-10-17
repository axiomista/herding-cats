// High or low, decided by the code's checks rather than a confidence the model reports about
// itself. A finding is high certainty only if every check passes.
import type { Config } from "../config.js";
import type { Bucket, Finding } from "../types.js";

const AUTO_BUCKETS = new Set<Bucket>(["untracked", "superseded", "date_conflict", "matched"]);

// An owner mismatch on someone else's task is shown for review but never written automatically:
// the person who assigned it may know something the document does not. createdTasks holds the
// IDs of tasks Herding Cats created.
export function certaintyChecks(f: Omit<Finding, "certainty" | "checks">, cfg: Config["match"],
  createdTasks: ReadonlySet<string> = new Set()): Record<string, boolean> {
  const checks: Record<string, boolean> = {};
  const c = f.commitment;
  if (c) {
    // Commitments reach matching only after their evidence was found in the file text.
    checks.evidence = true;
    checks.owner = !!c.ownerUserId && !(c.flags ?? []).some((x) => x.startsWith("owner"));
    checks.dueDate = c.dueAbsolute !== false && !(c.flags ?? []).some((x) => x.startsWith("date"));
    // A cancellation or completion that matched below the threshold waits for a person.
    const statusScore = c.statusEvidence?.score;
    if (c.status !== "open" && statusScore !== undefined) checks.status = statusScore >= cfg.matchThreshold;
  }
  if (c && f.task) {
    checks.pairing = (f.score ?? 0) >= cfg.highCertaintyScore && (f.score ?? 0) - (f.rivalScore ?? 0) >= cfg.rivalGap;
  } else if (c && f.bucket === "untracked" && (f.score ?? 0) >= cfg.possibleThreshold) {
    // A task scored as a possible match but went to another commitment: a person decides.
    checks.pairing = false;
  }
  checks.bucket = AUTO_BUCKETS.has(f.bucket) || (f.bucket === "owner_conflict" && !!f.task && createdTasks.has(f.task.id));
  return checks;
}

export function withCertainty(f: Omit<Finding, "certainty" | "checks">, cfg: Config["match"],
  createdTasks?: ReadonlySet<string>): Finding {
  const checks = certaintyChecks(f, cfg, createdTasks);
  return { ...f, checks, certainty: Object.values(checks).every(Boolean) ? "high" : "low" };
}
