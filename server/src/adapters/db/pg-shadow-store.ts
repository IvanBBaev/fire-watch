/**
 * The candidate's write side over Postgres (TASKS H8; migration 006).
 *
 * Two statements, no transaction of its own — a candidate tick that writes events and the
 * alerts they produced hands this store whichever handle it has put a `BEGIN` on, the same
 * convention the outbox and alert-state adapters follow.
 *
 * ## Detection sets travel as JSON
 *
 * `unnest` flattens a two-dimensional array rather than yielding one array per row, so a
 * per-event `text[]` cannot ride in a `text[][]` parameter. Each set is bound as one JSON
 * array string and rebuilt with `jsonb_array_elements_text … WITH ORDINALITY`, which keeps
 * the order this module sorted it into. The sort is code-unit order in JavaScript, not
 * `ORDER BY` in SQL, because a database collation is not the diff's order and the column
 * comment promises "equal sets are equal arrays".
 *
 * ## Validation happens before the round trip
 *
 * A batch naming one event twice would make `ON CONFLICT DO UPDATE` fail with "cannot
 * affect row a second time" — correct, but after the statement is on the wire and with a
 * message that names nothing. The same goes for a detection listed twice in one event,
 * which the column's CHECK does not catch. Both are refused here, naming the key.
 */

import type {
  ShadowAlertBatch,
  ShadowEventBatch,
  ShadowStore,
} from '../../core/ports/shadow-store.js';

/** The slice of `pg` this module uses: only counts, never rows. */
export interface PgShadowStoreQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * Whole rows on conflict, as with `alert_states`: the row is the candidate's latest
 * conclusion, not a delta. `recorded_at` is left alone so the first sighting survives;
 * `updated_at` is set explicitly because the column default covers only the insert.
 */
const UPSERT_EVENTS = `
INSERT INTO events_shadow (
  candidate_version, shadow_key, candidate_config_digest, status, started_at,
  last_detection_at, score, invalidated, merged_into_key, detection_uids, updated_at
)
SELECT $1, b.shadow_key, $2, b.status, b.started_at, b.last_detection_at, b.score,
       b.invalidated, b.merged_into_key,
       ARRAY(
         SELECT uid.value
         FROM jsonb_array_elements_text(b.detection_uids::jsonb) WITH ORDINALITY AS uid(value, n)
         ORDER BY uid.n
       ),
       now()
FROM unnest($3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[], $7::real[],
            $8::boolean[], $9::text[], $10::text[])
  AS b(shadow_key, status, started_at, last_detection_at, score, invalidated,
       merged_into_key, detection_uids)
ON CONFLICT (candidate_version, shadow_key) DO UPDATE SET
  candidate_config_digest = EXCLUDED.candidate_config_digest,
  status = EXCLUDED.status,
  started_at = EXCLUDED.started_at,
  last_detection_at = EXCLUDED.last_detection_at,
  score = EXCLUDED.score,
  invalidated = EXCLUDED.invalidated,
  merged_into_key = EXCLUDED.merged_into_key,
  detection_uids = EXCLUDED.detection_uids,
  updated_at = EXCLUDED.updated_at
`.trim();

/**
 * Append-only: A1.11's key is the primary key, and a replayed tick is a no-op, reported
 * through the count. `trigger_type` is the alert type — a shadow row is automatic by
 * definition, and migration 006's CHECK holds it to that.
 */
const INSERT_ALERTS = `
INSERT INTO alerts_shadow (
  candidate_version, watch_zone_id, shadow_event_key, alert_type, alert_subkey,
  trigger_type, rule_version, template_id, template_params, decided_at
)
SELECT $1, b.zone_id, b.event_key, b.alert_type, b.alert_subkey, b.alert_type,
       b.rule_version, b.template_id, b.template_params::jsonb, b.decided_at
FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
            $8::text[], $9::timestamptz[])
  AS b(zone_id, event_key, alert_type, alert_subkey, rule_version, template_id,
       template_params, decided_at)
ON CONFLICT DO NOTHING
`.trim();

export const SHADOW_STORE_SQL = Object.freeze({
  upsertEvents: UPSERT_EVENTS,
  insertAlerts: INSERT_ALERTS,
});

export function createPgShadowStore(db: PgShadowStoreQueryable): ShadowStore {
  return {
    async upsertEvents(batch: ShadowEventBatch): Promise<number> {
      if (batch.events.length === 0) return 0;
      const result = await db.query(UPSERT_EVENTS, eventArrays(batch));
      return result.rowCount ?? 0;
    },

    async recordAlerts(batch: ShadowAlertBatch): Promise<number> {
      if (batch.alerts.length === 0) return 0;
      const result = await db.query(INSERT_ALERTS, alertArrays(batch));
      return result.rowCount ?? 0;
    },
  };
}

/** The bound values, in the order {@link UPSERT_EVENTS} names them. */
export function eventArrays(batch: ShadowEventBatch): readonly unknown[] {
  const seen = new Set<string>();
  for (const event of batch.events) {
    if (seen.has(event.key)) {
      throw new RangeError(`shadow batch names event ${JSON.stringify(event.key)} twice`);
    }
    seen.add(event.key);
    if (new Set(event.detectionUids).size !== event.detectionUids.length) {
      throw new RangeError(`shadow event ${JSON.stringify(event.key)} lists a detection twice`);
    }
  }
  const events = batch.events;
  return [
    batch.candidateVersion,
    batch.candidateConfigDigest,
    events.map((e) => e.key),
    events.map((e) => e.status),
    events.map((e) => new Date(e.startedAtMs).toISOString()),
    events.map((e) => new Date(e.lastDetectionAtMs).toISOString()),
    events.map((e) => e.score),
    events.map((e) => e.invalidated),
    events.map((e) => e.mergedInto),
    events.map((e) => JSON.stringify([...e.detectionUids].sort(compareIds))),
  ];
}

/** The bound values, in the order {@link INSERT_ALERTS} names them. */
export function alertArrays(batch: ShadowAlertBatch): readonly unknown[] {
  const alerts = batch.alerts;
  return [
    batch.candidateVersion,
    alerts.map((a) => a.zoneId),
    alerts.map((a) => a.eventKey),
    alerts.map((a) => a.alertType),
    alerts.map((a) => a.alertSubkey),
    alerts.map((a) => a.ruleVersion),
    alerts.map((a) => a.templateId),
    alerts.map((a) => JSON.stringify(a.templateParams)),
    alerts.map((a) => new Date(a.decidedAtMs).toISOString()),
  ];
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
