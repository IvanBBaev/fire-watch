/**
 * The `AlertableEvent` read model over Postgres (ADR-004 A1.6–A1.8; TASKS H3).
 *
 * Two readers need the same projection of a `fire_events` row for the gate: the live
 * evaluation loop (events whose `seq` moved past its cursor) and the zone-creation seed
 * reader (events near a new zone's centre). One column list and one decoder serve both,
 * so a fact the gate reads cannot mean one thing when a fire moves and another when a
 * zone is drawn — A1.8's failure exactly.
 *
 * What each field is, live:
 *
 *   - `score` is `fire_events.score`. **The live clustering store does not write it yet**
 *     (it stays the column default, 0), so every live event is below every zone's threshold
 *     until the v0 scorer is wired into the clustering transaction. The alert loop's wiring
 *     reports that as a disable reason instead of this module inventing a score.
 *   - `detectionCount`, `nightHighConfidenceCount` and `geoOnly` are aggregated over the
 *     event's member detections in live clustering runs that are **not** flagged
 *     `detections.quarantined` — the breaker's batches never count toward persistence.
 *   - `quarantined` is the flag of the most recently attached member (ties broken by the
 *     detection uid, for determinism).
 *   - `statusBefore` is the status the loop last evaluated the event in
 *     (`alert_evaluated_events`, migration 009), or `null`.
 *   - `burnedAreaHa` is `null`: no burned-area estimate exists (ladder rung 5 stays dormant,
 *     as in the replay).
 *   - `startedAt` / `lastDetectionAt` are the event's own columns.
 *
 * The centroid is selected as two numbers for the zone-distance test and goes nowhere else.
 */

import { isLifecycleState } from '@fire-watch/contracts';

import type { AlertableEvent } from '../../core/alerts/alert-decision.js';
import type { Coordinate } from '../../core/clustering/geometry.js';
import type { EvaluationEventRow } from '../../core/ports/alert-evaluation-store.js';
import { boolean, epochMs, field, number, string } from './pg-rows.js';

/**
 * The per-event select list, over `fire_events e`, with the member aggregate as the
 * lateral `m` and the latest member as `q`, and `alert_evaluated_events` as `ae`. Callers
 * add their own `WHERE` and `ORDER BY`; {@link ALERTABLE_EVENT_JOINS} is the `FROM` tail.
 */
export const ALERTABLE_EVENT_COLUMNS = `
  e.id::text AS fire_event_id,
  e.seq::text AS seq,
  e.public_id,
  e.status,
  e.score,
  e.invalidated,
  e.relation_kind,
  e.started_at,
  e.last_detection_at,
  ST_Y(e.centroid) AS lat,
  ST_X(e.centroid) AS lon,
  (e.merged_into IS NOT NULL) AS merged,
  EXISTS (SELECT 1 FROM fire_events c WHERE c.related_event_id = e.id) AS superseded,
  m.member_count,
  m.persistent_count,
  m.night_high_count,
  m.non_geo_count,
  coalesce(q.quarantined, false) AS latest_quarantined,
  ae.last_status AS status_before`;

export const ALERTABLE_EVENT_JOINS = `
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS member_count,
           count(*) FILTER (WHERE NOT d.quarantined)::int AS persistent_count,
           count(*) FILTER (
             WHERE NOT d.quarantined AND d.day_night = 'N' AND d.confidence = 'high'
           )::int AS night_high_count,
           count(*) FILTER (WHERE NOT d.quarantined AND d.product_tier <> 'GEO')::int
             AS non_geo_count
    FROM event_detections ed
    JOIN clustering_runs r ON r.id = ed.clustering_run_id AND r.kind = 'live'
    JOIN detections d ON d.acq_ts = ed.acq_ts AND d.detection_uid = ed.detection_uid
    WHERE ed.fire_event_id = e.id
  ) m
  LEFT JOIN LATERAL (
    SELECT d.quarantined
    FROM event_detections ed
    JOIN clustering_runs r ON r.id = ed.clustering_run_id AND r.kind = 'live'
    JOIN detections d ON d.acq_ts = ed.acq_ts AND d.detection_uid = ed.detection_uid
    WHERE ed.fire_event_id = e.id
    ORDER BY ed.attached_at DESC, ed.detection_uid DESC
    LIMIT 1
  ) q ON true
  LEFT JOIN alert_evaluated_events ae ON ae.fire_event_id = e.id`;

/** Decodes one row of {@link ALERTABLE_EVENT_COLUMNS}. Throws on any unexpected shape. */
export function decodeEvaluationEventRow(row: unknown): EvaluationEventRow {
  const fireEventId = decimalText(field(row, 'fire_event_id'), 'fire_event_id');
  const seq = decimalText(field(row, 'seq'), 'seq');
  const publicId = string(field(row, 'public_id'), 'public_id');
  const status = field(row, 'status');
  if (!isLifecycleState(status)) throw new Error('status is not a lifecycle state');
  const statusBeforeRaw = field(row, 'status_before');
  if (statusBeforeRaw !== null && !isLifecycleState(statusBeforeRaw)) {
    throw new Error('status_before is not a lifecycle state');
  }
  const relationRaw = field(row, 'relation_kind');
  if (
    relationRaw !== null &&
    relationRaw !== 'possible_reignition' &&
    relationRaw !== 'continuation'
  ) {
    throw new Error('relation_kind is not a relation kind');
  }

  const memberCount = count(field(row, 'member_count'), 'member_count');
  const persistentCount = count(field(row, 'persistent_count'), 'persistent_count');
  const nonGeoCount = count(field(row, 'non_geo_count'), 'non_geo_count');

  const event: AlertableEvent = {
    publicId,
    score: number(field(row, 'score'), 'score'),
    detectionCount: persistentCount,
    nightHighConfidenceCount: count(field(row, 'night_high_count'), 'night_high_count'),
    // "Every detection came from a geostationary source": vacuously false with no
    // unquarantined members, which the gate then stops on persistence anyway.
    geoOnly: persistentCount > 0 && nonGeoCount === 0,
    invalidated: boolean(field(row, 'invalidated'), 'invalidated'),
    quarantined: boolean(field(row, 'latest_quarantined'), 'latest_quarantined'),
    status,
    statusBefore: statusBeforeRaw,
    relationKind: relationRaw,
    burnedAreaHa: null,
    startedAt: epochMs(field(row, 'started_at'), 'started_at'),
    lastDetectionAt: epochMs(field(row, 'last_detection_at'), 'last_detection_at'),
  };
  const centroid: Coordinate = {
    lat: number(field(row, 'lat'), 'lat'),
    lon: number(field(row, 'lon'), 'lon'),
  };
  return {
    fireEventId,
    seq,
    centroid,
    merged: boolean(field(row, 'merged'), 'merged'),
    superseded: boolean(field(row, 'superseded'), 'superseded'),
    memberCount,
    event,
  };
}

function decimalText(value: unknown, name: string): string {
  const text = string(value, name);
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error(`${name} is not a decimal integer`);
  return text;
}

function count(value: unknown, name: string): number {
  const n = number(value, name);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} is not a count`);
  return n;
}
