/**
 * Event lifecycle vocabulary and score buckets (ADR-002 D6, GLOSSARY §3).
 *
 * Shared verbatim by server and web (ADR-005 D3) because the state name is not an
 * internal detail: it is the join key between the database CHECK constraint, the API
 * response, the wording ladder that CI-11 lints, and the map legend. Three copies of
 * this list would drift, and the failure mode of drift here is a user being shown a
 * state the product does not mean.
 *
 * The list is closed and the word **"out" is not in it** — nor is any synonym. A
 * satellite cannot observe that a fire has stopped burning; it can only observe that it
 * no longer detects one. Every string below preserves that distinction, and the two
 * `officially_*` states exist precisely so that the stronger claim is only ever made by
 * an attributed authority, never by us.
 */

/** States the detection pipeline can reach on its own. */
export const MACHINE_LIFECYCLE_STATES = [
  'active',
  'signal_weakening',
  'no_longer_detected',
  'archived',
] as const;

/**
 * States that only a curated, attributed official statement can set. The product never
 * infers containment or extinguishment from satellite data.
 */
export const CURATED_LIFECYCLE_STATES = [
  'officially_contained',
  'officially_extinguished',
] as const;

export const LIFECYCLE_STATES = [...MACHINE_LIFECYCLE_STATES, ...CURATED_LIFECYCLE_STATES] as const;

export type MachineLifecycleState = (typeof MACHINE_LIFECYCLE_STATES)[number];
export type CuratedLifecycleState = (typeof CURATED_LIFECYCLE_STATES)[number];
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function assertLifecycleState(value: unknown): asserts value is LifecycleState {
  if (!isLifecycleState(value)) {
    throw new RangeError(
      `unknown lifecycle state ${JSON.stringify(value)}; expected one of ${LIFECYCLE_STATES.join(', ')}`,
    );
  }
}

export function isCuratedLifecycleState(value: unknown): value is CuratedLifecycleState {
  return (
    typeof value === 'string' && (CURATED_LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

/**
 * How a later event may point back at an earlier one. Both kinds are deliberately
 * hedged: neither asserts that the two are the same fire, because at satellite
 * resolution that is not knowable (ADR-002 D3).
 */
export const RELATION_KINDS = ['possible_reignition', 'continuation'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export function isRelationKind(value: unknown): value is RelationKind {
  return typeof value === 'string' && (RELATION_KINDS as readonly string[]).includes(value);
}

/**
 * Bucket floors from GLOSSARY §1 / ADR-002 D6: Confirmed ≥ 0.75, Likely 0.45–0.75,
 * Unverified < 0.45. These are the *presentation* boundaries and are stable; the alert
 * gating threshold is a separate, versioned parameter and is not defined here.
 */
export const SCORE_BUCKET_FLOOR = {
  confirmed: 0.75,
  likely: 0.45,
} as const;

export const SCORE_BUCKETS = ['unverified', 'likely', 'confirmed'] as const;
export type ScoreBucket = (typeof SCORE_BUCKETS)[number];

/**
 * Boundaries are closed at the bottom: exactly 0.45 is Likely, exactly 0.75 is
 * Confirmed. Stated here rather than left to whoever writes the next `>=` so the map,
 * the API and the alert copy cannot disagree about a borderline event.
 */
export function scoreBucket(score: number): ScoreBucket {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new RangeError(`score must be a probability in [0, 1], got ${String(score)}`);
  }
  if (score >= SCORE_BUCKET_FLOOR.confirmed) return 'confirmed';
  if (score >= SCORE_BUCKET_FLOOR.likely) return 'likely';
  return 'unverified';
}
