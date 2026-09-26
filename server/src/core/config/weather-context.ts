/**
 * `weather_context_v1` — which ECMWF Open Data fields we record and from which runs
 * (TASKS C4; DATA-SOURCES §D2; TASKS A19 decision).
 *
 * A19 made ECMWF Open Data the source of record for our own weather inputs: CC BY 4.0,
 * no registration, 0.25° IFS, four runs a day. This config is that decision written as
 * data — the six surface fields, the steps we keep, and the publication delay we assume
 * — versioned so every recorded field names the parameter set it was recorded under.
 *
 * `tcc` is here deliberately: it is the licence-clean cloud-cover fallback DATA-SOURCES
 * names for when Open-Meteo (dev-only, §D3 licence fence) is off the table.
 */

import { defineConfig, type VersionedConfig } from './versioned-config.js';
import type { EpochMs } from '../ports/clock.js';
import type { ForecastCycleRef } from '../ports/weather-client.js';

export interface WeatherContextValues {
  /** ECMWF short names: 10 m wind u/v, 2 m temperature and dewpoint, precip, cloud. */
  readonly params: readonly string[];
  readonly levtype: string;
  /** Forecast steps (hours from the run) we record — now-ish plus the near forecast. */
  readonly steps: readonly number[];
  /** The four daily IFS runs, as UTC hours. */
  readonly cycleHours: readonly number[];
  /**
   * How long after its nominal time a run is assumed fully published. ECMWF's own
   * dissemination schedule for the open 0.25° data is ~7 h; 8 gives slack so we never
   * ask for a run that is still uploading and record a truncated field.
   */
  readonly publicationDelayHours: number;
  /** Sanity floor for one GRIB2 field — a real 0.25° global surface field is far larger. */
  readonly byteFloorBytes: number;
}

export const WEATHER_CONTEXT: VersionedConfig<WeatherContextValues> = defineConfig(
  'weather_context',
  'weather_context_v1',
  {
    params: ['10u', '10v', '2t', '2d', 'tp', 'tcc'],
    levtype: 'sfc',
    steps: [0, 6, 12],
    cycleHours: [0, 6, 12, 18],
    publicationDelayHours: 8,
    byteFloorBytes: 1024,
  } as const,
);

/**
 * The most recent run that is safely published at `now` — i.e. the latest cycle hour at
 * least `publicationDelayHours` in the past. Pure calendar arithmetic on the epoch
 * (`new Date(ms)` with an argument, so the determinism rule is satisfied); rolls to the
 * previous UTC day's last run when today has none published yet.
 */
export function latestPublishedCycle(
  now: EpochMs,
  values: WeatherContextValues = WEATHER_CONTEXT.values,
): ForecastCycleRef {
  const shifted = new Date(now - values.publicationDelayHours * 3_600_000);
  const hourOfDay = shifted.getUTCHours();
  const published = values.cycleHours.filter((hour) => hour <= hourOfDay);
  if (published.length > 0) {
    return { dateYmd: ymd(shifted), hour: Math.max(...published) };
  }
  const previousDay = new Date(shifted.getTime() - 86_400_000);
  return { dateYmd: ymd(previousDay), hour: Math.max(...values.cycleHours) };
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}
