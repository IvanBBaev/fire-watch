/**
 * CI-2 — the determinism double-run (ADR-002 D7, invariant I5).
 *
 * The whole replay runs twice and the reports must be byte-identical. This catches the
 * class of bug that no amount of assertion-writing does: a `Date.now()` that slipped
 * past lint, a `Map` iterated in insertion order that depends on which detection arrived
 * first, an unseeded shuffle, a `Set` of floats. All of those still produce a *correct*
 * result — just not the same correct result twice — and every one of them makes the
 * golden fixtures worthless, because a fixture that cannot be reproduced cannot fail
 * meaningfully either.
 *
 * The whole run is repeated, not a cached report: a run that memoizes its own output
 * would pass a comparison of two copies of the same bytes and prove nothing.
 */

export interface DoubleRunFailure {
  readonly offset: number;
  readonly first: string;
  readonly second: string;
}

export class NonDeterministicReplayError extends Error {
  readonly failure: DoubleRunFailure;

  constructor(label: string, failure: DoubleRunFailure) {
    super(
      `${label}: two runs of the same fixture differ at byte ${String(failure.offset)}\n` +
        `  run 1: …${failure.first}\n` +
        `  run 2: …${failure.second}`,
    );
    this.name = 'NonDeterministicReplayError';
    this.failure = failure;
  }
}

/**
 * Runs `produce` twice and returns the report when the two agree. `produce` must build
 * everything it needs from scratch — a shared engine instance between the runs would
 * make the second run a continuation rather than a repeat.
 */
export function assertDeterministic(label: string, produce: () => string): string {
  const first = produce();
  const second = produce();
  if (first === second) return first;
  throw new NonDeterministicReplayError(label, firstDifference(first, second));
}

/**
 * The offset plus a window of context. Two canonical-JSON documents differing in one
 * event id are otherwise thousands of identical characters, and "reports differ" is not
 * something anyone can act on.
 */
export function firstDifference(first: string, second: string, window = 80): DoubleRunFailure {
  const shared = Math.min(first.length, second.length);
  let offset = 0;
  while (offset < shared && first[offset] === second[offset]) offset += 1;

  const from = Math.max(0, offset - 20);
  return {
    offset,
    first: first.slice(from, offset + window),
    second: second.slice(from, offset + window),
  };
}
