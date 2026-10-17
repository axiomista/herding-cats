// High or low, decided by the code's checks rather than a confidence the model reports about
// itself. A finding is high certainty only if every check passes.
import type { Config } from "../config.js";
import type { Bucket, Finding } from "../types.js";

const AUTO_BUCKETS = new Set<Bucket>(["untracked", "superseded", "owner_conflict", "date_conflict", "matched"]);

export function certaintyChecks(f: Omit<Finding, "certainty" | "checks">, cfg: Config["match"]): Record<string, boolean> {
  const checks: Record<string, boolean> = {};
  const c = f.commitment;
  if (c) {
    // Commitments reach matching only after their evidence was found in the file text.
    checks.evidence = true;
    checks.owner = !!c.ownerUserId && !(c.flags ?? []).some((x) => x.startsWith("owner"));
    checks.dueDate = c.dueAbsolute !== false && !(c.flags ?? []).some((x) => x.startsWith("date"));
  }
  if (c && f.task) {
    checks.pairing = (f.score ?? 0) >= cfg.highCertaintyScore && (f.score ?? 0) - (f.rivalScore ?? 0) >= cfg.rivalGap;
  }
  checks.bucket = AUTO_BUCKETS.has(f.bucket);
  return checks;
}

export function withCertainty(f: Omit<Finding, "certainty" | "checks">, cfg: Config["match"]): Finding {
  const checks = certaintyChecks(f, cfg);
  return { ...f, checks, certainty: Object.values(checks).every(Boolean) ? "high" : "low" };
}
