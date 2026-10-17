// (new) Limits wrong passcode attempts per client IP, so the shared passcode cannot be guessed
// quickly. In memory, like the rest of the working state; a restart clears it.
export class PasscodeLimiter {
  private failures = new Map<string, number[]>();

  constructor(private max = 10, private windowMs = 15 * 60 * 1000) {}

  private recent(key: string, now: number): number[] {
    const times = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (times.length) this.failures.set(key, times);
    else this.failures.delete(key);
    return times;
  }

  // Seconds until the next attempt is allowed, or 0 if it is allowed now.
  retryAfter(key: string, now = Date.now()): number {
    const times = this.recent(key, now);
    return times.length < this.max ? 0 : Math.ceil((times[0] + this.windowMs - now) / 1000);
  }

  fail(key: string, now = Date.now()): void {
    // Keep memory bounded if many addresses fail: drop entries whose window has passed.
    if (this.failures.size > 10_000) for (const k of [...this.failures.keys()]) this.recent(k, now);
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}
