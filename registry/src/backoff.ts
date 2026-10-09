/**
 * Retry backoff with full jitter for chain-facing loops (indexer, anchor).
 * Public/provider RPCs rate-limit sustained polling (429s) — loops must
 * back off exponentially with jitter, then recover to their cadence on
 * the first success (docs/ops-runbook.md).
 */
export function makeBackoff(baseMs: number, maxMs: number) {
  let attempt = 0;
  return {
    /** Call after a success: resets the ladder; returns the normal cadence. */
    success(): number {
      attempt = 0;
      return baseMs;
    },
    /** Call after a failure: returns the next (jittered) wait, doubling up to max. */
    fail(): number {
      attempt = Math.min(attempt + 1, 8);
      const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
      return Math.floor(ceiling * (0.5 + Math.random() / 2)); // full jitter
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
