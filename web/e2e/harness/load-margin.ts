/**
 * How long an end-to-end deadline may run on a loaded host.
 *
 * Every bound a spec derives is what the client needs on an idle host; every deadline is
 * that bound times {@link LOAD_MARGIN}, because on a loaded host the page's timers, the
 * CDP round trips and the harness servers all run late, in real time, while the client's
 * behaviour stays the same. A deadline is only how long to wait before calling it broken:
 * raising the margin never weakens an assertion, it only makes a broken client take longer
 * to report.
 *
 * Default 4: under a load average of ≈ 10 on a 10-core host the first mirror read of the
 * T2 failover spec was seen to take more than the idle bound. Override with
 * `FIRE_WATCH_E2E_LOAD_MARGIN` (a number ≥ 1).
 */

export const LOAD_MARGIN_ENV = 'FIRE_WATCH_E2E_LOAD_MARGIN';
export const DEFAULT_LOAD_MARGIN = 4;

/** Read and validate a margin; exported so the parsing is testable without the env. */
export function parseLoadMargin(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LOAD_MARGIN;
  const value = Number(raw);
  if (!(value >= 1)) throw new Error(`e2e: ${LOAD_MARGIN_ENV} must be a number ≥ 1, got "${raw}"`);
  return value;
}

export const LOAD_MARGIN = parseLoadMargin(process.env[LOAD_MARGIN_ENV]);

/** A deadline: the idle bound the client's constants give, times the load margin. */
export function within(boundMs: number): number {
  return Math.ceil(boundMs * LOAD_MARGIN);
}
