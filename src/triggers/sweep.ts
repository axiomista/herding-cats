// Startup and timed sweep, and the on-demand full scan.
import type { CycleRunner, CycleSummary } from "../engine/cycle.js";

// The sweep passes every file; the cycle's skip check keeps only files whose version changed.
// Overlap guard: a sweep that fires while a cycle runs is queued behind it, not run alongside.
export function startSweeper(runner: Pick<CycleRunner, "enqueue">, minutes: number): () => void {
  runner.enqueue("all", "sweep");
  const timer = setInterval(() => runner.enqueue("all", "sweep"), minutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

// Every file, ignoring scan markers; used for backfill and to find orphan tasks on files that
// have not changed. Throws CycleBusyError while a cycle runs.
export function fullScan(runner: Pick<CycleRunner, "run">): Promise<CycleSummary> {
  return runner.run("all", { trigger: "full_scan", full: true });
}
