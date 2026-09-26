/**
 * `clustering_params_v1` — the identity engine's parameters as versioned data
 * (ADR-002 D2 and D5, with Appendix A / Amendment A2.5 folded in).
 *
 * Nothing here is a literal at a call site. Every value below decides whether two
 * detections are the same fire, and therefore whether a `public_id` that has already been
 * published stays attached to the same burn. A replay of last September must cluster with
 * *last September's* ε and T_LINK, so the version travels with every event row
 * (`fire_events.config_version`) and the digest travels with every replay report.
 *
 * Appendix A pins the tie and boundary rules "in `clustering_params_v1`", so the pinned
 * constants live in this object rather than in the code that applies them: the nadir
 * footprint substitution, the fuel band that unclassified land cover falls into, the
 * reignition radius multiple, and the quantum every distance comparison is rounded to.
 * The rules that *use* them are `eps.ts`, `geometry.ts` and `reignition-window.ts`.
 *
 * Tuning is a pull request against this file plus a version bump, never an edit in place:
 * two runs that claim the same version must be byte-identical, and the digest is what
 * catches an edit that forgot to bump.
 */

import type { SourceId } from '@fire-watch/contracts';

import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';

/** ε that does not depend on the row — the instrument's pixel is the same everywhere. */
export interface FixedEpsRule {
  readonly kind: 'fixed';
  readonly km: number;
}

/**
 * ε computed from the row's own pixel footprint: `max(floorKm, factor·√(scan·track))`.
 * Edge-of-swath MODIS pixels are ~4.8 × 2 km, so a fixed ε either splits a fire at the
 * swath edge or over-merges at nadir.
 */
export interface FootprintEpsRule {
  readonly kind: 'footprint';
  readonly floorKm: number;
  readonly factor: number;
  /**
   * The nadir footprint substituted when the row carries no usable one (Appendix A rule
   * 4). Literals rather than an import from `core/ingest`, because this file is data and
   * importing behaviour into it would make the digest depend on a code path;
   * `clustering-params.test.ts` pins them equal to `NADIR_SCAN_KM`/`NADIR_TRACK_KM` so
   * the two definitions cannot drift.
   */
  readonly defaultScanKm: number;
  readonly defaultTrackKm: number;
}

export type EpsRule = FixedEpsRule | FootprintEpsRule;

/**
 * Fuel bands for the reignition window (ADR-002 D2 "Reignition vs continuation",
 * GLOSSARY §6). The classification itself — hull → land cover → majority class — is D3
 * work; this is only the band vocabulary the window table is keyed by.
 */
export const FUEL_BANDS = ['grass', 'mixed', 'forest'] as const;
export type FuelBand = (typeof FUEL_BANDS)[number];

/**
 * The fixed planar metric distances are measured in.
 *
 * A local tangent plane rather than a haversine, for one reason: determinism across
 * engines. ECMAScript does not require `Math.sin`/`Math.cos`/`Math.atan2` to be correctly
 * rounded, so a haversine can differ in the last bits between two V8 versions — and a
 * distance that differs in the last bits at exactly ε flips a detection between two
 * events, which changes a `public_id`. The formula in `geometry.ts` uses only `+`, `−`,
 * `×` and `sqrt`, all of which IEEE-754 specifies exactly.
 *
 * The longitudinal scale is linear in latitude around the reference, which over the
 * polled box (39°–46° N) tracks the true meridian-corrected value to within 0.2 % — under
 * 3 m across a 1.5 km ε — and to within 0.08 % over Bulgaria proper. `geometry.test.ts`
 * measures both against the WGS-84 arc-length series and fails if a retune widens them.
 * The scale is deliberately part of the versioned config: refitting ε and refitting the
 * metric ε is measured in are the same act, and both must move the version.
 */
export interface PlanarMetric {
  readonly referenceLatDeg: number;
  readonly kmPerDegreeLat: number;
  readonly kmPerDegreeLonAtReference: number;
  /** d(km per degree of longitude)/d(latitude in degrees), at the reference latitude. */
  readonly kmPerDegreeLonPerDegreeLat: number;
  /**
   * Every distance and every ε is rounded to a multiple of this before comparison
   * (Appendix A rules 1 and 3). Without it "exactly equidistant" and "exactly ε" are
   * unreachable states — `41.91 - 41.90` and `41.92 - 41.91` differ by ~1e-15 in double
   * arithmetic — and the pinned tie-breaks would be dead code that never fires while the
   * real winner is decided by floating-point noise. 1e-6 km is 1 mm: three orders of
   * magnitude below the ~1.1 m resolution of a 5-decimal coordinate, so it cannot merge
   * two genuinely different distances, and twelve orders above the noise it absorbs.
   */
  readonly quantumKm: number;
}

export interface ClusteringParams {
  /**
   * ε per source, keyed by the frozen §1a registry id. A `Record` over `SourceId` on
   * purpose: adding a source to the registry without deciding its ε is a type error, not
   * a runtime surprise where the new source silently clusters at someone else's radius.
   */
  readonly epsBySource: Readonly<Record<SourceId, EpsRule>>;
  /** Same-event temporal gap. Fitted as the p99 intra-fire gap; expected 36–60 h. */
  readonly tLinkHours: number;
  /** Trailing window a cluster stays attach-eligible for past its last detection. */
  readonly activeWindowHours: number;
  /** Fuel-specific reignition windows, in days (D2; 7 / 14 / 21–30 d bands). */
  readonly reignitionWindowDays: Readonly<Record<FuelBand, number>>;
  /**
   * The band an unclassified, null or no-majority land cover falls into (Appendix A rule
   * 5). Stored as a band name rather than a number so the rule is structurally true: it
   * can only ever resolve to one of the three bands, never to a fourth value someone
   * typed.
   */
  readonly unclassifiedFuelBand: FuelBand;
  /** A reignition candidate must lie within this multiple of ε of the new cluster (D2). */
  readonly reignitionEpsMultiple: number;
  /**
   * Hull diameter above which an event is flagged `needs_review` (D4). Not a split
   * threshold — D4 forbids automatic splits — but the width at which "this may be two
   * fires" stops being a suspicion the engine can keep to itself. A bound, so a hull of
   * exactly this diameter is still inside it (Appendix A rule 3).
   */
  readonly reviewHullDiameterKm: number;
  readonly metric: PlanarMetric;
}

/**
 * Initial values (ADR-002 D2 "ε per source ... tuned per Decision 5"). Where the ADR
 * states a range, the midpoint is taken and the range is quoted next to it, so the next
 * reader can tell a fitted number from a placeholder. D7 refits ε, T_LINK and T_REIGNITE
 * from labeled backfill and lands them as `clustering_params_v2`.
 */
export const CLUSTERING_PARAMS: VersionedConfig<ClusteringParams> = defineConfig(
  'clustering_params',
  'clustering_params_v1',
  {
    epsBySource: {
      // VIIRS: ADR range 1.0–1.5 km, midpoint taken. The 375 m pixel is far smaller than
      // ε — ε is the gap a fire front is allowed to have between detections, not the
      // pixel size.
      'firms:viirs:snpp': { kind: 'fixed', km: 1.25 },
      'firms:viirs:noaa20': { kind: 'fixed', km: 1.25 },
      'firms:viirs:noaa21': { kind: 'fixed', km: 1.25 },
      // MODIS: max(3 km, 1.5·√(scan·track)). Retired at the v1 freeze, so this rule is
      // exercised only by backfill, SP promotion and fixture replay — all of which are
      // paths where a wrong ε rewrites history rather than a live map.
      'firms:modis': {
        kind: 'footprint',
        floorKm: 3,
        factor: 1.5,
        defaultScanKm: 1.0,
        defaultTrackKm: 2.0,
      },
      'eumetsat:slstr:frp': { kind: 'fixed', km: 1.5 },
      // GEO: ADR range 5–6 km, midpoint taken. These sources are attach-only, so a
      // slightly generous ε cannot manufacture an event — at worst it corroborates the
      // wrong one, which scoring can still discount.
      'lsasaf:seviri:frp-pixel': { kind: 'fixed', km: 5.5 },
      'lsasaf:fci:frp-pixel': { kind: 'fixed', km: 5.5 },
    },
    // Midpoint of the ADR's expected 36–60 h band. Too small splits one fire into two
    // events across a cloudy day; too large bridges two fires in the same valley a week
    // apart. Only the second failure is invisible to the user, which is the argument for
    // not rounding this one up before it is fitted.
    tLinkHours: 48,
    activeWindowHours: 72,
    // 7 d grass/agricultural or <100 ha; 14 d shrub/mixed or 100–1,000 ha; the ADR states
    // 21–30 d for forest and the lower bound is pinned: the window's only effect is to
    // make a "possible reignition of …" claim about a real fire, and the conservative
    // direction is fewer claims until D7 has data to widen it.
    reignitionWindowDays: { grass: 7, mixed: 14, forest: 21 },
    unclassifiedFuelBand: 'mixed',
    reignitionEpsMultiple: 2,
    // The reviews behind D4 landed on a 15–25 km band; 20 km is its midpoint and the value
    // the ADR states. Both directions cost something real and neither is safe by default:
    // too low buries a reviewer under complexes that are genuinely one fire, too high lets
    // a chain of ε-hops merge two valleys into one row that a single alert then describes
    // badly. Fitted against labeled complexes in D7 along with ε and T_LINK.
    reviewHullDiameterKm: 20,
    metric: {
      referenceLatDeg: 42.7,
      // Meridian and prime-vertical arc lengths at 42.7° N, from the standard series
      // (WGS-84): 111.132 − 0.566·cos 2φ + 0.0012·cos 4φ and 111.415·cos φ − 0.0946·cos 3φ.
      kmPerDegreeLat: 111.085,
      kmPerDegreeLonAtReference: 81.936,
      kmPerDegreeLonPerDegreeLat: -1.3146,
      quantumKm: 1e-6,
    },
  } as const,
);

export function tLinkMs(params: ClusteringParams = CLUSTERING_PARAMS.values): number {
  return params.tLinkHours * 3_600_000;
}

export function activeWindowMs(params: ClusteringParams = CLUSTERING_PARAMS.values): number {
  return params.activeWindowHours * 3_600_000;
}
