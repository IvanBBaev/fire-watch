/**
 * The fire-detecting platforms whose passes the reader is told about (TASKS F15), and the
 * NORAD catalogue numbers their orbital elements are fetched under (DATA-SOURCES §F15).
 *
 * Only platforms behind an **active** polar source are listed: the three VIIRS satellites
 * and the two Sentinel-3 SLSTR satellites. Terra and Aqua (MODIS) still fly, but
 * `firms:modis` is retired, so a pass of theirs is not a look this product can turn into
 * a detection — telling a reader "Aqua looked at 13:40" would promise data we do not take.
 * Geostationary sources stare and have no pass to report.
 *
 * ## The swath is not a second copy
 *
 * Each platform's across-track swath comes from `pass_table_v0` (`static-pass-predictor.ts`),
 * which is where the product already states it. That table models per *source*: a VIIRS
 * source is one platform, so its `effectiveSwathKm` is that platform's swath; SLSTR folds
 * S3A and S3B into one source and carries **both** swaths summed (its docblock says so), so
 * one platform's swath is that value divided by the platforms folded into it. The only
 * number this file adds is that divisor, and a test pins it against the table's own prose.
 */

import { SOURCE_REGISTRY, type SourceId } from '@fire-watch/contracts';

import { PASS_TABLE } from '../lifecycle/static-pass-predictor.js';

export type PassPlatformId = 'snpp' | 'noaa20' | 'noaa21' | 's3a' | 's3b';

export type PassInstrument = 'viirs' | 'slstr';

export interface PassPlatform {
  readonly id: PassPlatformId;
  /** The CelesTrak / Space-Track catalogue number the elements are requested under. */
  readonly noradId: number;
  /** The detection source this platform's looks feed. */
  readonly source: SourceId;
  readonly instrument: PassInstrument;
  /** One platform's full across-track swath, derived from `pass_table_v0`. */
  readonly swathKm: number;
}

/**
 * How many platforms `pass_table_v0` folds into one source row. SLSTR's row carries S3A and
 * S3B together ("the pair is modelled as one look per phase carrying both swaths").
 */
const PLATFORMS_FOLDED_PER_SOURCE: Readonly<Partial<Record<SourceId, number>>> = {
  'eumetsat:slstr:frp': 2,
};

interface PlatformRow {
  readonly id: PassPlatformId;
  readonly noradId: number;
  readonly source: SourceId;
  readonly instrument: PassInstrument;
}

/**
 * NORAD ids from the CelesTrak SATCAT (checked 2026-09-30 against the OMM each returned:
 * `SUOMI NPP` 2011-061A, `NOAA 20 (JPSS-1)` 2017-073A, `NOAA 21 (JPSS-2)` 2022-150A,
 * `SENTINEL-3A` 2016-011A, `SENTINEL-3B` 2018-039A).
 */
const ROWS: readonly PlatformRow[] = [
  { id: 'noaa20', noradId: 43013, source: 'firms:viirs:noaa20', instrument: 'viirs' },
  { id: 'snpp', noradId: 37849, source: 'firms:viirs:snpp', instrument: 'viirs' },
  { id: 'noaa21', noradId: 54234, source: 'firms:viirs:noaa21', instrument: 'viirs' },
  { id: 's3a', noradId: 41335, source: 'eumetsat:slstr:frp', instrument: 'slstr' },
  { id: 's3b', noradId: 43437, source: 'eumetsat:slstr:frp', instrument: 'slstr' },
];

/** One platform's swath, from the pass table's row for its source. */
export function platformSwathKm(source: SourceId): number {
  const model = PASS_TABLE.values.sources.find((row) => row.source === source);
  if (model === undefined) {
    throw new RangeError(`pass_table_v0 has no row for ${source}; its swath is unknown`);
  }
  return model.effectiveSwathKm / (PLATFORMS_FOLDED_PER_SOURCE[source] ?? 1);
}

function buildPlatforms(): readonly PassPlatform[] {
  return ROWS.map((row) => {
    if (SOURCE_REGISTRY[row.source].status !== 'active') {
      throw new RangeError(`${row.id} feeds ${row.source}, which is not an active source`);
    }
    return { ...row, swathKm: platformSwathKm(row.source) };
  });
}

/** Canonical order: the order the document lists them and the web renders them. */
export const PASS_PLATFORMS: readonly PassPlatform[] = buildPlatforms();

export function platformByNoradId(noradId: number): PassPlatform | undefined {
  return PASS_PLATFORMS.find((platform) => platform.noradId === noradId);
}
