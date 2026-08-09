/**
 * The FIRMS poll cycle (TASKS C1).
 *
 * One run of this produces one immutable *poll run* per source: the ordered detections,
 * the rows that could not be read, and the provenance needed to explain the batch a year
 * later — which config versions were in force, when the response was in our hands, and
 * whether the source answered at all.
 *
 * Nothing here writes. The run is a value; persisting it is the adapter's job, which is
 * what lets the golden replay drive the same code path from a fixture (ADR-002 D7).
 */

import {
  SOURCE_IDS,
  SOURCE_REGISTRY,
  SOURCE_REGISTRY_VERSION,
  type SourceId,
} from '@fire-watch/contracts';

import { POLLING_BBOX, firmsAreaArgument } from '../config/polling-bbox.js';
import { assertTotalOrder, orderBatch } from '../determinism/batch-order.js';
import type {
  DetectionUidFn,
  FirmsAreaClient,
  FirmsAreaQuery,
  FirmsAreaResponse,
} from '../ports/firms-client.js';
import {
  parseFirmsCsv,
  type FirmsCsvResult,
  type FirmsRow,
  type FirmsRowRejection,
} from './firms-csv.js';

/**
 * Always 2, never 1 (DATA-SOURCES §A1.1 pitfall 2). `day_range` counts UTC calendar
 * days, so a poll at 00:05 UTC with `day_range=1` sees only five minutes of data and the
 * whole preceding night silently disappears. The overlap is free: re-polled rows mint the
 * same `detection_uid` and land as a no-op (pitfall 3, ADR-002 D1).
 */
export const FIRMS_DAY_RANGE = 2;

/** A parsed row, identified and stamped with the instant it became available to us. */
export interface IngestedDetection extends FirmsRow {
  readonly detectionUid: string;
  readonly availableAt: number;
}

export type PollOutcome = 'ok' | 'failed';

export interface FirmsPollRun {
  readonly source: SourceId;
  readonly outcome: PollOutcome;
  /** Set on `failed`, and only then. The message, not the thrown value. */
  readonly error?: string;
  /** The query as issued, minus the key. Recorded so a run can be reproduced. */
  readonly query: FirmsAreaQuery;
  readonly pollingBboxVersion: string;
  readonly sourceRegistryVersion: string;
  /**
   * `available_at` for the whole batch; every row inherits it. `null` only when the
   * source never answered — there is no instant at which rows we did not receive became
   * available to us, and a sentinel number would be a lie the archive keeps forever.
   */
  readonly availableAt: number | null;
  /** In the fixed order `(available_at, source, lat, lon, detection_uid)`. */
  readonly detections: readonly IngestedDetection[];
  readonly rejections: readonly FirmsRowRejection[];
  /**
   * Rows the response repeated within a single poll. Distinct from the cross-poll
   * overlap that pitfall 2 deliberately creates: a repeat *inside* one response means
   * either a genuinely duplicated upstream row or two rows that canonicalize together,
   * and it is worth a metric rather than a silent collapse.
   */
  readonly duplicatesWithinBatch: number;
}

export interface PollFirmsDeps {
  readonly client: FirmsAreaClient;
  readonly detectionUid: DetectionUidFn;
  /** Defaults to `polling_bbox_v1`; a backfill run pins the version it replays under. */
  readonly bbox?: typeof POLLING_BBOX;
}

/**
 * The sources a live cycle polls: FIRMS, and only the ones the registry still calls
 * active. A retired source is never queried again — MODIS stays in the registry for
 * backfill and fixture replay, and asking for it live would put a source into the
 * expected-overpass set that no longer flies.
 */
export function liveFirmsSources(): readonly SourceId[] {
  return SOURCE_IDS.filter((id) => {
    const entry = SOURCE_REGISTRY[id];
    return entry.status === 'active' && entry.queriedProduct.startsWith('VIIRS_');
  });
}

export function buildAreaQuery(
  source: SourceId,
  bbox: typeof POLLING_BBOX = POLLING_BBOX,
): FirmsAreaQuery {
  const entry = SOURCE_REGISTRY[source];
  if (!/^(VIIRS|MODIS)_/.test(entry.queriedProduct)) {
    // Wiring bug, not a source outage: EUMETSAT and LSA SAF do not answer this API at
    // all, so this must fail at the call site rather than become a recorded failed poll.
    throw new RangeError(`${source} is not served by the FIRMS Area API`);
  }
  return {
    source,
    product: entry.queriedProduct,
    area: firmsAreaArgument(bbox.values),
    dayRange: FIRMS_DAY_RANGE,
  };
}

export async function pollFirmsSource(
  source: SourceId,
  deps: PollFirmsDeps,
): Promise<FirmsPollRun> {
  const bbox = deps.bbox ?? POLLING_BBOX;
  const query = buildAreaQuery(source, bbox);
  const base = {
    source,
    query,
    pollingBboxVersion: bbox.version,
    sourceRegistryVersion: SOURCE_REGISTRY_VERSION,
  } as const;

  let response: FirmsAreaResponse;
  try {
    response = await deps.client.fetchArea(query);
  } catch (error) {
    // A failed poll is a recorded observation, not an absence of one: "no fires" and "no
    // data" must never look the same downstream (pitfall 10).
    return {
      ...base,
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
      availableAt: null,
      detections: [],
      rejections: [],
      duplicatesWithinBatch: 0,
    };
  }

  let parsed: FirmsCsvResult;
  try {
    parsed = parseFirmsCsv(response.csv, { source });
  } catch (error) {
    return {
      ...base,
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
      availableAt: response.availableAt,
      detections: [],
      rejections: [],
      duplicatesWithinBatch: 0,
    };
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

/**
 * One cycle across the given sources, sequentially and in registry order.
 *
 * Sequential on purpose. The quota is 5,000 transactions per 10 minutes against three
 * sources on a 10–15 minute cadence, so there is nothing to win by racing them, and a
 * fixed order means two runs of the same cycle produce the same sequence of poll runs —
 * which is what makes a recorded cycle replayable.
 */
export async function pollFirms(
  sources: readonly SourceId[],
  deps: PollFirmsDeps,
): Promise<readonly FirmsPollRun[]> {
  const runs: FirmsPollRun[] = [];
  for (const source of sources) {
    runs.push(await pollFirmsSource(source, deps));
  }
  return runs;
}
