/**
 * Source-id registry — frozen v1 (GLOSSARY §1a).
 *
 * These strings are permanent hash inputs over an append-only archive. The table is
 * closed: rows are appended, never renamed, re-cased or re-scoped, and retiring a
 * source changes only its status. Splitting `firms:modis` into per-platform ids later
 * would be a rename and is forbidden.
 */

export const SOURCE_IDS = [
  'firms:viirs:snpp',
  'firms:viirs:noaa20',
  'firms:viirs:noaa21',
  'firms:modis',
  'eumetsat:slstr:frp',
  'lsasaf:seviri:frp-pixel',
  'lsasaf:fci:frp-pixel',
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

/** `active` sources are polled and counted in the expected-overpass set. */
export type SourceStatus = 'active' | 'retired';

/** Exactly one tier is polled per source; `null` means the source is archive-only. */
export type ProductTier = 'NRT' | 'GEO' | null;

export interface SourceRegistryEntry {
  readonly id: SourceId;
  readonly queriedProduct: string;
  readonly productTier: ProductTier;
  readonly status: SourceStatus;
  /**
   * The date the current status took effect, so a replay reproduces the constellation
   * as it was rather than as it is (ADR-002 Amendment A2.3).
   */
  readonly statusEffectiveFrom: string;
  /** GEO sources attach to existing clusters and never create or merge events. */
  readonly attachOnly: boolean;
}

export const SOURCE_REGISTRY_VERSION = 'source_registry_v1';

export const SOURCE_REGISTRY: Readonly<Record<SourceId, SourceRegistryEntry>> = {
  'firms:viirs:snpp': {
    id: 'firms:viirs:snpp',
    queriedProduct: 'VIIRS_SNPP_NRT',
    productTier: 'NRT',
    status: 'active',
    statusEffectiveFrom: '2026-08-02',
    attachOnly: false,
  },
  'firms:viirs:noaa20': {
    id: 'firms:viirs:noaa20',
    queriedProduct: 'VIIRS_NOAA20_NRT',
    productTier: 'NRT',
    status: 'active',
    statusEffectiveFrom: '2026-08-02',
    attachOnly: false,
  },
  'firms:viirs:noaa21': {
    id: 'firms:viirs:noaa21',
    queriedProduct: 'VIIRS_NOAA21_NRT',
    productTier: 'NRT',
    status: 'active',
    statusEffectiveFrom: '2026-08-02',
    attachOnly: false,
  },
  'firms:modis': {
    id: 'firms:modis',
    queriedProduct: 'MODIS_NRT',
    productTier: null,
    status: 'retired',
    // Retired at the v1 freeze: archive, backfill and fixture replay only. Aqua shut
    // down ~Aug 2026 and Terra follows ~Feb 2027, so the source never enters the live
    // poll set and must not weigh on the expected-overpass side of the E-accumulator.
    statusEffectiveFrom: '2026-08-02',
    attachOnly: false,
  },
  'eumetsat:slstr:frp': {
    id: 'eumetsat:slstr:frp',
    queriedProduct: 'SL_2_FRP___',
    productTier: 'NRT',
    status: 'active',
    statusEffectiveFrom: '2026-08-02',
    attachOnly: false,
  },
  'lsasaf:seviri:frp-pixel': {
    id: 'lsasaf:seviri:frp-pixel',
    queriedProduct: 'LSA-502',
    productTier: 'GEO',
    status: 'active',
    statusEffectiveFrom: '2026-08-02',
    attachOnly: true,
  },
  'lsasaf:fci:frp-pixel': {
    id: 'lsasaf:fci:frp-pixel',
    queriedProduct: 'LSA-509',
    productTier: 'GEO',
    status: 'active',
    statusEffectiveFrom: '2026-08-02',
    attachOnly: true,
  },
};

const SOURCE_ID_SET: ReadonlySet<string> = new Set<string>(SOURCE_IDS);

export function isSourceId(value: string): value is SourceId {
  return SOURCE_ID_SET.has(value);
}

export function assertSourceId(value: string): SourceId {
  if (!isSourceId(value)) {
    throw new RangeError(
      `unknown source id ${JSON.stringify(value)}: not in ${SOURCE_REGISTRY_VERSION}`,
    );
  }
  return value;
}

/** The live poll set. Retired sources are never polled again. */
export function activeSources(): readonly SourceRegistryEntry[] {
  return SOURCE_IDS.map((id) => SOURCE_REGISTRY[id]).filter((e) => e.status === 'active');
}

/**
 * Sources that contribute expected overpasses to the E-accumulator. A retired source
 * leaves this set, which is what stops a permanently blown freshness budget from
 * freezing E forever (ADR-002 Amendment A2.3; review 14 H1).
 */
export function expectedOverpassSources(): readonly SourceRegistryEntry[] {
  return activeSources();
}
