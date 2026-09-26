/**
 * The one write that changes what the read path shows: a lifecycle transition on a
 * `fire_events` row (ADR-002 D6 states, ADR-002 A2.2 anchor, ADR-003 A1.4 R1).
 *
 * R1 says the active set changes *only* through a status transition written to the
 * database that bumps the global `seq`, and forbids the snapshot from deriving tiers
 * from the clock at read time. This port is where that sentence becomes code: the
 * caller — D4's tick job, a curation command, the SP promotion — hands over the whole
 * outcome of a decision (`status`, `display_tier`, `inactive_since`) and the adapter
 * writes all of it **and `seq = nextval(...)` in one statement**. There is no method to
 * change the tier without the status, or the status without bumping seq, on purpose.
 *
 * The decision itself is pure and lives in `core/lifecycle/lifecycle-state.ts`
 * (`decideLifecycle`, `displayTierFor`); nothing here evaluates a rule.
 */

import type { LifecycleState } from '@fire-watch/contracts';

import type { DisplayTier } from '../lifecycle/types.js';
import type { EpochMs } from './clock.js';

export interface EventStatusTransition {
  readonly publicId: string;
  readonly status: LifecycleState;
  /** Why, where the status alone does not say — `'unobservable'`, `'superseded_by_sp'`. */
  readonly statusReason: string | null;
  /** Must agree with `status` (migration 004 checks it): active/weakening ⇒ map, archived ⇒ archive. */
  readonly displayTier: DisplayTier;
  /** Null exactly while `status` is active or signal_weakening. */
  readonly inactiveSinceMs: EpochMs | null;
  /** The instant of the transition — `status_changed_at`, never the write time. */
  readonly atMs: EpochMs;
}

export interface EventStatusStore {
  /**
   * Writes one transition. Every call bumps `seq`, so call it only when the decision
   * differs from the stored row — a tick that rewrites an unchanged state would cost every
   * client a cache miss for nothing.
   *
   * Resolves to the new seq, or `null` when no live event has that public id (a tombstone
   * is not transitioned: its survivor is). Throws on a constraint violation, which is a
   * caller bug — a tier that contradicts the status — and must not be swallowed.
   */
  applyTransition(transition: EventStatusTransition): Promise<number | null>;
}
