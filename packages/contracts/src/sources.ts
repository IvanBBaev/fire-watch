/**
 * Source-id registry — frozen v1 (GLOSSARY §1a).
 *
 * These strings are permanent hash inputs over an append-only archive. The table is
 * closed: rows are appended, never renamed, re-cased or re-scoped, and retiring a
 * source changes only its status. Splitting `firms:modis` into per-platform ids later
 * would be a rename and is forbidden.
 *
 * v2 (V3-P4) appends three `reserved` rows for the v3 sources, so the adapters that
 * follow (V3-A1, A3, A4) never edit this file beyond their own entry. Sentinel-3 SLSTR
 * FRP (V3-A2) needs no new row: `eumetsat:slstr:frp` has been registered since v1.
 */

export const SOURCE_IDS = [
  'firms:viirs:snpp',
  'firms:viirs:noaa20',
  'firms:viirs:noaa21',
  'firms:modis',
  'eumetsat:slstr:frp',
  'lsasaf:seviri:frp-pixel',
  'lsasaf:fci:frp-pixel',
  // source_registry_v2 (V3-P4): reserved, not polled yet.
  'efa:firesat',
  'firms:landsat',
  'ororatech:frp',
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

/**
 * The registry rows whose status is `reserved` (V3-P4), written out rather than derived
 * for the same reason `MONITORED_SOURCE_IDS` is: an adapter going live removes its id
 * here and flips its row in the same edit, and `sources.test.ts` asserts the two agree.
 */
export const RESERVED_SOURCE_IDS = [
  'efa:firesat',
  'firms:landsat',
  'ororatech:frp',
] as const satisfies readonly SourceId[];

export type ReservedSourceId = (typeof RESERVED_SOURCE_IDS)[number];

/**
 * A source that can have produced a detection row: every id except the reserved ones.
 * Per-source parameter and label tables are total over this set, not over `SourceId`, so
 * a reserved id costs those versioned tables nothing (no digest change, no refit) and an
 * adapter going live is made to supply its numbers by the type check.
 */
export type LiveSourceId = Exclude<SourceId, ReservedSourceId>;

/**
 * `active` sources are polled and counted in the expected-overpass set. `retired` ones
 * are archive-only. `reserved` ones have an id but have never been polled: they are in no
 * live set, have no freshness budget, and leave the E-accumulator untouched. An adapter
 * going live flips its row to `active` with a new `statusEffectiveFrom`, and may settle
 * `queriedProduct` in the same edit (the id never changes).
 */
export type SourceStatus = 'active' | 'retired' | 'reserved';

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

export const SOURCE_REGISTRY_VERSION = 'source_registry_v2';

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
  // ── source_registry_v2 (V3-P4) — reserved rows. `queriedProduct` is provisional until
  // the adapter goes live; no access, terms or format exist for any of them yet.
  'efa:firesat': {
    // V3-A1: Earth Fire Alliance FireSat constellation, primary LEO detections.
    id: 'efa:firesat',
    queriedProduct: 'FIRESAT_NRT',
    productTier: 'NRT',
    status: 'reserved',
    statusEffectiveFrom: '2026-10-29',
    attachOnly: false,
  },
  'firms:landsat': {
    // V3-A3: FIRMS LANDSAT_NRT (OLI 30 m, Landsat 8 + 9 — one product, one id, GLOSSARY
    // §1a rule 2). Confirmation only, never a trigger: attach-only.
    id: 'firms:landsat',
    queriedProduct: 'LANDSAT_NRT',
    productTier: 'NRT',
    status: 'reserved',
    statusEffectiveFrom: '2026-10-29',
    attachOnly: true,
  },
  'ororatech:frp': {
    // V3-A4: commercial constellation (OroraTech), paid B2B tier only, behind a flag.
    id: 'ororatech:frp',
    queriedProduct: 'ORORATECH_FRP',
    productTier: 'NRT',
    status: 'reserved',
    statusEffectiveFrom: '2026-10-29',
    attachOnly: false,
  },
};

const SOURCE_ID_SET: ReadonlySet<string> = new Set<string>(SOURCE_IDS);
const RESERVED_SOURCE_ID_SET: ReadonlySet<string> = new Set<string>(RESERVED_SOURCE_IDS);

/** The live ids, in registry order. */
export const LIVE_SOURCE_IDS: readonly LiveSourceId[] = SOURCE_IDS.filter(
  (id): id is LiveSourceId => !RESERVED_SOURCE_ID_SET.has(id),
);

export function isLiveSourceId(value: string): value is LiveSourceId {
  return SOURCE_ID_SET.has(value) && !RESERVED_SOURCE_ID_SET.has(value);
}

/**
 * Narrows a stored source id to a live one for a per-source parameter lookup. A reserved
 * id is never polled, so it cannot reach a pipeline stage; one that does is a bug upstream
 * and fails loudly here rather than reading an undefined parameter.
 */
export function requireLiveSourceId(id: SourceId): LiveSourceId {
  if (!isLiveSourceId(id)) {
    throw new Error(`source ${id} is reserved (source_registry_v2) and has no parameters`);
  }
  return id;
}

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
