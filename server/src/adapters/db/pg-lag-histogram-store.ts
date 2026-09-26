/**
 * The NRT-lag samples and histograms over Postgres (TASKS C9; A23; migration 008).
 *
 * One read of `detections`, one batched upsert and one read of `nrt_lag_histograms`. The
 * inclusion rules live on the port (`core/ports/lag-histogram-store.ts`); this module is
 * those rules in SQL and the decoding of what comes back.
 *
 * ## Arrays through `unnest`
 *
 * The upsert binds one array per column, like every batched writer here. The two array
 * columns (`edges_minutes`, `counts`) cannot ride in a two-dimensional `unnest` — Postgres
 * flattens it — so each travels as the text of an `integer[]` literal and is cast back in
 * SQL. The values are whole numbers the core validated, so the literal cannot be anything
 * but digits, commas and a minus sign.
 *
 * ## A digest that changed under the same version is refused
 *
 * `ON CONFLICT … DO UPDATE … WHERE` the stored digest equals the new one. Edges edited in
 * place under an unchanged version would otherwise overwrite a day's counts with counts
 * bucketed differently, and the version string would hide it; instead the row is left
 * alone, the returned count falls short, and the adapter throws.
 */

import { isSourceId } from '@fire-watch/contracts';

import type { DailyLagHistogram, LagSample } from '../../core/ingest/lag-histogram.js';
import type { LagHistogramStore, LagSampleReader } from '../../core/ports/lag-histogram-store.js';
import { epochMs, field, number, string } from './pg-rows.js';

/** The slice of `pg` this module uses. */
export interface PgLagHistogramQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const SELECT_LAG_SAMPLES = `
SELECT source, acq_ts, available_at
FROM detections
WHERE available_at >= $1::timestamptz AND available_at < $2::timestamptz
  AND product_tier <> 'SP'
`.trim();

const UPSERT_DAILY = `
INSERT INTO nrt_lag_histograms AS h (
  day, source, histogram_version, histogram_digest, edges_minutes, counts,
  below, overflow, total, min_lag_ms, max_lag_ms
)
SELECT r.day::date, r.source, r.histogram_version, r.histogram_digest,
       r.edges_minutes::integer[], r.counts::integer[],
       r.below, r.overflow, r.total, r.min_lag_ms, r.max_lag_ms
FROM unnest(
  $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
  $7::integer[], $8::integer[], $9::integer[], $10::bigint[], $11::bigint[]
) AS r(day, source, histogram_version, histogram_digest, edges_minutes, counts,
       below, overflow, total, min_lag_ms, max_lag_ms)
ON CONFLICT (day, source, histogram_version) DO UPDATE SET
  edges_minutes = EXCLUDED.edges_minutes,
  counts        = EXCLUDED.counts,
  below         = EXCLUDED.below,
  overflow      = EXCLUDED.overflow,
  total         = EXCLUDED.total,
  min_lag_ms    = EXCLUDED.min_lag_ms,
  max_lag_ms    = EXCLUDED.max_lag_ms,
  computed_at   = now()
WHERE h.histogram_digest = EXCLUDED.histogram_digest
`.trim();

// COLLATE "C": source ids are compared bytewise in the core, and the database collation
// would sort ':' differently.
const SELECT_DAILY = `
SELECT to_char(day, 'YYYY-MM-DD') AS day, source, histogram_version, histogram_digest,
       edges_minutes, counts, below, overflow, total,
       min_lag_ms::text AS min_lag_ms, max_lag_ms::text AS max_lag_ms
FROM nrt_lag_histograms
WHERE histogram_version = $1 AND day >= $2::date AND day <= $3::date
ORDER BY day, source COLLATE "C"
`.trim();

/** Exported for the unit test, which asserts on statement text. */
export const LAG_HISTOGRAM_SQL = {
  selectLagSamples: SELECT_LAG_SAMPLES,
  upsertDaily: UPSERT_DAILY,
  selectDaily: SELECT_DAILY,
} as const;

export function createPgLagHistogramStore(
  db: PgLagHistogramQueryable,
): LagSampleReader & LagHistogramStore {
  return {
    async loadLagSamples({ fromMs, toMs }) {
      const { rows } = await db.query(SELECT_LAG_SAMPLES, [
        new Date(fromMs).toISOString(),
        new Date(toMs).toISOString(),
      ]);
      return rows.map(decodeLagSample);
    },

    async upsertDaily(rows) {
      if (rows.length === 0) return 0;
      const { rowCount } = await db.query(UPSERT_DAILY, upsertParameters(rows));
      const written = rowCount ?? 0;
      if (written !== rows.length) {
        throw new Error(
          `nrt_lag_histograms: ${String(rows.length - written)} row(s) not written — a stored ` +
            'row has the same histogram version under a different digest (edges edited in place?)',
        );
      }
      return written;
    },

    async loadDaily({ fromDay, toDay, histogramVersion }) {
      const { rows } = await db.query(SELECT_DAILY, [histogramVersion, fromDay, toDay]);
      return rows.map(decodeDailyRow);
    },
  };
}

/** The eleven column arrays of `UPSERT_DAILY`, in placeholder order. */
export function upsertParameters(rows: readonly DailyLagHistogram[]): unknown[][] {
  return [
    rows.map((row) => row.day),
    rows.map((row) => row.histogram.source),
    rows.map((row) => row.histogram.histogramVersion),
    rows.map((row) => row.histogram.histogramDigest),
    rows.map((row) => integerArrayLiteral(row.histogram.edgesMinutes)),
    rows.map((row) => integerArrayLiteral(row.histogram.counts)),
    rows.map((row) => row.histogram.below),
    rows.map((row) => row.histogram.overflow),
    rows.map((row) => row.histogram.total),
    rows.map((row) => row.histogram.minLagMs),
    rows.map((row) => row.histogram.maxLagMs),
  ];
}

function integerArrayLiteral(values: readonly number[]): string {
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new Error('histogram array holds a non-integer');
  }
  return `{${values.join(',')}}`;
}

export function decodeLagSample(row: unknown): LagSample {
  return {
    source: sourceId(field(row, 'source')),
    acqTsMs: epochMs(field(row, 'acq_ts'), 'acq_ts'),
    availableAtMs: epochMs(field(row, 'available_at'), 'available_at'),
  };
}

export function decodeDailyRow(row: unknown): DailyLagHistogram {
  return {
    day: string(field(row, 'day'), 'day'),
    histogram: {
      source: sourceId(field(row, 'source')),
      histogramVersion: string(field(row, 'histogram_version'), 'histogram_version'),
      histogramDigest: string(field(row, 'histogram_digest'), 'histogram_digest'),
      edgesMinutes: integerArray(field(row, 'edges_minutes'), 'edges_minutes'),
      counts: integerArray(field(row, 'counts'), 'counts'),
      below: number(field(row, 'below'), 'below'),
      overflow: number(field(row, 'overflow'), 'overflow'),
      total: number(field(row, 'total'), 'total'),
      minLagMs: nullableBigint(field(row, 'min_lag_ms'), 'min_lag_ms'),
      maxLagMs: nullableBigint(field(row, 'max_lag_ms'), 'max_lag_ms'),
    },
  };
}

function sourceId(value: unknown) {
  const source = string(value, 'source');
  if (!isSourceId(source)) throw new Error('source holds an id outside the registry');
  return source;
}

function integerArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${name} is not an array`);
  return value.map((item: unknown) => {
    if (typeof item !== 'number' || !Number.isSafeInteger(item)) {
      throw new Error(`${name} holds a non-integer`);
    }
    return item;
  });
}

/** Selected as text: a signed `bigint` past 2^53 would otherwise round silently. */
function nullableBigint(value: unknown, name: string): number | null {
  if (value === null) return null;
  const text = string(value, name);
  const parsed = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is not a safe integer`);
  }
  return parsed;
}
