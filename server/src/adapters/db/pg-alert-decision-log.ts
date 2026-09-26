/**
 * The alert decision log over Postgres (migration 014; TASKS H7).
 *
 * `append` is one `INSERT … SELECT FROM unnest(…)` per call, so a batch's decisions cost one
 * round trip, and `ON CONFLICT DO NOTHING` on the (zone, event, trigger seq, pass) key makes
 * a replayed batch a no-op. It runs on whatever client it is given: the evaluation loop
 * builds it over the batch's transaction client, so the log commits with the state rows,
 * the outbox rows and the cursor (D1), or not at all.
 *
 * The runtime role holds SELECT and INSERT only (migration 014). There is no update and no
 * delete here; erasure reaches the rows through the zone foreign key's cascade.
 */

import {
  DECISION_LOG_PASSES,
  type AlertDecisionLog,
  type AlertDecisionLogReader,
  type DecisionLogEntry,
  type DecisionLogPass,
} from '../../core/ports/alert-decision-log.js';
import {
  DECISION_OUTCOMES,
  DECISION_REASONS,
  type DecisionOutcome,
  type DecisionReason,
} from '../../core/alerts/alert-decision.js';
import { EXPLANATION_CODES, type ExplanationCode } from '../../core/alerts/explain.js';
import { isoFromEpochMs } from '../../core/ports/clock.js';
import { boolean, epochMs, field, number, string } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgDecisionLogQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const APPEND = `
INSERT INTO alert_decision_log (
  watch_zone_id, fire_event_id, trigger_ref_seq, pass, outcome, reason, code,
  alert_type, ladder_step, in_quiet_hours, rule_version, decided_at
)
SELECT *
FROM unnest(
  $1::uuid[], $2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[],
  $8::text[], $9::int[], $10::boolean[], $11::text[], $12::timestamptz[]
)
ON CONFLICT ON CONSTRAINT alert_decision_log_once_per_trigger DO NOTHING`.trim();

const SELECT_FOR_PAIR = `
SELECT watch_zone_id::text AS watch_zone_id,
       fire_event_id::text AS fire_event_id,
       trigger_ref_seq::text AS trigger_ref_seq,
       pass, outcome, reason, code, alert_type, ladder_step, in_quiet_hours, rule_version,
       decided_at
FROM alert_decision_log
WHERE watch_zone_id = $1::uuid AND fire_event_id = $2::bigint
ORDER BY decided_at, trigger_ref_seq, id`.trim();

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const ALERT_DECISION_LOG_SQL = Object.freeze({
  append: APPEND,
  selectForPair: SELECT_FOR_PAIR,
});

/** The bound values of the append statement, in order: one array per column. */
export function decisionLogArrays(entries: readonly DecisionLogEntry[]): readonly unknown[] {
  return [
    entries.map((e) => e.zoneId),
    entries.map((e) => e.fireEventId),
    entries.map((e) => e.triggerRefSeq),
    entries.map((e) => e.pass),
    entries.map((e) => e.outcome),
    entries.map((e) => e.reason),
    entries.map((e) => e.code),
    entries.map((e) => e.alertType),
    entries.map((e) => e.ladderStep),
    entries.map((e) => e.inQuietHours),
    entries.map((e) => e.ruleVersion),
    entries.map((e) => e.decidedAtIso),
  ];
}

export function createPgAlertDecisionLog(
  db: PgDecisionLogQueryable,
): AlertDecisionLog & AlertDecisionLogReader {
  return {
    async append(entries) {
      if (entries.length === 0) return 0;
      const result = await db.query(APPEND, decisionLogArrays(entries));
      return result.rowCount ?? 0;
    },

    async loadForPair(zoneId, fireEventId) {
      const result = await db.query(SELECT_FOR_PAIR, [zoneId, fireEventId]);
      return result.rows.map(decodeDecisionLogRow);
    },
  };
}

export function decodeDecisionLogRow(row: Record<string, unknown>): DecisionLogEntry {
  const alertType = field(row, 'alert_type');
  return {
    zoneId: string(field(row, 'watch_zone_id'), 'watch_zone_id'),
    fireEventId: string(field(row, 'fire_event_id'), 'fire_event_id'),
    triggerRefSeq: string(field(row, 'trigger_ref_seq'), 'trigger_ref_seq'),
    pass: oneOf(DECISION_LOG_PASSES, field(row, 'pass'), 'pass') satisfies DecisionLogPass,
    outcome: oneOf(DECISION_OUTCOMES, field(row, 'outcome'), 'outcome') satisfies DecisionOutcome,
    reason: oneOf(DECISION_REASONS, field(row, 'reason'), 'reason') satisfies DecisionReason,
    code: oneOf(EXPLANATION_CODES, field(row, 'code'), 'code') satisfies ExplanationCode,
    alertType:
      alertType === null
        ? null
        : oneOf(['new_fire', 'escalation'] as const, alertType, 'alert_type'),
    ladderStep: number(field(row, 'ladder_step'), 'ladder_step'),
    inQuietHours: boolean(field(row, 'in_quiet_hours'), 'in_quiet_hours'),
    ruleVersion: string(field(row, 'rule_version'), 'rule_version'),
    decidedAtIso: isoFromEpochMs(epochMs(field(row, 'decided_at'), 'decided_at')),
  };
}

function oneOf<const T extends readonly string[]>(
  allowed: T,
  value: unknown,
  name: string,
): T[number] {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value;
  }
  throw new TypeError(`${name}: unexpected value ${JSON.stringify(value)}`);
}
