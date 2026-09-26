/**
 * The persistence the live digest pass runs over (ADR-004 D1, D3, D4, A1.7, A1.8, A1.11,
 * A1.12; TASKS H3/D9/H7; migration 018), as a port.
 *
 * One {@link AlertDigestStore.withAccount} call is one account's digest decision: the
 * adapter opens a transaction, holds the account row against erasure for its whole length,
 * and hands the core an {@link AlertDigestTransaction} whose every read and write goes
 * through that one transaction. The log rows that *are* the watermark and the outbox rows
 * that deliver the digest commit together or not at all (D1), so a pass that dies half-way
 * has spent nothing and sent nothing.
 *
 * `fire_events.id` and `seq` cross as decimal text, as everywhere a `bigint` crosses a port.
 */

import type { Coordinate } from '../clustering/geometry.js';
import type { AlertOutboxStore } from './alert-outbox-store.js';
import type { AccountAlertSettings, StoredWatchZone } from './watch-zone-store.js';

/** A digest decision that is written down. `none` is not: it decided nothing. */
export const DIGEST_LOG_OUTCOMES = ['send', 'hold', 'suppress'] as const;
export type DigestLogOutcome = (typeof DIGEST_LOG_OUTCOMES)[number];

/** Migration 018's reason CHECK: each logged outcome has exactly one reason. */
export const DIGEST_LOG_REASON_FOR = Object.freeze({
  send: 'daily_summary',
  hold: 'quiet_hours',
  suppress: 'nothing_active',
} as const satisfies Record<DigestLogOutcome, string>);

export type DigestLogReason = (typeof DIGEST_LOG_REASON_FOR)[DigestLogOutcome];

/** One `alert_digest_log` row: one account-level decision, recorded against one zone. */
export interface DigestLogEntry {
  readonly zoneId: string;
  readonly windowStartIso: string;
  readonly outcome: DigestLogOutcome;
  readonly reason: DigestLogReason;
  /** Lines in the digest; 0 unless `send`. */
  readonly entryCount: number;
  readonly ruleVersion: string;
  readonly decidedAtIso: string;
}

/**
 * A (zone, event) pair the account's zone has been told about (`alert_states.state` other
 * than `none`) on an event that is still digestible: not merged away, not superseded by a
 * reignition child, not invalidated, and `active` or `signal_weakening` (07 §5.5.3 — the
 * digest never says a fire is out, so a fire it stopped seeing simply stops being listed).
 */
export interface DigestPairRow {
  readonly zoneId: string;
  /** `fire_events.id`, decimal text. */
  readonly fireEventId: string;
  /** `fire_events.seq` as read now: the carrier row's `trigger_ref_seq`. */
  readonly seq: string;
  readonly eventPublicId: string;
  /** The event centroid, for the zone distance only; never logged or reported. */
  readonly centroid: Coordinate;
  readonly seededAtIso: string | null;
  readonly lastNotifiedAtIso: string | null;
  /** The newest evaluation-pass `defer` logged for the pair (migration 014), or `null`. */
  readonly lastDeferredAtIso: string | null;
}

/** The account's last spent digest window, and when it was spent. */
export interface DigestWatermark {
  /** The window's opening instant: what `produceDigest` calls `lastWindowStartIso`. */
  readonly windowStartIso: string;
  /**
   * When that window was decided. Later than the window start whenever a hold delayed it,
   * and the instant that separates a debt the digest has paid from one it still owes.
   */
  readonly decidedAtIso: string;
}

export interface AlertDigestTransaction {
  /**
   * Locks the account against erasure for the rest of the transaction and returns its
   * alert settings, or `null` when it is gone or tombstoned — in which case the pass
   * writes nothing.
   */
  lockAccount(accountId: string): Promise<AccountAlertSettings | null>;
  /** The account's live sealed zones, oldest first. */
  listZones(accountId: string): Promise<readonly StoredWatchZone[]>;
  /**
   * The newest *spent* window (`send` or `suppress`) over every zone the account has ever
   * had, soft-deleted ones included, or `null` for none. A `hold` never moves it.
   */
  readWatermark(accountId: string): Promise<DigestWatermark | null>;
  /** Every digestible pair on the account's live zones, in (zone, event) order. */
  loadPairs(accountId: string): Promise<readonly DigestPairRow[]>;
  /**
   * Appends the entries; one already logged for its (zone, window, outcome) is skipped.
   * Resolves the number inserted — fewer than asked is how a pass learns it lost a race.
   */
  appendLog(entries: readonly DigestLogEntry[]): Promise<number>;
  readonly outbox: AlertOutboxStore;
}

export interface AlertDigestStore {
  /**
   * Up to `limit` ids of live accounts that own at least one live sealed zone, ascending,
   * strictly after `afterId` (`null` for the first page).
   */
  listAccountsAfter(afterId: string | null, limit: number): Promise<readonly string[]>;
  /** Runs `work` in one transaction: committed when it resolves, rolled back when it throws. */
  withAccount<T>(accountId: string, work: (tx: AlertDigestTransaction) => Promise<T>): Promise<T>;
}
