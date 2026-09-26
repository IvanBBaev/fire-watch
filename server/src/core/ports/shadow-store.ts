/**
 * Where a candidate rule set writes what it concluded (TASKS H8; 06 §5.7; migration 006).
 *
 * The candidate "runs in parallel on the same detection stream and writes to the shadow
 * tables; it never dispatches". This port is that write, and it is the whole of what a
 * shadow run may touch: there is no method here that reaches `fire_events`,
 * `alert_outbox` or `alert_states`, so a shadow wired through it cannot move live state
 * by construction rather than by care.
 *
 * - **Events are upserted.** A candidate re-derives an event on every tick; the row is
 *   the latest conclusion, keyed by `(candidate_version, shadow_key)`.
 * - **Alerts are append-only.** A1.11's key, scoped to the candidate, is the primary key,
 *   and a replayed tick's rows are no-ops — the same "a re-crossed step writes nothing"
 *   rule the outbox has. The table grants no UPDATE to the runtime role (migration 006),
 *   because this log is the evidence L-1 is reviewed against.
 *
 * Who drives the candidate — the worker, a sidecar process, a replay — is not decided
 * here and is not part of H8's code; the port exists so that whoever it is has exactly
 * this much reach.
 */

import type { ShadowSideAlert, ShadowSideEvent } from '../shadow/shadow-diff.js';

export interface ShadowEventBatch {
  readonly candidateVersion: string;
  /** The digest of the candidate's params (`VersionedConfig.digest`), stamped per row. */
  readonly candidateConfigDigest: string;
  readonly events: readonly ShadowSideEvent[];
}

export interface ShadowAlertRow extends ShadowSideAlert {
  readonly ruleVersion: string;
  /** Bound parameters, never a rendered body — the outbox's rule. */
  readonly templateParams: Readonly<Record<string, unknown>>;
}

export interface ShadowAlertBatch {
  readonly candidateVersion: string;
  readonly alerts: readonly ShadowAlertRow[];
}

export interface ShadowStore {
  /** Returns the number of rows written. */
  upsertEvents(batch: ShadowEventBatch): Promise<number>;
  /** Returns the number of rows newly inserted; a key already present is skipped. */
  recordAlerts(batch: ShadowAlertBatch): Promise<number>;
}
