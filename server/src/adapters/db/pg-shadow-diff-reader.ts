/**
 * Both sides of one shadow-diff window over Postgres (TASKS H8; migration 006).
 *
 * Four read statements and one per-zone read, no writes. Every inclusion rule lives on the
 * port (`core/ports/shadow-diff-reader.ts`); this module is those rules in SQL and the
 * decoding of what comes back.
 *
 * ## The live side
 *
 * Events come from `fire_events`, keyed by public id, with `merged_into` translated from
 * the internal bigint to the survivor's public id — the diff speaks public ids on the
 * live side, exactly as the alert-state adapter does. The detection set is the distinct
 * union over live and promoted clustering runs, aggregated in SQL so a busy event costs
 * one row, not one per detection. An event with no membership in any such run comes back
 * with an empty set; the diff then reports it as dropped, which is the truthful reading of
 * "the live map shows a fire made of nothing the candidate could have seen".
 *
 * Alerts come from `alert_outbox`, one row per A1.11 key, `manual` excluded.
 *
 * ## Scores are `real` on both sides
 *
 * `fire_events.score` and `events_shadow.score` are both `real`, so both come back as the
 * same float4 widening of what was written. That symmetry is what makes the diff's bucket
 * comparison fair at a bucket floor: 0.45 stored as `real` reads as 0.4499999…, a bucket
 * below 0.45 exactly — on *both* sides, so a candidate that agrees with live never shows a
 * bucket diff over storage precision.
 *
 * ## Instants
 *
 * Window bounds are bound as full ISO strings (`toISOString`, milliseconds kept) and cast
 * to `timestamptz` in SQL; `timestamptz` comes back as a `Date`, which `pg-rows` decodes.
 */

import { isLifecycleState } from '@fire-watch/contracts';

import { ALERT_TYPES, type AlertType } from '../../core/config/alert-gating.js';
import type {
  ShadowDiffReader,
  ShadowDiffWindowQuery,
  WouldHaveReceivedReader,
} from '../../core/ports/shadow-diff-reader.js';
import type {
  ShadowSide,
  ShadowSideAlert,
  ShadowSideEvent,
  ShadowWindow,
} from '../../core/shadow/shadow-diff.js';
import { boolean, epochMs, field, number, string } from './pg-rows.js';

/** The slice of `pg` this module uses. */
export interface PgShadowDiffQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/**
 * The window predicate on events, plus every event an in-window automatic alert names.
 * `UNION`, not `UNION ALL`: an event can qualify both ways and must come back once.
 */
const SELECT_LIVE_EVENTS = `
WITH in_window AS (
  SELECT e.id FROM fire_events e
  WHERE e.last_detection_at >= $1::timestamptz AND e.started_at < $2::timestamptz
  UNION
  SELECT o.fire_event_id FROM alert_outbox o
  WHERE o.decided_at >= $1::timestamptz AND o.decided_at < $2::timestamptz
    AND o.trigger_type <> 'manual'
)
SELECT e.public_id AS event_key, e.status, e.score, e.started_at, e.last_detection_at,
       e.invalidated, m.public_id AS merged_into,
       COALESCE(
         array_agg(DISTINCT member.detection_uid) FILTER (WHERE member.detection_uid IS NOT NULL),
         '{}'
       ) AS detection_uids
FROM in_window w
JOIN fire_events e ON e.id = w.id
LEFT JOIN fire_events m ON m.id = e.merged_into
LEFT JOIN (
  event_detections member
  JOIN clustering_runs r
    ON r.id = member.clustering_run_id AND (r.kind = 'live' OR r.promoted_at IS NOT NULL)
) ON member.fire_event_id = e.id
GROUP BY e.id, m.public_id
`.trim();

const SELECT_LIVE_ALERTS = `
SELECT o.watch_zone_id::text AS zone_id, e.public_id AS event_key, o.alert_type,
       o.alert_subkey, o.template_id, o.decided_at
FROM alert_outbox o
JOIN fire_events e ON e.id = o.fire_event_id
WHERE o.decided_at >= $1::timestamptz AND o.decided_at < $2::timestamptz
  AND o.trigger_type <> 'manual'
  AND o.watch_zone_id IS NOT NULL -- erased accounts' rows are pseudonymized (migration 010)
`.trim();

const SELECT_SHADOW_EVENTS = `
WITH in_window AS (
  SELECT s.shadow_key FROM events_shadow s
  WHERE s.candidate_version = $1
    AND s.last_detection_at >= $2::timestamptz AND s.started_at < $3::timestamptz
  UNION
  SELECT a.shadow_event_key FROM alerts_shadow a
  WHERE a.candidate_version = $1
    AND a.decided_at >= $2::timestamptz AND a.decided_at < $3::timestamptz
)
SELECT s.shadow_key AS event_key, s.status, s.score, s.started_at, s.last_detection_at,
       s.invalidated, s.merged_into_key AS merged_into, s.detection_uids
FROM in_window w
JOIN events_shadow s ON s.candidate_version = $1 AND s.shadow_key = w.shadow_key
`.trim();

const SHADOW_ALERT_PROJECTION = `
SELECT a.watch_zone_id::text AS zone_id, a.shadow_event_key AS event_key, a.alert_type,
       a.alert_subkey, a.template_id, a.decided_at
FROM alerts_shadow a
WHERE a.candidate_version = $1
  AND a.decided_at >= $2::timestamptz AND a.decided_at < $3::timestamptz
`.trim();

const SELECT_SHADOW_ALERTS = SHADOW_ALERT_PROJECTION;

/**
 * The beta hook. The zone predicate is a bound parameter on the one table read, so this
 * statement has no way to return another zone's rows; `alerts_shadow_by_zone` serves it.
 */
const SELECT_ZONE_SHADOW_ALERTS = `
${SHADOW_ALERT_PROJECTION}
  AND a.watch_zone_id = $4::uuid
ORDER BY a.decided_at, a.alert_type, a.alert_subkey, a.shadow_event_key
`.trim();

export const SHADOW_DIFF_READER_SQL = Object.freeze({
  selectLiveEvents: SELECT_LIVE_EVENTS,
  selectLiveAlerts: SELECT_LIVE_ALERTS,
  selectShadowEvents: SELECT_SHADOW_EVENTS,
  selectShadowAlerts: SELECT_SHADOW_ALERTS,
  selectZoneShadowAlerts: SELECT_ZONE_SHADOW_ALERTS,
});

export function createPgShadowDiffReader(
  db: PgShadowDiffQueryable,
): ShadowDiffReader & WouldHaveReceivedReader {
  return {
    async loadWindow(
      query: ShadowDiffWindowQuery,
    ): Promise<{ live: ShadowSide; shadow: ShadowSide }> {
      const [from, to] = bounds(query.window);
      const shadowValues = [query.candidateVersion, from, to];
      // Sequential, not `Promise.all`: a caller may hand this a single client, and `pg`
      // queues on a client anyway — parallelism here would only be an appearance.
      const liveEvents = await db.query(SELECT_LIVE_EVENTS, [from, to]);
      const liveAlerts = await db.query(SELECT_LIVE_ALERTS, [from, to]);
      const shadowEvents = await db.query(SELECT_SHADOW_EVENTS, shadowValues);
      const shadowAlerts = await db.query(SELECT_SHADOW_ALERTS, shadowValues);
      return {
        live: {
          events: liveEvents.rows.map(decodeSideEvent),
          alerts: liveAlerts.rows.map(decodeSideAlert),
        },
        shadow: {
          events: shadowEvents.rows.map(decodeSideEvent),
          alerts: shadowAlerts.rows.map(decodeSideAlert),
        },
      };
    },

    async shadowAlertsForZone(query): Promise<readonly ShadowSideAlert[]> {
      const [from, to] = bounds(query.window);
      const { rows } = await db.query(SELECT_ZONE_SHADOW_ALERTS, [
        query.candidateVersion,
        from,
        to,
        query.zoneId,
      ]);
      return rows.map(decodeSideAlert);
    },
  };
}

function bounds(window: ShadowWindow): [string, string] {
  if (!(window.fromMs < window.toMs))
    throw new RangeError('shadow window must end after it starts');
  return [new Date(window.fromMs).toISOString(), new Date(window.toMs).toISOString()];
}

export function decodeSideEvent(row: unknown): ShadowSideEvent {
  const status = string(field(row, 'status'), 'status');
  if (!isLifecycleState(status)) {
    throw new Error(`status holds a value outside the lifecycle: ${status}`);
  }
  const mergedInto = field(row, 'merged_into');
  return {
    key: string(field(row, 'event_key'), 'event_key'),
    status,
    score: number(field(row, 'score'), 'score'),
    startedAtMs: epochMs(field(row, 'started_at'), 'started_at'),
    lastDetectionAtMs: epochMs(field(row, 'last_detection_at'), 'last_detection_at'),
    invalidated: boolean(field(row, 'invalidated'), 'invalidated'),
    mergedInto: mergedInto === null ? null : string(mergedInto, 'merged_into'),
    detectionUids: stringArray(field(row, 'detection_uids'), 'detection_uids'),
  };
}

export function decodeSideAlert(row: unknown): ShadowSideAlert {
  return {
    zoneId: string(field(row, 'zone_id'), 'zone_id'),
    eventKey: string(field(row, 'event_key'), 'event_key'),
    alertType: alertType(field(row, 'alert_type')),
    alertSubkey: string(field(row, 'alert_subkey'), 'alert_subkey'),
    templateId: string(field(row, 'template_id'), 'template_id'),
    decidedAtMs: epochMs(field(row, 'decided_at'), 'decided_at'),
  };
}

function alertType(value: unknown): AlertType {
  const text = string(value, 'alert_type');
  const known = ALERT_TYPES.find((type) => type === text);
  if (known === undefined) throw new Error(`alert_type holds a value outside the vocabulary`);
  return known;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${name} is not a text array`);
  }
  return value;
}
