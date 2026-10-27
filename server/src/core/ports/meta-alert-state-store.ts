/**
 * Where the meta-alert hysteresis state lives between cycles (TASKS J1; migration 036).
 *
 * One call per cycle: the store reads every stored state under an exclusive lock, hands it
 * to `decide` — synchronous and pure, so nothing slow runs while the lock is held — and
 * writes back what `decide` returns before releasing the lock. Two workers' cycles are
 * therefore serialised: the second one reads what the first one wrote, which is what lets
 * the core hold rather than double-count a minute (`core/monitoring/meta-alert-memory.ts`).
 *
 * A store that cannot be read or written rejects; the cycle fails, the pager is not
 * called, and the dead-man's switch pages — the same rule as a failed reader.
 */

import type { MetaAlertKey } from '../monitoring/meta-alert-params.js';
import type {
  StoredMetaAlertState,
  StoredMetaAlertStates,
} from '../monitoring/meta-alert-memory.js';

export interface MetaAlertStateDecision<T> {
  /** States to store, or `null` to leave the stored ones untouched. */
  readonly write: ReadonlyMap<MetaAlertKey, StoredMetaAlertState> | null;
  readonly result: T;
}

export interface MetaAlertStateStore {
  update<T>(decide: (stored: StoredMetaAlertStates) => MetaAlertStateDecision<T>): Promise<T>;
}

/**
 * The store for a single process that need not survive itself — a test, a one-shot CLI.
 * Explicit, like `unguardedLoopLock`, so "not persisted" is a visible choice at the wiring
 * site.
 */
export function createInMemoryMetaAlertStateStore(): MetaAlertStateStore {
  let stored: StoredMetaAlertStates = new Map();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    update<T>(decide: (current: StoredMetaAlertStates) => MetaAlertStateDecision<T>): Promise<T> {
      const run = queue.then(() => {
        const decision = decide(stored);
        if (decision.write !== null) stored = new Map([...stored, ...decision.write]);
        return decision.result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
