/**
 * Sensor families for the source filter. The reader thinks in instruments ("VIIRS",
 * "MODIS"), not in the seven registry ids, so the filter offers one entry per family and
 * maps every live `SourceId` onto exactly one of them. The table is typed against the
 * contracts registry: a source going live fails the type check here until it is assigned
 * a family, rather than silently falling out of every filter. Reserved ids (V3-P4) have
 * no family until then, so the filter offers nothing that cannot have data.
 *
 * The one-letter codes are wire-stable — they are written into the URL fragment (`src=`).
 */

import type { LiveSourceId } from '@fire-watch/contracts';

export const SOURCE_FAMILIES = ['v', 'm', 's', 'g'] as const;

/**
 * - `v` VIIRS (Suomi NPP, NOAA-20, NOAA-21) — 375 m polar orbiters.
 * - `m` MODIS (Terra/Aqua, retired in the registry, still in history).
 * - `s` SLSTR (Sentinel-3 FRP).
 * - `g` geostationary FRP (SEVIRI, FCI) — attach-only: it confirms, never creates, an event.
 */
export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

export const FAMILY_OF_SOURCE: Readonly<Record<LiveSourceId, SourceFamily>> = {
  'firms:viirs:snpp': 'v',
  'firms:viirs:noaa20': 'v',
  'firms:viirs:noaa21': 'v',
  'firms:modis': 'm',
  'eumetsat:slstr:frp': 's',
  'lsasaf:seviri:frp-pixel': 'g',
  'lsasaf:fci:frp-pixel': 'g',
};

export function familyOfSource(id: string): SourceFamily | null {
  return Object.hasOwn(FAMILY_OF_SOURCE, id) ? FAMILY_OF_SOURCE[id as LiveSourceId] : null;
}

export function parseSourceFamily(raw: string | null | undefined): SourceFamily | null {
  return raw != null && (SOURCE_FAMILIES as readonly string[]).includes(raw)
    ? (raw as SourceFamily)
    : null;
}
