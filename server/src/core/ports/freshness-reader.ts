/**
 * Where the freshness verdict gets its facts.
 *
 * Deliberately a *read* port with no write side. The rows it reports are written as a side
 * effect of the work itself — `recordPollAttempt` on every cycle (`detection-store.ts`) —
 * because a freshness surface that has to be updated by a second, separate call is a
 * freshness surface that can be honest about a source nobody is actually polling.
 *
 * The contract is narrow on purpose (OPERATIONS §2.2 rule 5): one bounded query, answered
 * or refused inside a second. A row the store knows nothing about is *omitted*, not
 * invented — the evaluator turns absence into `unknown`, and that distinction is the
 * difference between "we have never heard from this feed" and "we heard from it and it is
 * fine", which must never render the same way.
 */

import type { FreshnessRowId } from '@fire-watch/contracts';

import type { FreshnessObservation } from '../health/freshness.js';

export interface FreshnessReader {
  /**
   * Reads what is known about the given rows. The result may be shorter than the request
   * and is in no particular order; it never contains a row that was not asked for.
   *
   * Throws on a database error or a timeout. The caller renders that as a 500 with a
   * reason — never as an empty result, which would look like a fleet of unknown feeds
   * rather than like a database nobody can reach.
   */
  readObservations(rows: readonly FreshnessRowId[]): Promise<readonly FreshnessObservation[]>;
}

/**
 * Liveness of the database itself, for `/readyz` (OPERATIONS §2.1).
 *
 * Separate from {@link FreshnessReader} because it asks a different question: not "is the
 * data current" but "can this process reach its database at all". A box that is up with a
 * dead pool should be pulled out of rotation immediately, whatever the freshness budgets
 * currently say.
 */
export interface DatabaseProbe {
  /** Resolves when the database answered; rejects otherwise. Never hangs unbounded. */
  ping(): Promise<void>;
}
