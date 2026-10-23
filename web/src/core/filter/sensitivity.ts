/**
 * The sensitivity filter (V2-A2): hide signals that are low-confidence or seen only once,
 * for a reader who wants fewer, firmer dots.
 *
 * Three criteria, all of which must hold, each on a field the event already carries:
 *
 * - `minBand` — the lowest score bucket shown (`unverified` < `likely` < `confirmed`,
 *   ADR-002 D6; the bucket arrives decided, nothing is re-scored here).
 * - `minDetections` — the lowest `detectionCount`.
 * - `minSensors` — the lowest number of distinct sources in `sourceIds` (two satellites
 *   carrying the same instrument count twice: they are independent passes).
 *
 * Three presets name the useful combinations; any other combination is "custom" and is
 * still a valid, shareable state. The preset thresholds are a founder decision — they are
 * named once here so the bar, the hash and the tests cannot disagree about them.
 *
 * **Fail open, per criterion.** A field the client cannot read never hides an event: an
 * unknown or missing bucket passes the band criterion, a missing or non-finite
 * `detectionCount` passes the detection criterion, and absent or empty `sourceIds` pass
 * the sensor criterion (the server serves `source_ids: null` when the source mix is empty,
 * and a cached pre-F12 body has no field). Hiding those would read as "not confirmed"
 * when the truth is "the feed did not say".
 *
 * A display filter, not a judgement: hiding a signal says nothing about whether it is a
 * fire, and the bar says so whenever a preset other than "all" is chosen.
 */

import { SCORE_BUCKETS, type ScoreBucket } from '@fire-watch/contracts';

import type { FireEvent } from '../types.js';

export interface SensitivityCriteria {
  readonly minBand: ScoreBucket;
  readonly minDetections: number;
  readonly minSensors: number;
}

export const SENSITIVITY_PRESET_IDS = ['all', 'balanced', 'multi'] as const;
export type SensitivityPresetId = (typeof SENSITIVITY_PRESET_IDS)[number];

/** Founder decision: the thresholds behind each preset name. */
export const SENSITIVITY_PRESETS: Readonly<Record<SensitivityPresetId, SensitivityCriteria>> = {
  all: { minBand: 'unverified', minDetections: 1, minSensors: 1 },
  balanced: { minBand: 'likely', minDetections: 2, minSensors: 1 },
  multi: { minBand: 'likely', minDetections: 2, minSensors: 2 },
};

export const DEFAULT_SENSITIVITY: SensitivityCriteria = SENSITIVITY_PRESETS.all;

/** The choices the advanced controls offer; the hash accepts any value in range. */
export const DETECTION_STEPS = [1, 2, 3, 5] as const;
export const SENSOR_STEPS = [1, 2, 3] as const;
const MAX_THRESHOLD = 99;

export type SensitivityFilterable = Partial<
  Pick<FireEvent, 'scoreBucket' | 'detectionCount' | 'sourceIds'>
>;

function bandRank(band: unknown): number | null {
  const index = (SCORE_BUCKETS as readonly unknown[]).indexOf(band);
  return index === -1 ? null : index;
}

/** Distinct sources that saw the event, or `null` when the feed did not say. */
export function sensorCountOf(event: Pick<SensitivityFilterable, 'sourceIds'>): number | null {
  const ids = event.sourceIds;
  if (ids === undefined || ids.length === 0) return null;
  return new Set(ids).size;
}

export function isDefaultSensitivity(criteria: SensitivityCriteria): boolean {
  return sameCriteria(criteria, DEFAULT_SENSITIVITY);
}

export function sameCriteria(a: SensitivityCriteria, b: SensitivityCriteria): boolean {
  return (
    a.minBand === b.minBand && a.minDetections === b.minDetections && a.minSensors === b.minSensors
  );
}

/** The preset these criteria spell, or `null` for a custom combination. */
export function presetOf(criteria: SensitivityCriteria): SensitivityPresetId | null {
  return (
    SENSITIVITY_PRESET_IDS.find((id) => sameCriteria(SENSITIVITY_PRESETS[id], criteria)) ?? null
  );
}

export function matchesSensitivity(
  event: SensitivityFilterable,
  criteria: SensitivityCriteria,
): boolean {
  const rank = bandRank(event.scoreBucket);
  const floor = bandRank(criteria.minBand) ?? 0;
  if (rank !== null && rank < floor) return false;
  const detections = event.detectionCount;
  if (
    typeof detections === 'number' &&
    Number.isFinite(detections) &&
    detections < criteria.minDetections
  ) {
    return false;
  }
  const sensors = sensorCountOf(event);
  if (sensors !== null && sensors < criteria.minSensors) return false;
  return true;
}

/**
 * Whether the sensor criterion had to pass the event blind — it asks for more than one
 * sensor and the feed did not say which saw it. Counted so the bar can say so.
 */
export function sensorsUnreportedFor(
  event: SensitivityFilterable,
  criteria: SensitivityCriteria,
): boolean {
  return criteria.minSensors > 1 && sensorCountOf(event) === null;
}

/* ------------------------------------------------------------------------ */
/* Fragment form                                                             */
/* ------------------------------------------------------------------------ */

/**
 * `sens=bal`, `sens=multi`, or a custom `sens=<band>.<detections>.<sensors>` with the band
 * as its initial (`u`, `l`, `c`), e.g. `sens=c.3.1`. The default is never written, so every
 * link made before this filter existed still opens as before.
 */
const PRESET_TOKENS: Readonly<Record<SensitivityPresetId, string>> = {
  all: 'all',
  balanced: 'bal',
  multi: 'multi',
};

const BAND_TOKENS: Readonly<Record<ScoreBucket, string>> = {
  unverified: 'u',
  likely: 'l',
  confirmed: 'c',
};

export function sensitivityHashValue(criteria: SensitivityCriteria): string | null {
  if (isDefaultSensitivity(criteria)) return null;
  const preset = presetOf(criteria);
  if (preset !== null) return PRESET_TOKENS[preset];
  return `${BAND_TOKENS[criteria.minBand]}.${String(criteria.minDetections)}.${String(criteria.minSensors)}`;
}

function parseThreshold(raw: string): number | null {
  if (!/^[1-9]\d?$/.test(raw)) return null;
  const value = Number(raw);
  return value <= MAX_THRESHOLD ? value : null;
}

/** `null` for anything that is not a valid value, so a hand-edited link ignores it. */
export function parseSensitivity(raw: string | null | undefined): SensitivityCriteria | null {
  if (raw === null || raw === undefined) return null;
  for (const id of SENSITIVITY_PRESET_IDS) {
    if (PRESET_TOKENS[id] === raw) return SENSITIVITY_PRESETS[id];
  }
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [bandToken, detectionsRaw, sensorsRaw] = parts as [string, string, string];
  const minBand = SCORE_BUCKETS.find((band) => BAND_TOKENS[band] === bandToken);
  const minDetections = parseThreshold(detectionsRaw);
  const minSensors = parseThreshold(sensorsRaw);
  if (minBand === undefined || minDetections === null || minSensors === null) return null;
  return { minBand, minDetections, minSensors };
}
