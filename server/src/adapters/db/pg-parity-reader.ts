/**
 * Our side of the ingestion-parity check over Postgres (TASKS C9; A23).
 *
 * One read statement, no writes. The inclusion rules live on the port
 * (`core/ports/parity-reader.ts`); this module is those rules in SQL and the decoding of
 * what comes back.
 *
 * `lat`/`lon` are `numeric(8, 5)` and arrive as decimal strings. They are the hashed
 * coordinates, so they are decoded with `Number` and checked for being finite — the
 * comparator only reads them for the bbox and for near-match deltas; identity is the uid.
 */

import { isSourceId } from '@fire-watch/contracts';

import type { OurParityRow } from '../../core/ingest/parity-check.js';
import type { ParityReader } from '../../core/ports/parity-reader.js';
import { boolean, epochMs, field, string } from './pg-rows.js';

/** The slice of `pg` this module uses. */
export interface PgParityQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const SELECT_NRT_DETECTIONS = `
SELECT detection_uid, source, acq_ts, lat::text AS lat, lon::text AS lon, quarantined
FROM detections
WHERE product_tier = 'NRT'
  AND source = ANY ($1::text[])
  AND acq_ts >= $2::timestamptz AND acq_ts < $3::timestamptz
`.trim();

/** Exported for the unit test, which asserts on statement text. */
export const PARITY_READER_SQL = { selectNrtDetections: SELECT_NRT_DETECTIONS } as const;

export function createPgParityReader(db: PgParityQueryable): ParityReader {
  return {
    async loadNrtDetections({ sources, window }) {
      if (sources.length === 0) return [];
      const { rows } = await db.query(SELECT_NRT_DETECTIONS, [
        [...sources],
        new Date(window.fromMs).toISOString(),
        new Date(window.toMs).toISOString(),
      ]);
      return rows.map(decodeParityRow);
    },
  };
}

export function decodeParityRow(row: unknown): OurParityRow {
  const source = string(field(row, 'source'), 'source');
  if (!isSourceId(source)) throw new Error('source holds an id outside the registry');
  return {
    detectionUid: string(field(row, 'detection_uid'), 'detection_uid'),
    source,
    acqTsMs: epochMs(field(row, 'acq_ts'), 'acq_ts'),
    lat: decimal(field(row, 'lat'), 'lat'),
    lon: decimal(field(row, 'lon'), 'lon'),
    quarantined: boolean(field(row, 'quarantined'), 'quarantined'),
  };
}

function decimal(value: unknown, name: string): number {
  const parsed = Number(string(value, name));
  if (!Number.isFinite(parsed)) throw new Error(`${name} is not a finite decimal`);
  return parsed;
}
