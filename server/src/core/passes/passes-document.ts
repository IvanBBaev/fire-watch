/**
 * The `/api/v1/passes/<cell>` document (TASKS F15): per platform, every predicted pass over
 * one grid cell from twelve hours back to a day ahead, and how old the elements behind the
 * prediction are.
 *
 * Pure and deterministic: the same cell, bucket and elements always produce the same
 * bytes, so the route's ETag is a content hash and a CDN can share one copy per cell per
 * ten minutes.
 *
 * ## Honest about its inputs
 *
 * Everything here is a **prediction** (`predicted: true`), from SGP4 elements whose epoch
 * is published alongside. Elements older than {@link TLE_STALE_AFTER_MS} are served with
 * `elements: "stale"` rather than withheld: a three-day-old element set still places a
 * polar orbiter within seconds of the truth, and "we don't know" would be less true than
 * "roughly here, from old data". A platform with no stored elements at all is listed as
 * `"missing"` with no passes — never silently dropped, so a reader can see a satellite is
 * unaccounted for rather than conclude it never comes.
 *
 * ## Cloud at each pass (TASKS F17)
 *
 * A pass only sees a fire through a clear sky, so each pass carries
 * `cloud_forecast_pct`: ECMWF IFS total cloud cover **forecast** for this cell at the
 * pass's culmination, linear in time between the two recorded forecast steps around it
 * (`cloud_cover_v1`). The document-level `cloud` block says what that number is — a
 * forecast, which runs it came from, how it was sampled — so no reader mistakes it for an
 * observation. A pass outside the recorded steps, or every pass when no cloud document is
 * stored yet, carries `null`: "no forecast", never a guess. Both fields are additive
 * (ADR-003 A1.3), so the schema version stays 1.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { EpochMs } from '../ports/clock.js';
import { epochMsFromIso, isoFromEpochMs } from '../ports/clock.js';
import { cloudAt, type CloudDocument } from '../weather/cloud-cover.js';
import type { OmmRecord } from './omm.js';
import { satrecFromOmm } from './omm.js';
import { computePasses, type Daylight } from './pass-compute.js';
import { passWindowFor, type PassCell } from './pass-grid.js';
import type { PassInstrument, PassPlatform, PassPlatformId } from './pass-platforms.js';

export const PASSES_SCHEMA_VERSION = 1;

/**
 * Three days. Along-track error of a sun-synchronous LEO grows by very roughly a few km
 * per day of element age — seconds of timing — so this is the age at which "predicted"
 * deserves a second word, not the age at which the prediction is wrong.
 */
export const TLE_STALE_AFTER_MS = 72 * 3_600_000;

export type ElementsState = 'current' | 'stale' | 'missing';

export interface PassWire {
  readonly aos: string;
  readonly culmination: string;
  readonly los: string;
  readonly max_elevation_deg: number;
  readonly cross_track_km: number;
  readonly in_swath: boolean;
  readonly daylight: Daylight;
  /** Forecast total cloud cover at the culmination, whole percent; `null` = no forecast. */
  readonly cloud_forecast_pct: number | null;
}

/** What `cloud_forecast_pct` is, so it can never be read as an observation. */
export interface PassesCloudWire {
  readonly kind: 'forecast';
  readonly provider: 'ecmwf-open-data';
  readonly model: 'ifs';
  readonly param: 'tcc';
  readonly at: 'culmination';
  readonly method: 'linear_in_time';
  /** The model runs behind at least one pass's value, ascending; empty when none had one. */
  readonly runs: readonly string[];
  readonly available_at: string;
  readonly cloud_cover_version: string;
}

export interface PlatformPassesWire {
  readonly id: PassPlatformId;
  readonly source: SourceId;
  readonly instrument: PassInstrument;
  readonly swath_km: number;
  readonly elements: ElementsState;
  readonly elements_epoch: string | null;
  readonly elements_age_hours: number | null;
  readonly passes: readonly PassWire[];
}

export interface PassesDocument {
  readonly schema_version: typeof PASSES_SCHEMA_VERSION;
  readonly cell: string;
  readonly point: { readonly lat: number; readonly lon: number };
  /** The bucket instant the window is anchored to. */
  readonly computed_for: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly predicted: true;
  /** Where the orbital elements come from; the web renders the credit from it. */
  readonly elements_provider: 'celestrak';
  /** `null` while no cloud forecast is stored; every pass then has `cloud_forecast_pct: null`. */
  readonly cloud: PassesCloudWire | null;
  readonly platforms: readonly PlatformPassesWire[];
}

export interface PlatformElements {
  readonly platform: PassPlatform;
  /** `null` when nothing verifiable is stored for this platform. */
  readonly record: OmmRecord | null;
}

export function elementsState(epochMs: EpochMs, atMs: EpochMs): Exclude<ElementsState, 'missing'> {
  return atMs - epochMs > TLE_STALE_AFTER_MS ? 'stale' : 'current';
}

export function buildPassesDocument(
  cell: PassCell,
  bucketMs: EpochMs,
  elements: readonly PlatformElements[],
  cloud: CloudDocument | null = null,
): PassesDocument {
  const window = passWindowFor(bucketMs);
  const runs = new Set<string>();
  const cloudPct = (culminationMs: EpochMs): number | null => {
    if (cloud === null) return null;
    const value = cloudAt(cloud, cell.centre, culminationMs);
    if (value === null) return null;
    for (const run of value.runs) runs.add(run);
    return value.pct;
  };
  const platforms = elements.map(({ platform, record }): PlatformPassesWire => {
    const base = {
      id: platform.id,
      source: platform.source,
      instrument: platform.instrument,
      swath_km: platform.swathKm,
    };
    if (record === null) {
      return {
        ...base,
        elements: 'missing' as const,
        elements_epoch: null,
        elements_age_hours: null,
        passes: [],
      };
    }
    const passes = computePasses(satrecFromOmm(record), cell.centre, window, platform.swathKm);
    return {
      ...base,
      elements: elementsState(record.epochMs, bucketMs),
      elements_epoch: isoFromEpochMs(Math.round(record.epochMs / 1000) * 1000),
      elements_age_hours: Math.round((bucketMs - record.epochMs) / 360_000) / 10,
      passes: passes.map((pass) => ({
        aos: isoFromEpochMs(pass.aosMs),
        culmination: isoFromEpochMs(pass.culminationMs),
        los: isoFromEpochMs(pass.losMs),
        max_elevation_deg: pass.maxElevationDeg,
        cross_track_km: pass.crossTrackKm,
        in_swath: pass.inSwath,
        daylight: pass.daylight,
        // Sampled at the culmination as rounded to the wire, so the value is reproducible
        // from the document alone.
        cloud_forecast_pct: cloudPct(epochMsFromIso(isoFromEpochMs(pass.culminationMs))),
      })),
    };
  });
  return {
    schema_version: PASSES_SCHEMA_VERSION,
    cell: cell.id,
    point: { lat: cell.centre.lat, lon: cell.centre.lon },
    computed_for: isoFromEpochMs(bucketMs),
    window: { from: isoFromEpochMs(window.fromMs), to: isoFromEpochMs(window.toMs) },
    predicted: true,
    elements_provider: 'celestrak',
    cloud:
      cloud === null
        ? null
        : {
            kind: 'forecast',
            provider: 'ecmwf-open-data',
            model: 'ifs',
            param: 'tcc',
            at: 'culmination',
            method: 'linear_in_time',
            runs: [...runs].sort(),
            available_at: cloud.available_at,
            cloud_cover_version: cloud.cloud_cover_version,
          },
    platforms,
  };
}
