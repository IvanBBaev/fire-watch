/**
 * A poll run, translated into the rows the archive stores (TASKS C1).
 *
 * Pure and deliberately boring — it is the seam where a value produced by the poller
 * becomes a value the store writes, and keeping the translation here rather than inside
 * the SQL adapter means the golden replay exercises the same mapping the live path uses.
 */

import { SOURCE_REGISTRY } from '@fire-watch/contracts';

import type { DetectionRecord, PollAttempt, WrittenProductTier } from '../ports/detection-store.js';
import type { FirmsPollRun, IngestedDetection } from './firms-poller.js';
import type { GranuleSlotRun, IngestedGranuleDetection } from './granule-poller.js';

export interface DetectionRecordOptions {
  /**
   * Overrides the registry's tier. Needed for the 2020–2025 backfill (TASKS B8), whose
   * rows are `SP` even though the source they came from is polled as `NRT` today.
   */
  readonly productTier?: WrittenProductTier;
  /**
   * The ingest anomaly breaker tripped on this batch (TASKS C2). Batch-wide, because that
   * is the granularity the breaker decides at: it judges the response, not the row. The
   * rows still land — a false trip on the biggest fire day of the season must not become
   * permanent data loss — they land marked, and alerting skips them.
   */
  readonly quarantined?: boolean;
}

/**
 * The rows of one poll run. A failed run has no detections and therefore no rows — the
 * failure is recorded through {@link pollAttempt}, not as an absence of data here.
 */
export function detectionRecords(
  run: FirmsPollRun,
  options: DetectionRecordOptions = {},
): readonly DetectionRecord[] {
  const productTier = options.productTier ?? registryTier(run);
  const quarantined = options.quarantined ?? false;
  return run.detections.map((detection) => toRecord(detection, run, productTier, quarantined));
}

function registryTier(run: FirmsPollRun): WrittenProductTier {
  const tier = SOURCE_REGISTRY[run.source].productTier;
  if (tier === null) {
    // A retired source has no live tier, so a batch attributed to it can only be a
    // backfill — and a backfill that forgot to say `SP` would write rows that claim to
    // be near-real-time observations made years ago.
    throw new RangeError(
      `${run.source} has no product tier in the registry; a batch from it must state ` +
        'its tier explicitly (it is archive-only, so that tier is SP)',
    );
  }
  return tier;
}

function toRecord(
  detection: IngestedDetection,
  run: FirmsPollRun,
  productTier: WrittenProductTier,
  quarantined: boolean,
): DetectionRecord {
  return {
    detectionUid: detection.detectionUid,
    source: detection.source,
    productTier,
    acqTsIso: detection.acqTsIso,
    availableAt: detection.availableAt,
    lat: detection.latCanonical,
    lon: detection.lonCanonical,
    scanKm: detection.scanKm,
    trackKm: detection.trackKm,
    frpMw: detection.frpMw,
    brightnessK: detection.brightnessK,
    brightnessBgK: detection.brightnessSecondaryK,
    confidenceRaw: detection.confidenceRaw,
    confidence: detection.confidence,
    dayNight: detection.dayNight,
    // An absent `version` column is absent, not the empty string: `collection_version`
    // is compared against provider values, and '' would sort and group as a real one.
    collectionVersion: detection.versionRaw === '' ? null : detection.versionRaw,
    sourceRegistryVersion: run.sourceRegistryVersion,
    ingestConfigVersion: run.pollingBboxVersion,
    quarantined,
  };
}

/**
 * The rows of one geostationary slot (TASKS C3).
 *
 * Same destination table, same tier rule, one difference worth stating: the tier comes
 * from the registry and is `GEO`, which is what makes these rows attach-only downstream
 * (ADR-002) and keeps them from ever raising an alert on their own (ADR-004 D4).
 */
export function granuleDetectionRecords(
  run: GranuleSlotRun,
  options: DetectionRecordOptions = {},
): readonly DetectionRecord[] {
  const productTier = options.productTier ?? granuleTier(run);
  const quarantined = options.quarantined ?? false;
  return run.detections.map((detection) =>
    toGranuleRecord(detection, run, productTier, quarantined),
  );
}

function granuleTier(run: GranuleSlotRun): WrittenProductTier {
  const tier = SOURCE_REGISTRY[run.source].productTier;
  if (tier === null) {
    throw new RangeError(`${run.source} has no product tier in the registry`);
  }
  return tier;
}

function toGranuleRecord(
  detection: IngestedGranuleDetection,
  run: GranuleSlotRun,
  productTier: WrittenProductTier,
  quarantined: boolean,
): DetectionRecord {
  return {
    detectionUid: detection.detectionUid,
    source: detection.source,
    productTier,
    acqTsIso: detection.acqTsIso,
    availableAt: detection.availableAt,
    lat: detection.latCanonical,
    lon: detection.lonCanonical,
    scanKm: detection.scanKm,
    trackKm: detection.trackKm,
    frpMw: detection.frpMw,
    brightnessK: detection.brightnessK,
    brightnessBgK: detection.brightnessBgK,
    confidenceRaw: detection.confidenceRaw,
    confidence: detection.confidence,
    // A geostationary instrument sees the same spot at noon and at midnight; the product
    // does not report a day/night flag and inventing one from the slot would be a claim
    // about solar geometry that nothing here has computed.
    dayNight: null,
    // The product identifier is the closest thing LSA SAF has to a collection version,
    // and it is what distinguishes an LSA-502 row from an LSA-509 one in the archive.
    collectionVersion: SOURCE_REGISTRY[run.source].queriedProduct,
    sourceRegistryVersion: run.sourceRegistryVersion,
    ingestConfigVersion: run.pollingBboxVersion,
    quarantined,
  };
}

/**
 * The freshness transition one slot causes.
 *
 * A `missing` slot counts as the source having answered. On a fixed grid a 404 is an
 * answer — the provider is up and that quarter-hour has no granule — so treating it as an
 * outage would put the GEO leg permanently in alarm during a quiet season. The reason is
 * kept anyway: an operator looking at a stalled `last_data_at` should be able to see
 * whether the slots were absent or the fetches were.
 */
export function granulePollAttempt(run: GranuleSlotRun, now: number): PollAttempt {
  return {
    source: run.source,
    attemptAt: run.availableAt ?? now,
    succeeded: run.outcome === 'ok' || run.outcome === 'missing',
    receivedRows: run.detections.length,
    error: run.outcome === 'ok' ? null : (run.error ?? null),
  };
}

/**
 * The freshness transition one poll run causes.
 *
 * `now` is used only when the source never answered: a failed poll has no `available_at`
 * — nothing became available — but it did happen, and the attempt has to be timestamped
 * or an outage is indistinguishable from a scheduler that stopped running.
 */
export function pollAttempt(run: FirmsPollRun, now: number): PollAttempt {
  return {
    source: run.source,
    attemptAt: run.availableAt ?? now,
    succeeded: run.outcome === 'ok',
    receivedRows: run.detections.length,
    error: run.error ?? null,
  };
}
