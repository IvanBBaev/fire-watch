/**
 * The alert decision log (migration 014; TASKS H7; 07 §5.5.6 / P17), as a port.
 *
 * One entry per decision that took effect: the outcome, the reason, the explanation code
 * the pair maps to, and the gating config's version. It is what lets "why no alert?" be
 * answered from the database after the fact — a `defer` and a `suppress` write no other
 * row that names their reason, and `alert_states` carries no rule version.
 *
 * Append-only: there is no update and no delete here. Erasure reaches the rows through the
 * zone foreign key, and retention through the purge plan; neither is this port's business.
 *
 * `fireEventId` and `triggerRefSeq` are decimal text, as everywhere a `bigint` crosses a
 * port (see `alert-evaluation-store.ts`).
 */

import type { AlertType } from '../config/alert-gating.js';
import type { DecisionOutcome, DecisionReason } from '../alerts/alert-decision.js';
import type { ExplanationCode } from '../alerts/explain.js';

/** Which pass decided: the evaluation loop, or A1.8's zone-creation seed. */
export const DECISION_LOG_PASSES = ['evaluation', 'zone_creation'] as const;
export type DecisionLogPass = (typeof DECISION_LOG_PASSES)[number];

export interface DecisionLogEntry {
  readonly zoneId: string;
  /** `fire_events.id`, decimal text. */
  readonly fireEventId: string;
  /** `fire_events.seq` the decision was taken at, decimal text. */
  readonly triggerRefSeq: string;
  readonly pass: DecisionLogPass;
  readonly outcome: DecisionOutcome;
  readonly reason: DecisionReason;
  /** `branchOf(outcome, reason).code`; the writer never chooses it independently. */
  readonly code: ExplanationCode;
  /** Set for `send` and `defer` only. Never `digest`: a digest is not a `decideAlert` decision. */
  readonly alertType: Exclude<AlertType, 'digest'> | null;
  readonly ladderStep: number;
  readonly inQuietHours: boolean;
  readonly ruleVersion: string;
  readonly decidedAtIso: string;
}

export interface AlertDecisionLog {
  /**
   * Appends the entries. An entry whose (zone, event, trigger seq, pass) is already logged
   * is skipped, so a replayed batch writes nothing new. Resolves the number inserted.
   */
  append(entries: readonly DecisionLogEntry[]): Promise<number>;
}

export interface AlertDecisionLogReader {
  /** One (zone, event) pair's history, oldest decision first. */
  loadForPair(zoneId: string, fireEventId: string): Promise<readonly DecisionLogEntry[]>;
}
