/**
 * When the static hot-source mask decides an event (TASKS F16; 11-data-science §3.6 and
 * §6.2 item 2, 03-geodata §5.2.2 step 1 and §5.2.4, GATES S4/S10, GLOSSARY
 * `static_source`).
 *
 * ## What the spec says
 *
 * §3.6: "Static hot-source mask hit → detection tagged `static_source`, never clustered
 * into public events. If an *event* ends up overlapping the mask, confidence_score := 0 and
 * status invalidated." §5.2.2 step 1 is the detection half: a detection inside a mask
 * polygon is skipped before clustering. §6.2 item 2 adds the self-learning half: "≥ 3
 * daytime-only detections at the same ~pixel coordinates across ≥ 2 distinct days with zero
 * night detections ever ⇒ auto-quarantine as `suspected_static_source` pending review"
 * (GATES S10: "no alert ever").
 *
 * ## What this implements, and the one delta
 *
 * **The per-detection tag** is {@link tagDetection}: pure, derived from the row, the mask
 * and this policy, never stored. **Delta from §5.2.2:** a tagged detection is still
 * clustered. Skipping it before clustering would make identity depend on the mask — a mask
 * refresh would re-mint, split or merge public ids — which ADR-002 D2 forbids (identity is
 * a function of detections and `clustering_params` only). "Never clustered into *public*
 * events" is reached one step later instead: an event is `static_source` exactly when
 * **every** one of its detections carries an `override` tag. Under §5.2.2 such an event
 * would never have existed, so invalidating it is the event-level equivalent of the skip;
 * an event with even one detection off the mask would have existed under §5.2.2 too (built
 * from its other detections), so it is never invalidated by the mask. A real fire next to a
 * solar park is therefore never hidden — only a cluster made of nothing but mask pixels is.
 * GATES S4 "never becomes an event" is read as "never becomes a *public* event": the row
 * exists (the replay and the audit trail need it) but is invalidated, which the snapshot,
 * the change stream consumers, reignition and alerting all exclude.
 *
 * **The quarantine** is {@link dayOnlyRepeat}: no member is a night detection, at least
 * `minDayDetections` are day detections spanning `minDistinctDays` UTC dates, and every
 * member sits within `siteDiameterM` of every other ("the same ~pixel coordinates"). It
 * needs no mask — it is how a source the mask does not know yet gets caught. Neither
 * verdict is sticky: both are re-evaluated on every rescore, so the first night detection
 * or the first detection off the site releases a quarantined event (a fire that is only
 * ever seen by day and never moves is rare; one that spreads is not a chimney), the first
 * detection off the mask releases an overridden one, and a mask refresh that drops a
 * wrongly mapped source releases every event it decided. Only curation's invalidations
 * are sticky (the store's rule).
 * "Pending review" is the curation queue's `invalidated_reason = 'suspected_static_source'`
 * filter; nothing here promotes a suspect into the mask.
 *
 * ## The founder switch
 *
 * `kindEffects` says per kind whether a hit overrides (score 0, invalidated) or only
 * annotates (verdict `annotated`, the web caveat, no score effect). Every kind overrides in
 * v2, as in v1: §6.2 seeds the solar layer from OSM and §5.2.4 lists thermal plants, the
 * refinery and the steel works as the curated core, so all four are "static hot sources" in
 * the spec's sense. The open founder call — "should a solar park override, or only
 * caveat?" (solar is the least certain: PV false positives are rarer in VIIRS than flares
 * are) — is answered by a `static_source_policy_v3` that sets `solar: 'annotate'`, not by a
 * code change. The quarantine has its own `enabled` switch for the same reason.
 *
 * "On a source" is: inside a polygon (buffer `polygonHitBufferM`, 0 m — the spec says
 * *inside*), or within `pointHitRadiusM` of a point source (a node-mapped flare, or a plant
 * too small to keep a polygon; a point has no inside, so it needs a radius). Distances use
 * the clustering metric (`clustering_params_v1.metric`), so "within 500 m" here and "within
 * 1.5 km" in the clusterer are measured on the same plane.
 *
 * ## Determinism (D7)
 *
 * A verdict is a function of the member *set* (never its order), the mask *version* and the
 * policy *version*. The live store writes both versions next to each verdict, and a replay
 * fixture names both (the mask file in its manifest, the policy in `configVersions`), so a
 * replay of the same members reproduces the same verdict.
 */

import {
  staticSourcesWithin,
  type LocalPlaneMetric,
  type StaticSourceKind,
  type StaticSourceMask,
} from '@fire-watch/contracts';

import type { PlanarMetric } from '../clustering/clustering-params.js';
import { distanceKm } from '../clustering/geometry.js';
import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';
import type { ScoringDetection } from '../scoring/features.js';

/** What a hit on a kind does: decide the event, or only caveat it. */
export const STATIC_SOURCE_EFFECTS = ['override', 'annotate'] as const;
export type StaticSourceEffect = (typeof STATIC_SOURCE_EFFECTS)[number];

/** §6.2 item 2's numbers, all founder-owned. */
export interface StaticSourceQuarantinePolicy {
  readonly enabled: boolean;
  /** "≥ 3 daytime-only detections". */
  readonly minDayDetections: number;
  /** "across ≥ 2 distinct days" — UTC calendar dates of the day detections. */
  readonly minDistinctDays: number;
  /** "at the same ~pixel coordinates": the largest member-to-member distance, metres. */
  readonly siteDiameterM: number;
}

export interface StaticSourcePolicy {
  /** Per kind: does a hit override the event, or only annotate it? The founder switch. */
  readonly kindEffects: Readonly<Record<StaticSourceKind, StaticSourceEffect>>;
  /** How far outside a polygon still counts as inside it, metres. */
  readonly polygonHitBufferM: number;
  /** How close to a point source counts as on it, metres. */
  readonly pointHitRadiusM: number;
  readonly quarantine: StaticSourceQuarantinePolicy;
}

export const STATIC_SOURCE_POLICY: VersionedConfig<StaticSourcePolicy> = defineConfig(
  'static_source_policy',
  'static_source_policy_v2',
  {
    kindEffects: {
      solar: 'override',
      thermal_power: 'override',
      industrial: 'override',
      flare: 'override',
    },
    polygonHitBufferM: 0,
    // Point sources: 500 m is a VIIRS pixel's half-diagonal (375 m × √2 / 2 ≈ 265 m) plus
    // the ~200 m geolocation error a single detection carries. A flare's plume is not
    // where its node is, but a pixel centred more than half a kilometre away is not it.
    pointHitRadiusM: 500,
    quarantine: {
      enabled: true,
      minDayDetections: 3,
      minDistinctDays: 2,
      // Two VIIRS pixels (2 × 375 m): repeat passes see the same ground point in
      // neighbouring pixels (the scan grid shifts pass to pass, plus ~200 m geolocation
      // error each), so "the same pixel" needs a pixel of slack either way, and a wider
      // site is a spreading fire, not a chimney.
      siteDiameterM: 750,
    },
  },
);

/**
 * An event's static-source verdict, strongest first — the order is the precedence:
 *
 *   - `static_source`: every member carries an `override` tag (§3.6). Score 0, invalidated,
 *     sticky.
 *   - `suspected_static_source`: the §6.2 day-only repeat rule holds. Invalidated (no
 *     alert, not on the map), score kept, released by the next rescore that breaks the rule.
 *   - `annotated`: some member is on a source, but the event is neither of the above. No
 *     score effect; the web caveat is what it is for.
 *   - `clear`: none of the above.
 */
export const STATIC_SOURCE_VERDICTS = [
  'static_source',
  'suspected_static_source',
  'annotated',
  'clear',
] as const;
export type StaticSourceVerdict = (typeof STATIC_SOURCE_VERDICTS)[number];

/**
 * The two `fire_events.invalidated_reason` values this module owns (GLOSSARY: the
 * invalidation reason is `static_source`). Only `static_source` is sticky in the store.
 */
export const STATIC_SOURCE_INVALIDATION_REASONS = [
  'static_source',
  'suspected_static_source',
] as const;
export type StaticSourceInvalidationReason = (typeof STATIC_SOURCE_INVALIDATION_REASONS)[number];

/** The invalidation a verdict implies, if any. */
export function invalidationOf(
  verdict: StaticSourceVerdict,
): StaticSourceInvalidationReason | null {
  return verdict === 'static_source' || verdict === 'suspected_static_source' ? verdict : null;
}

/** The per-detection tag: the source a detection sits on, and what that kind does. */
export interface StaticSourceTag {
  readonly kind: StaticSourceKind;
  readonly effect: StaticSourceEffect;
  /** Integer metres to the source (0 inside a polygon). */
  readonly distanceM: number;
}

/**
 * Decides verdicts for one mask and one policy. The two versions travel with it so the
 * caller can write them next to every verdict it stores (D7): a verdict without the mask
 * version it was taken against could not be replayed.
 */
export interface StaticSourceEvaluator {
  /** `null` when no mask is loaded (the quarantine can still fire). */
  readonly maskVersion: string | null;
  /** `null` only for {@link NO_STATIC_SOURCE_EVALUATOR}: nothing was evaluated. */
  readonly policyVersion: string | null;
  evaluate(rows: readonly ScoringDetection[]): StaticSourceVerdict;
}

/**
 * Nothing evaluated: every event is `clear`, and both versions are `null` so a store can
 * tell "not evaluated" from "evaluated and clear". The scorer's contract is `false`, not
 * "unknown", so this is what a caller with no policy wired writes.
 */
export const NO_STATIC_SOURCE_EVALUATOR: StaticSourceEvaluator = Object.freeze({
  maskVersion: null,
  policyVersion: null,
  evaluate: () => 'clear' as const,
});

/**
 * The tag of one detection, or `null` when it is on no source. An `override` hit wins over
 * a nearer `annotate` one (the tag says what the detection *does*), then the nearest.
 */
export function tagDetection(
  mask: StaticSourceMask,
  policy: StaticSourcePolicy,
  metric: LocalPlaneMetric,
  row: Pick<ScoringDetection, 'latCanonical' | 'lonCanonical'>,
): StaticSourceTag | null {
  if (mask.sources.length === 0) return null;
  const point = { lat: Number(row.latCanonical), lon: Number(row.lonCanonical) };
  const radius = Math.max(policy.polygonHitBufferM, policy.pointHitRadiusM);
  let best: StaticSourceTag | null = null;
  // Sorted nearest first, so the first hit of each effect is that effect's nearest.
  for (const hit of staticSourcesWithin(mask, point, radius, metric)) {
    const within =
      hit.source.vertices.length === 1
        ? hit.distanceM <= policy.pointHitRadiusM
        : hit.distanceM <= policy.polygonHitBufferM;
    if (!within) continue;
    const effect = policy.kindEffects[hit.source.kind];
    if (effect === 'override') {
      return { kind: hit.source.kind, effect, distanceM: hit.distanceM };
    }
    best ??= { kind: hit.source.kind, effect, distanceM: hit.distanceM };
  }
  return best;
}

/** Is one detection on a source of an override kind? */
export function detectionOnStaticSource(
  mask: StaticSourceMask,
  policy: StaticSourcePolicy,
  metric: LocalPlaneMetric,
  row: Pick<ScoringDetection, 'latCanonical' | 'lonCanonical'>,
): boolean {
  return tagDetection(mask, policy, metric, row)?.effect === 'override';
}

/**
 * §6.2 item 2 over one event's members. A `null` day/night flag (a source that does not
 * say) counts neither as a day detection nor as a night one: it can neither build a
 * quarantine nor break it, which is the reading that keeps the rule a statement about the
 * detections that *did* say.
 */
export function dayOnlyRepeat(
  quarantine: StaticSourceQuarantinePolicy,
  metric: PlanarMetric,
  rows: readonly ScoringDetection[],
): boolean {
  if (!quarantine.enabled) return false;
  if (rows.some((row) => row.dayNight === 'N')) return false;
  const day = rows.filter((row) => row.dayNight === 'D');
  if (day.length < quarantine.minDayDetections) return false;
  const dates = new Set(day.map((row) => row.acqTsIso.slice(0, 10)));
  if (dates.size < quarantine.minDistinctDays) return false;
  // Every member, not just the day ones: an undated detection far away is still spread.
  const points = rows.map((row) => ({
    lat: Number(row.latCanonical),
    lon: Number(row.lonCanonical),
  }));
  const boundKm = quarantine.siteDiameterM / 1000;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < points.length; j += 1) {
      const b = points[j];
      if (b !== undefined && distanceKm(a, b, metric) > boundKm) return false;
    }
  }
  return true;
}

/** The verdict of one event's members; see {@link STATIC_SOURCE_VERDICTS}. */
export function staticSourceVerdict(
  mask: StaticSourceMask | null,
  policy: StaticSourcePolicy,
  metric: PlanarMetric,
  rows: readonly ScoringDetection[],
): StaticSourceVerdict {
  if (rows.length === 0) return 'clear';
  const tags =
    mask === null ? rows.map(() => null) : rows.map((r) => tagDetection(mask, policy, metric, r));
  if (tags.every((tag) => tag?.effect === 'override')) return 'static_source';
  if (dayOnlyRepeat(policy.quarantine, metric, rows)) return 'suspected_static_source';
  return tags.some((tag) => tag !== null) ? 'annotated' : 'clear';
}

/** The evaluator for one loaded mask (or none) under one versioned policy. */
export function staticSourceEvaluator(
  mask: StaticSourceMask | null,
  policy: VersionedConfig<StaticSourcePolicy>,
  metric: PlanarMetric,
): StaticSourceEvaluator {
  return Object.freeze({
    maskVersion: mask?.version ?? null,
    policyVersion: policy.version,
    evaluate: (rows: readonly ScoringDetection[]) =>
      staticSourceVerdict(mask, policy.values, metric, rows),
  });
}
