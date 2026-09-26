/**
 * The outbox claim lease — ADR-004 D1, TASKS H4, migration 015.
 *
 * A `claimed` row is owned by the dispatcher that claimed it for {@link CLAIM_LEASE_MS}
 * after `claimed_at`. Two rules make that ownership exclusive without any coordination
 * between dispatchers beyond the row itself:
 *
 *   1. **Expiry.** A claim older than the lease is returned to `pending` by whichever
 *      dispatcher next runs a cycle ({@link leaseExpiryCutoff}). That is the crash
 *      recovery: a process that died mid-batch leaves claims that come back one lease
 *      later, and no start-up step has to guess which claims are orphaned.
 *   2. **No send the lease cannot cover.** The gateway hands a row to a provider only while
 *      at least {@link CLAIM_SEND_WINDOW_MS} of its lease is left ({@link leaseAllowsSend}).
 *      The window bounds one send end to end — the channel's rate-limit wait, the provider
 *      call's own timeout, and the settle after it — so a send that starts inside the lease
 *      ends inside it, and rule 1 can never hand a row to a second dispatcher while the
 *      first is still talking to a provider about it. A row that is out of lease is
 *      released unsent and simply re-claimed next cycle.
 *
 * Settles are additionally fenced on the `claimed_at` the settling dispatcher claimed with
 * (`pg-alert-dispatch-queue.ts`), so a dispatcher that outlived its lease anyway — a stalled
 * process, a paused VM — cannot overwrite the outcome of the claim that replaced its own.
 *
 * Both instants come from dispatchers' clocks (`claim(limit, now)`), not the database's.
 * Two hosts whose clocks disagree by more than the lease's slack would erode rule 2; D1's
 * single dispatcher makes that moot, and NTP keeps it moot for a second one.
 *
 * The numbers are derived, not given, and are reported as such:
 *
 *   * {@link CLAIM_SEND_WINDOW_MS} — 30 s: the slowest configured provider timeout (SES,
 *     15 s) plus the rate-limit wait ceiling (2 s) is 17 s, and the rest is room for the
 *     subscription prune and the settle. `alert-wiring.test.ts` fails if a provider timeout
 *     grows past it.
 *   * {@link CLAIM_LEASE_MS} — 120 s: four send windows, so a batch keeps sending for
 *     90 s after its claim, and a crashed dispatcher's rows are back in the queue within
 *     two minutes — well inside push's 1800 s D6 deadline and D6's 600 s queue-age page.
 */

export const CLAIM_LEASE_MS = 120_000;
export const CLAIM_SEND_WINDOW_MS = 30_000;

export interface ClaimLease {
  /** How long a claim is owned after `claimed_at`. */
  readonly leaseMs: number;
  /** The longest one send may take end to end; no send starts with less lease left. */
  readonly sendWindowMs: number;
}

export const DEFAULT_CLAIM_LEASE: ClaimLease = Object.freeze({
  leaseMs: CLAIM_LEASE_MS,
  sendWindowMs: CLAIM_SEND_WINDOW_MS,
});

/** Throws unless the lease leaves room for at least one send. */
export function assertClaimLease(lease: ClaimLease): void {
  const { leaseMs, sendWindowMs } = lease;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new RangeError(`leaseMs must be a positive integer, got ${String(leaseMs)}`);
  }
  if (!Number.isSafeInteger(sendWindowMs) || sendWindowMs < 1) {
    throw new RangeError(`sendWindowMs must be a positive integer, got ${String(sendWindowMs)}`);
  }
  if (sendWindowMs >= leaseMs) {
    throw new RangeError(
      `sendWindowMs (${String(sendWindowMs)}) must be shorter than leaseMs (${String(leaseMs)}), ` +
        'or no claimed row could ever be sent',
    );
  }
}

/** Claims at or before this instant have expired and may be returned to `pending`. */
export function leaseExpiryCutoff(now: number, lease: ClaimLease = DEFAULT_CLAIM_LEASE): number {
  if (!Number.isFinite(now)) {
    throw new RangeError(`now must be a finite epoch, got ${String(now)}`);
  }
  return now - lease.leaseMs;
}

/**
 * May a send start now on a row claimed at `claimedAt`? True while the whole send window
 * still fits inside the lease.
 */
export function leaseAllowsSend(
  claimedAt: number,
  now: number,
  lease: ClaimLease = DEFAULT_CLAIM_LEASE,
): boolean {
  if (!Number.isFinite(claimedAt) || !Number.isFinite(now)) {
    throw new RangeError('claimedAt and now must be finite epochs');
  }
  return now + lease.sendWindowMs <= claimedAt + lease.leaseMs;
}

/** The `last_error` a row released for running out of lease carries. */
export const LEASE_EXHAUSTED_REASON = 'claim_lease_exhausted';
