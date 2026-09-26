/**
 * ε for one detection (ADR-002 D2 "ε per source", Appendix A rule 4).
 *
 * ε is the radius within which a detection is allowed to join an existing cluster. It is
 * a property of the *instrument*, not of the fire: a 375 m VIIRS pixel and a ~5 km GEO
 * pixel cannot use the same radius without either splitting one fire in two or gluing two
 * fires together.
 *
 * The MODIS rule is footprint-aware because an edge-of-swath pixel is ~4.8 × 2 km while a
 * nadir one is 1 × 2 km, and Appendix A rule 4 pins what happens when the footprint is
 * missing or unusable: the nadir pair is substituted *before* ε is computed, the row is
 * marked, and the mark is counted per batch. A NaN must never reach the clustering loop —
 * every comparison against a NaN ε is false, which does not fail, it just quietly stops a
 * fire from clustering.
 */

import { SOURCE_REGISTRY, type SourceId } from '@fire-watch/contracts';

import {
  CLUSTERING_PARAMS,
  type ClusteringParams,
  type EpsRule,
  type FootprintEpsRule,
} from './clustering-params.js';

/** The pixel footprint as the archive holds it: either a number or nothing. */
export interface FootprintInput {
  readonly scanKm: number | null;
  readonly trackKm: number | null;
}

export interface EpsResolution {
  readonly km: number;
  /**
   * The nadir footprint was substituted (Appendix A rule 4). Carried per row and counted
   * per batch so a source that silently drops the columns shows up as a number rather
   * than as a slowly re-shaping ε nobody notices.
   */
  readonly footprintDefaulted: boolean;
}

export function epsRuleFor(
  source: SourceId,
  params: ClusteringParams = CLUSTERING_PARAMS.values,
): EpsRule {
  // Read through a partial view: `source` is typed, but it reaches here from parsed data
  // (a fixture, an archive row), and a missing entry must be a loud error rather than an
  // `undefined` that turns into a NaN ε and silently stops a fire from clustering.
  const table: Readonly<Partial<Record<SourceId, EpsRule>>> = params.epsBySource;
  const rule = table[source];
  if (rule === undefined) {
    throw new RangeError(`no ε configured for source ${JSON.stringify(source)}`);
  }
  return rule;
}

export function epsKmFor(
  source: SourceId,
  footprint: FootprintInput,
  params: ClusteringParams = CLUSTERING_PARAMS.values,
): EpsResolution {
  const rule = epsRuleFor(source, params);
  if (rule.kind === 'fixed') {
    assertUsableEps(rule.km, source);
    return { km: rule.km, footprintDefaulted: false };
  }
  return footprintEps(rule, footprint, source);
}

/**
 * `max(floor, factor·√(scan·track))`.
 *
 * The substitution replaces the *pair*, not the broken axis: Appendix A states the nadir
 * footprint as "1.0 km (scan) × 2.0 km (track)" and states its consequence as
 * `ε = max(3, 1.5·√(1.0·2.0)) = 3 km`. Keeping a usable axis and defaulting the other
 * would produce a different ε for the same pinned case — 1.5·√(1.0·8.0) ≈ 4.24 km for a
 * row with `scan = null, track = 8` — which is exactly the kind of implementer's choice
 * this appendix exists to remove.
 */
function footprintEps(
  rule: FootprintEpsRule,
  footprint: FootprintInput,
  source: SourceId,
): EpsResolution {
  const measured = usable(footprint.scanKm) && usable(footprint.trackKm);
  const scanKm = measured ? (footprint.scanKm as number) : rule.defaultScanKm;
  const trackKm = measured ? (footprint.trackKm as number) : rule.defaultTrackKm;
  const km = Math.max(rule.floorKm, rule.factor * Math.sqrt(scanKm * trackKm));
  assertUsableEps(km, source);
  return { km, footprintDefaulted: !measured };
}

/** Missing, null, non-finite or ≤ 0 — the four cases Appendix A rule 4 enumerates. */
function usable(value: number | null): boolean {
  return value !== null && Number.isFinite(value) && value > 0;
}

function assertUsableEps(km: number, source: SourceId): void {
  if (!Number.isFinite(km) || km <= 0) {
    throw new RangeError(
      `ε for ${source} resolved to ${String(km)}; it must be finite and positive`,
    );
  }
}

/**
 * Coarse sources attach only: a GEO pixel covers ~4 × 5 km at our latitude, so letting it
 * seed an event would publish a fire nobody can point at, and letting it bridge two VIIRS
 * clusters would manufacture a chimera. The flag is registry data (`attachOnly`), not a
 * source-id string match here, so adding a geostationary source is one row in the
 * registry rather than an edit in the clustering loop.
 */
export function isAttachOnly(source: SourceId): boolean {
  return SOURCE_REGISTRY[source].attachOnly;
}
