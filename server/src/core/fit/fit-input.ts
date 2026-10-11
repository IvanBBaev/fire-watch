/**
 * Raw fit inputs → {@link FitDetection} rows (TASKS D7). Pure: the adapter reads the
 * files, this decides what they mean.
 *
 * Input directory layout (the DS-1 archive layout, plus the label and GEO files beside it):
 *
 * - `firms/<product>/<year>/*.csv` — DS-1, exactly as `backfill-cli` writes it. The
 *   source is the product's, by `BACKFILL_PLAN` (`MODIS_SP` → `firms:modis`, …), never the
 *   CSV's `satellite` column (pitfall 5). Rows go through the production parser and are
 *   identified by the production `detection_uid` — the port the promotion stage uses —
 *   and a uid seen twice is counted once, as `stage-month.ts` does.
 * - `effis/modis.ba.poly.<year>.geojson` — DS-3, the WFS layer as DS-6 fetched it.
 * - `geo/detections.json` — DS-4, optional. **Provisional shape**: DS-4 has no plan and no
 *   adapter yet, so this is the narrowest record the ε_geo sweep needs —
 *   `[{source, acqTsIso, lat, lon, scanKm?, trackKm?}]` — and the first real DS-4 plan
 *   should replace it.
 */

import {
  canonicalAcqTsIsoFromInstant,
  canonicalDegrees,
  isSourceId,
  type SourceId,
} from '@fire-watch/contracts';

import { BACKFILL_PLAN } from '../backfill/backfill-plan.js';
import { isAttachOnly } from '../clustering/eps.js';
import { parseFirmsCsv } from '../ingest/firms-csv.js';
import type { DetectionUidFn } from '../ports/firms-client.js';
import type { FitDetection } from './label-join.js';

/** The source a DS-1 product directory holds, or `null` for a directory the plan never wrote. */
export function sourceOfProduct(product: string): SourceId | null {
  return BACKFILL_PLAN.values.sources.find((s) => s.product === product)?.source ?? null;
}

export interface CsvIntake {
  readonly rows: number;
  readonly rejected: number;
  readonly duplicates: number;
}

/**
 * Parses one DS-1 chunk and appends its rows to `into`, skipping any uid already in
 * `seen`. Returns the counts for the report.
 */
export function ingestFirmsCsv(
  text: string,
  source: SourceId,
  detectionUid: DetectionUidFn,
  seen: Set<string>,
  into: FitDetection[],
): CsvIntake {
  const parsed = parseFirmsCsv(text, { source });
  let duplicates = 0;
  for (const row of parsed.rows) {
    const uid = detectionUid({
      source: row.source,
      acqTsIso: row.acqTsIso,
      lat: row.latCanonical,
      lon: row.lonCanonical,
    });
    if (seen.has(uid)) {
      duplicates += 1;
      continue;
    }
    seen.add(uid);
    into.push({
      detectionUid: uid,
      source: row.source,
      acqTsIso: row.acqTsIso,
      latCanonical: row.latCanonical,
      lonCanonical: row.lonCanonical,
      scanKm: row.scanKm,
      trackKm: row.trackKm,
    });
  }
  return { rows: parsed.rows.length, rejected: parsed.rejections.length, duplicates };
}

/** The provisional DS-4 file. Throws on anything that is not a GEO row of the shape above. */
export function parseGeoDetections(raw: unknown, detectionUid: DetectionUidFn): FitDetection[] {
  if (!Array.isArray(raw)) throw new TypeError('geo/detections.json must be a JSON array');
  const seen = new Set<string>();
  const rows: FitDetection[] = [];
  raw.forEach((item: unknown, i) => {
    const r = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const source = r['source'];
    if (typeof source !== 'string' || !isSourceId(source) || !isAttachOnly(source)) {
      throw new TypeError(`geo/detections.json[${String(i)}]: source must be a GEO source id`);
    }
    const instant = r['acqTsIso'];
    const lat = r['lat'];
    const lon = r['lon'];
    if (typeof instant !== 'string') {
      throw new TypeError(`geo/detections.json[${String(i)}]: acqTsIso must be a string`);
    }
    if (
      (typeof lat !== 'string' && typeof lat !== 'number') ||
      (typeof lon !== 'string' && typeof lon !== 'number')
    ) {
      throw new TypeError(`geo/detections.json[${String(i)}]: lat/lon must be decimals`);
    }
    const acqTsIso = canonicalAcqTsIsoFromInstant(instant);
    const latCanonical = canonicalDegrees(lat);
    const lonCanonical = canonicalDegrees(lon);
    const uid = detectionUid({ source, acqTsIso, lat: latCanonical, lon: lonCanonical });
    if (seen.has(uid)) return;
    seen.add(uid);
    const km = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    rows.push({
      detectionUid: uid,
      source,
      acqTsIso,
      latCanonical,
      lonCanonical,
      scanKm: km(r['scanKm']),
      trackKm: km(r['trackKm']),
    });
  });
  return rows;
}

/** `modis.ba.poly.2024.geojson` → `2024`; `null` for any other name. */
export function effisLayerYear(fileName: string): number | null {
  const match = /^modis\.ba\.poly\.(\d{4})\.geojson$/.exec(fileName);
  return match === null ? null : Number(match[1]);
}
