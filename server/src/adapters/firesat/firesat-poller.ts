/**
 * One FireSat poll, as the same immutable poll run the FIRMS path produces (V3-A1).
 *
 * Reusing {@link FirmsPollRun} is the point: `detectionRecords`, the E1 validation, the
 * anomaly breaker and the golden replay take a poll run, so a FireSat batch reaches the
 * archive through the code every other polar source already exercises, with nothing
 * FireSat-specific past the parser.
 *
 * ## Dark until access day
 *
 * `efa:firesat` is `reserved` in `source_registry_v2`: no access, no terms (V3-Q5). Nothing
 * schedules this poll and no HTTP client exists; {@link isFiresatLive} is how the worker
 * will decide, and it is false until the registry row flips to `active`. Going live is:
 * an HTTP {@link FiresatClient} for the real endpoint, the registry flip (which also makes
 * the type check demand FireSat's per-source parameters), a `pass_table` row and the
 * reserved pass platforms moved into the live list (`pass-platforms.ts`).
 */

import { SOURCE_REGISTRY, SOURCE_REGISTRY_VERSION } from '@fire-watch/contracts';

import { POLLING_BBOX, firmsAreaArgument } from '../../core/config/polling-bbox.js';
import { assertTotalOrder, orderBatch } from '../../core/determinism/batch-order.js';
import type { FirmsCsvResult } from '../../core/ingest/firms-csv.js';
import {
  FIRMS_DAY_RANGE,
  type FirmsPollRun,
  type IngestedDetection,
} from '../../core/ingest/firms-poller.js';
import type { DetectionUidFn, FirmsAreaQuery } from '../../core/ports/firms-client.js';
import type { FiresatClient, FiresatResponse } from './firesat-client.js';
import { FIRESAT_SOURCE, parseFiresatDocument } from './firesat-format.js';

/** Whether the registry lets FireSat be polled at all. False while the row is `reserved`. */
export function isFiresatLive(): boolean {
  return SOURCE_REGISTRY[FIRESAT_SOURCE].status === 'active';
}

/**
 * The query: the polled box and a two-UTC-day window, for the same reason FIRMS uses one
 * (pitfall 2) — a poll just after midnight must still see the evening's passes. Re-polled
 * rows mint the same `detection_uid` and land as a no-op.
 */
export function buildFiresatQuery(bbox: typeof POLLING_BBOX = POLLING_BBOX): FirmsAreaQuery {
  return {
    source: FIRESAT_SOURCE,
    product: SOURCE_REGISTRY[FIRESAT_SOURCE].queriedProduct,
    area: firmsAreaArgument(bbox.values),
    dayRange: FIRMS_DAY_RANGE,
  };
}

export interface PollFiresatDeps {
  readonly client: FiresatClient;
  readonly detectionUid: DetectionUidFn;
  readonly bbox?: typeof POLLING_BBOX;
}

export async function pollFiresat(deps: PollFiresatDeps): Promise<FirmsPollRun> {
  const bbox = deps.bbox ?? POLLING_BBOX;
  const query = buildFiresatQuery(bbox);
  const base = {
    source: FIRESAT_SOURCE,
    query,
    pollingBboxVersion: bbox.version,
    pollingBboxDigest: bbox.digest,
    sourceRegistryVersion: SOURCE_REGISTRY_VERSION,
  } as const;
  const failed = (error: unknown, availableAt: number | null): FirmsPollRun => ({
    ...base,
    outcome: 'failed',
    error: error instanceof Error ? error.message : String(error),
    availableAt,
    detections: [],
    rejections: [],
    duplicatesWithinBatch: 0,
  });

  let response: FiresatResponse;
  try {
    response = await deps.client.fetchDetections(query);
  } catch (error) {
    // "No fires" and "no data" must never look the same downstream (pitfall 10).
    return failed(error, null);
  }

  let parsed: FirmsCsvResult;
  try {
    parsed = parseFiresatDocument(response.body);
  } catch (error) {
    return failed(error, response.availableAt);
  }

  const seen = new Set<string>();
  const detections: IngestedDetection[] = [];
  let duplicatesWithinBatch = 0;
  for (const row of parsed.rows) {
    const detectionUid = deps.detectionUid({
      source: row.source,
      acqTsIso: row.acqTsIso,
      lat: row.latCanonical,
      lon: row.lonCanonical,
    });
    if (seen.has(detectionUid)) {
      duplicatesWithinBatch += 1;
      continue;
    }
    seen.add(detectionUid);
    detections.push({ ...row, detectionUid, availableAt: response.availableAt });
  }

  const ordered = orderBatch(detections);
  assertTotalOrder(ordered);

  return {
    ...base,
    outcome: 'ok',
    availableAt: response.availableAt,
    detections: ordered,
    rejections: parsed.rejections,
    duplicatesWithinBatch,
  };
}
