/**
 * The alert decision, as a side-effect-free function (TASKS D9; ADR-004 D3/D4 as amended
 * by A1.5–A1.12; 06 §R3).
 *
 * Pulled forward from WP6 by design. No channel exists, no gateway exists, and none will
 * for a year — but the decision *is* the product. What we send, and more importantly what
 * we refuse to send, is the thing a user judges us on, and it is the thing that must be
 * assertable on a golden fixture from a September that already happened. So the rule set
 * lives here, alone, in a function that:
 *
 *   - **sends nothing.** It returns a value. A decision becomes an `alert_outbox` row in
 *     the same transaction as the state change that triggered it, and the gateway is the
 *     only thing that ever talks to a provider (D1).
 *   - **reads no clock and draws no random number.** The decision instant is a parameter,
 *     so a replay of last August decides what last August decided (I5, CI-2). The B = 500
 *     budget cut is likewise ranked, never sampled (A1.12).
 *   - **keeps no state.** Prior notifications arrive as an {@link AlertStateRow} the
 *     caller has already folded across the parent chain, which is what makes A1.6 true
 *     without this function knowing what a merge is.
 *
 * The two invariants that justify the whole file, both CI-3:
 *
 *   1. **Zero alerts from a single low-confidence detection.** The persistence half of
 *      the system gate is not user-adjustable — the sensitivity knob moves the score
 *      threshold and nothing else (A1.7).
 *   2. **GEO-only never alerts.** MTG/FCI is Demonstration maturity; a geostationary
 *      cluster is evidence that something is hot, not evidence that we should wake
 *      someone (ADR-002 D6, ADR-004 D4).
 *
 * And the one that is not an invariant but a promise: **there is no "resolved" or "safe"
 * decision, and there never will be.** Lifecycle downgrades and score downgrades return
 * `suppress`. A false all-clear is the worst thing this system could emit, so the outcome
 * simply does not exist in the type.
 */

import type { LifecycleState, RelationKind, ScoreBucket } from '@fire-watch/contracts';
import { scoreBucket } from '@fire-watch/contracts';

import {
  ALERT_GATING,
  minuteOfDay,
  priorityFor,
  ladderStepOf,
  type AlertGatingParams,
  type AlertType,
  type EscalationRung,
} from '../config/alert-gating.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { epochMsFromIso, isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import {
  alertStateRank,
  isNotified,
  type AlertState,
  type AlertStateRow,
} from '../registry/alert-state.js';

/**
 * `send` writes an outbox row now. `defer` decided the alert but hands it to the next
 * 09:00 digest instead of piercing quiet hours or the suppression window — the state
 * still advances, because the alert *was* decided and must not be decided twice. `seed`
 * advances state with no row at all (A1.8). `suppress` decides nothing.
 */
export const DECISION_OUTCOMES = ['send', 'defer', 'seed', 'suppress'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/**
 * One word for why, on every decision including the ones that send. This is not
 * diagnostics: "Why this alert?" and "Why no alert?" are product surfaces (D4), and a
 * reason invented at rendering time would be a second, unversioned rule set.
 */
export const DECISION_REASONS = [
  /** First news this zone has of this fire. */
  'first_alert',
  /** A ladder rung above the watermark (A1.11). */
  'ladder_step',
  /** Seeded at zone creation for a fire that already existed (A1.8). */
  'pre_existing_event',
  'quiet_hours',
  'suppression_window',
  /** The triggering detection is older than the push TTL (A1.5). */
  'stale_trigger',
  'quarantined_batch',
  'invalidated',
  'geo_only',
  'insufficient_persistence',
  'below_zone_threshold',
  'no_new_ladder_step',
  'digest_floor',
  'cooldown',
  /** Another zone of the same account is nearer and renders this event (A1.12). */
  'nearer_zone',
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

/**
 * The event as the gate sees it. Deliberately a flat projection rather than the clustering
 * `Cluster` or a `fire_events` row: everything here is a fact the decision is allowed to
 * consult, and a type that carried the member detections would invite a rule that looked
 * at one.
 */
export interface AlertableEvent {
  readonly publicId: string;
  /** Bounded logistic P(real fire | evidence), ADR-002 D6. */
  readonly score: number;
  readonly detectionCount: number;
  /** How many of those were night-time and high-confidence — the system gate's other leg. */
  readonly nightHighConfidenceCount: number;
  /** Every detection came from a geostationary source. Never alerts, at any score. */
  readonly geoOnly: boolean;
  /** A hard override fired (static-source mask, water/glint guard). Score is 0 and stays 0. */
  readonly invalidated: boolean;
  /** The batch this evaluation came from tripped the ingest anomaly breaker (A1.5). */
  readonly quarantined: boolean;
  readonly status: LifecycleState;
  /**
   * The state the event held *before* this evaluation's detections, or `null` for an
   * event created by them. Rung 3 is about re-detection, so it needs the state that is
   * being left, not the one being entered.
   */
  readonly statusBefore: LifecycleState | null;
  readonly relationKind: RelationKind | null;
  readonly burnedAreaHa: number | null;
  readonly startedAt: EpochMs;
  readonly lastDetectionAt: EpochMs;
}

/**
 * A watch zone joined to its account's notification preferences. One type rather than
 * two, because every field below is consulted in the same breath and a `zone` that could
 * be evaluated without its account's quiet hours would be a zone we could wake someone
 * through at 3 a.m. by forgetting a join.
 */
export interface AlertZone {
  readonly zoneId: string;
  /** A1.7's per-zone floor: 0.75, 0.45, or the 0.30 expert opt-in. Never lower. */
  readonly minScore: number;
  /** IANA name. Classification goes through the tz database, never a naive local string. */
  readonly timezone: string;
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
  readonly newFireOverridesQuietHours: boolean;
  /**
   * Distance from the (coarsened) zone centre to the event geometry. Used only by the
   * A1.12 tie-break, and required rather than optional because an alert renders a
   * distance band and a zone that cannot state one has no business alerting.
   */
  readonly distanceKm: number;
}

/**
 * What the last message to this zone about this event actually said.
 *
 * Both fields come from that outbox row's `template_params` — the numbers the user saw —
 * and not from an internal high-water mark, because the ladder measures *news*. An event
 * whose area doubled while the zone was in its suppression window has grown once as far
 * as the reader is concerned, not twice.
 */
export interface LastNotifiedContent {
  readonly scoreBucket: ScoreBucket | null;
  readonly burnedAreaHa: number | null;
}

/** The zone has never been told anything about this event. */
export const NOTHING_NOTIFIED: LastNotifiedContent = Object.freeze({
  scoreBucket: null,
  burnedAreaHa: null,
});

export interface AlertDecisionInput {
  readonly event: AlertableEvent;
  readonly zone: AlertZone;
  /**
   * The `(zone, event)` state row, or `null` for a pair with none. **Must already be
   * folded across the parent chain** — merge parents and any `possible_reignition`
   * predecessor — because A1.6 chooses the alert type on that chain and not on the event
   * id. `foldAlertStates` is that fold; calling this with a raw row for a freshly minted
   * reignition child is how a zone gets told "new fire" about a fire it has been
   * following for a week.
   */
  readonly state: AlertStateRow | null;
  readonly lastNotified: LastNotifiedContent;
  /**
   * When this zone was last notified about **any** event, or `null`. D3's suppression
   * window is cross-event; a first `new_fire` is the one thing it does not hold back.
   */
  readonly zoneLastNotifiedAt: EpochMs | null;
  /**
   * True only for the evaluation that runs inside the zone-write transaction (A1.8).
   * This is the whole of the seeding rule: a fire that predates the zone is silenced
   * *there*, once, and everything afterwards is ordinary. Passing `true` on a routine
   * poll would silence a genuine first alert.
   */
  readonly zoneCreation: boolean;
  /** The decision instant. A parameter, never a clock read. */
  readonly at: EpochMs;
}

export interface AlertDecision {
  readonly zoneId: string;
  readonly eventPublicId: string;
  readonly outcome: DecisionOutcome;
  readonly reason: DecisionReason;
  /** `null` unless the outcome is `send` or `defer`. */
  readonly alertType: AlertType | null;
  /**
   * The fourth column of the idempotency key (A1.11): a constant for `new_fire`, the
   * ladder step for `escalation`, the window start for a `digest`.
   */
  readonly alertSubkey: string | null;
  readonly priority: number | null;
  /** The rung this decision notified; 0 when it is not an escalation. */
  readonly ladderStep: number;
  readonly inQuietHours: boolean;
  /** The gating config that decided this, stamped on the outbox row as `rule_version`. */
  readonly ruleVersion: string;
  /** The row to write, or `null` when nothing about the pair changes. */
  readonly nextState: AlertStateRow | null;
}

/**
 * `new_fire`'s subkey is a constant because the key already carries the type: the pair
 * `(new_fire, once)` can exist at most once per zone per event, ever, which is the whole
 * point of it.
 */
export const NEW_FIRE_SUBKEY = 'once';

/** An escalation is keyed by the rung it announced, so a higher rung is a different row. */
export function escalationSubkey(step: number): string {
  if (!Number.isInteger(step) || step < 1) {
    throw new RangeError(`escalation step must be a positive integer, got ${String(step)}`);
  }
  return `step-${String(step)}`;
}

/** A digest is keyed by its window start, so the 09:00 run is idempotent per day. */
export function digestSubkey(windowStartIso: string): string {
  return windowStartIso;
}

/**
 * States a re-detection can climb *out of* — rung 3's "lifecycle worsening" (A1.11), with
 * the two `officially_*` states included because A2.2 stopped them being terminal.
 *
 * `archived` is absent on purpose. An archived event is past T_LINK; a detection near it
 * mints a new event with a `possible_reignition` link (ADR-002 D2), and that link is what
 * fires this rung — routing it through a status transition instead would give the same
 * fire two escalations.
 */
const WEAKENED_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  'signal_weakening',
  'no_longer_detected',
  'officially_contained',
  'officially_extinguished',
]);

/**
 * The highest ladder rung that currently holds, or 0.
 *
 * The maximum, not the count: the watermark is a position on one ordered scale, and an
 * escalation is decided only when the position is strictly greater than the one already
 * notified (A1.11). That bounds an event at three escalations per zone for its whole
 * life, which is the anti-spam property the rule exists for — score oscillation across
 * the Likely/Confirmed boundary re-crosses rung 1 forever and notifies once.
 */
export function escalationStep(
  event: AlertableEvent,
  lastNotified: LastNotifiedContent,
  params: AlertGatingParams = ALERT_GATING.values,
): number {
  let step = 0;
  for (const rung of params.ladder) {
    if (rungHolds(rung, event, lastNotified, params)) {
      step = Math.max(step, ladderStepOf(rung, params));
    }
  }
  return step;
}

function rungHolds(
  rung: EscalationRung,
  event: AlertableEvent,
  lastNotified: LastNotifiedContent,
  params: AlertGatingParams,
): boolean {
  switch (rung) {
    case 'score_upgrade':
      return lastNotified.scoreBucket === 'likely' && scoreBucket(event.score) === 'confirmed';
    case 'area_doubling': {
      if (event.burnedAreaHa === null) return false;
      const baseline = Math.max(lastNotified.burnedAreaHa ?? 0, params.areaDoublingFloorHa);
      return event.burnedAreaHa >= 2 * baseline;
    }
    case 'lifecycle_worsening':
      if (event.relationKind === 'possible_reignition') return true;
      return (
        event.status === 'active' &&
        event.statusBefore !== null &&
        WEAKENED_STATES.has(event.statusBefore)
      );
  }
}

/**
 * Quiet hours from the decision instant through the tz database (A1.7), never from a
 * naive local string.
 *
 * The two awkward instants are settled by construction rather than by a special case: the
 * repeated hour on DST fallback is inside 22:00–07:00 on both passes, and an instant
 * landing in a skipped local hour is classified from the instant it actually is. Fixture
 * S14 pins both.
 */
export function isInQuietHours(at: EpochMs, zone: AlertZone): boolean {
  const start = minuteOfDay(zone.quietHoursStart);
  const end = minuteOfDay(zone.quietHoursEnd);
  if (start === end) return false;
  const now = localMinuteOfDay(at, zone.timezone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localMinuteOfDay(at: EpochMs, timezone: string): number {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    // Throws RangeError on an unknown zone, which is the correct failure: a zone whose
    // timezone we cannot resolve must not be alerted at an hour we cannot classify.
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  let hour: string | null = null;
  let minute: string | null = null;
  for (const part of formatter.formatToParts(new Date(at))) {
    if (part.type === 'hour') hour = part.value;
    if (part.type === 'minute') minute = part.value;
  }
  if (hour === null || minute === null) {
    throw new RangeError(`could not read a local time of day in timezone ${timezone}`);
  }
  return Number(hour) * 60 + Number(minute);
}

/**
 * Decides what, if anything, this zone is told about this event at this instant.
 *
 * The order of the gates is the order of their authority, and it is fail-closed: the
 * system gate first, because nothing a user can configure may open it; then the zone's
 * own floor; then the state machine; then the rate limits; then quiet hours, which delay
 * rather than drop. A `suppress` earlier in the list is a stronger statement than a
 * `defer` later in it, and the reason on the returned decision says which one answered.
 */
export function decideAlert(
  input: AlertDecisionInput,
  config: VersionedConfig<AlertGatingParams> = ALERT_GATING,
): AlertDecision {
  const params = config.values;
  const { event, zone, state, at } = input;

  assertZoneFloor(zone.minScore, params);
  const bucket = scoreBucket(event.score);
  const inQuietHours = isInQuietHours(at, zone);

  /** Decided nothing, changed nothing: a `suppress` never writes state. */
  const nothing = (reason: DecisionReason): AlertDecision => ({
    zoneId: zone.zoneId,
    eventPublicId: event.publicId,
    outcome: 'suppress',
    reason,
    alertType: null,
    alertSubkey: null,
    priority: null,
    ladderStep: 0,
    inQuietHours,
    ruleVersion: config.version,
    nextState: null,
  });

  // ── the system gate: nothing below is user-adjustable ──────────────────────────────
  if (event.quarantined) return nothing('quarantined_batch');
  if (event.invalidated) return nothing('invalidated');
  if (event.geoOnly) return nothing('geo_only');
  if (
    event.detectionCount < params.minDetections &&
    event.nightHighConfidenceCount < params.minNightHighConfidenceDetections
  ) {
    return nothing('insufficient_persistence');
  }

  // ── the zone's own sensitivity ─────────────────────────────────────────────────────
  if (event.score < zone.minScore) return nothing('below_zone_threshold');

  const current: AlertState = state?.state ?? 'none';
  if (current === 'cooldown') return nothing('cooldown');

  // ── A1.8: at zone creation a pre-existing fire is state, not news ──────────────────
  if (input.zoneCreation) {
    if (isNotified(current)) return nothing('pre_existing_event');
    return {
      zoneId: zone.zoneId,
      eventPublicId: event.publicId,
      outcome: 'seed',
      reason: 'pre_existing_event',
      alertType: null,
      alertSubkey: null,
      priority: null,
      ladderStep: 0,
      inQuietHours,
      ruleVersion: config.version,
      nextState: {
        zoneId: zone.zoneId,
        eventPublicId: event.publicId,
        state: 'notified_new',
        escalationWatermark: state?.escalationWatermark ?? 0,
        seededAtIso: isoFromEpochMs(at),
        lastNotifiedAtIso: state?.lastNotifiedAtIso ?? null,
      },
    };
  }

  // ── A1.6: the type is chosen on the parent chain, not on the event id ──────────────
  const alertType: AlertType = isNotified(current) ? 'escalation' : 'new_fire';
  let step = 0;
  if (alertType === 'escalation') {
    step = escalationStep(event, input.lastNotified, params);
    if (step <= (state?.escalationWatermark ?? 0)) return nothing('no_new_ladder_step');
  }

  // ── rate limits, measured from what the user actually received ─────────────────────
  const lastNotifiedAt = state?.lastNotifiedAtIso ?? null;
  const sinceThisEvent = lastNotifiedAt === null ? null : at - epochMsFromIso(lastNotifiedAt);

  const nextState = advance(input, alertType, step);
  const decided = (outcome: DecisionOutcome, reason: DecisionReason): AlertDecision => ({
    zoneId: zone.zoneId,
    eventPublicId: event.publicId,
    outcome,
    reason,
    alertType,
    alertSubkey: alertType === 'escalation' ? escalationSubkey(step) : NEW_FIRE_SUBKEY,
    priority: priorityFor(alertType, params),
    ladderStep: step,
    inQuietHours,
    ruleVersion: config.version,
    nextState: outcome === 'send' ? withNotifiedAt(nextState, at) : nextState,
  });

  const opened: DecisionReason = alertType === 'new_fire' ? 'first_alert' : 'ladder_step';

  // Both limits defer rather than drop, because both are specified as folding into the
  // next digest. The digest floor is the tighter of the two and gets its own reason so
  // that "why no alert?" can say *which* limit answered, but nothing is ever lost to it.
  if (sinceThisEvent !== null && sinceThisEvent < params.suppressionWindowMs) {
    const limit: DecisionReason =
      sinceThisEvent < params.digestFloorMs ? 'digest_floor' : 'suppression_window';
    return decided('defer', limit);
  }
  // The cross-event half of the window, and its one exception: a first `new_fire` is
  // never held back by traffic about some other fire. Whatever else the zone heard
  // about today, this is a fire it has not been told about.
  if (alertType !== 'new_fire' && input.zoneLastNotifiedAt !== null) {
    if (at - input.zoneLastNotifiedAt < params.suppressionWindowMs) {
      return decided('defer', 'suppression_window');
    }
  }

  // A1.5: a released quarantine batch must not arrive as a burst of "new fire" about
  // fires that started hours ago.
  if (alertType === 'new_fire' && at - event.lastDetectionAt > params.pushTtlMs) {
    return decided('defer', 'stale_trigger');
  }

  if (inQuietHours && !piercesQuietHours(alertType, bucket, zone, params)) {
    return decided('defer', 'quiet_hours');
  }

  return decided('send', opened);
}

/**
 * Only `new_fire` may pierce quiet hours, only if the account left the override on, and
 * only at Likely+ (A1.7): an alert issued under the 0.30 early-signals opt-in carries the
 * Unverified copy and has no business waking anyone, because "may still be a real fire"
 * at 3 a.m. is not a message worth the trust it spends.
 */
function piercesQuietHours(
  alertType: AlertType,
  bucket: ScoreBucket,
  zone: AlertZone,
  params: AlertGatingParams,
): boolean {
  if (alertType !== 'new_fire') return false;
  if (!zone.newFireOverridesQuietHours) return false;
  if (zone.minScore < params.quietHoursOverrideFloor) return false;
  return bucket !== 'unverified';
}

function advance(input: AlertDecisionInput, alertType: AlertType, step: number): AlertStateRow {
  const previous = input.state;
  const target: AlertState = alertType === 'escalation' ? 'notified_escalation' : 'notified_new';
  const held: AlertState = previous?.state ?? 'none';
  return {
    zoneId: input.zone.zoneId,
    eventPublicId: input.event.publicId,
    state: alertStateRank(held) >= alertStateRank(target) ? held : target,
    escalationWatermark: Math.max(previous?.escalationWatermark ?? 0, step),
    seededAtIso: previous?.seededAtIso ?? null,
    lastNotifiedAtIso: previous?.lastNotifiedAtIso ?? null,
  };
}

/**
 * `lastNotifiedAt` moves on a `send` and only on a `send`. A deferred alert has been
 * decided, not delivered; moving it would start the next suppression window from a
 * message the user has not read yet, and the digest that carries it would then be the
 * thing suppressed.
 */
function withNotifiedAt(row: AlertStateRow, at: EpochMs): AlertStateRow {
  return { ...row, lastNotifiedAtIso: isoFromEpochMs(at) };
}

function assertZoneFloor(minScore: number, params: AlertGatingParams): void {
  if (!Number.isFinite(minScore) || minScore > 1) {
    throw new RangeError(`zone sensitivity must be a probability, got ${String(minScore)}`);
  }
  if (minScore < params.sensitivityFloors.earlySignals) {
    throw new RangeError(
      `zone sensitivity ${String(minScore)} is below the ${String(
        params.sensitivityFloors.earlySignals,
      )} opt-in floor`,
    );
  }
}

/**
 * A1.12 — when one account has several zones matching the same event, exactly one of them
 * sends, rendered from the nearest zone, ties broken by lowest zone id.
 *
 * The losers are demoted to `suppress`, **keeping their state advance**: all matching
 * `(zone_id, event_id)` states move, so a second zone cannot re-fire later for the same
 * fire. Deferred decisions are left alone — they fold into a digest, and a digest is one
 * message by construction.
 *
 * Ordering of the input is preserved so the caller can zip the result back onto its own
 * list; the winner is chosen on quantised distance so that two zones drawn around the
 * same village reach the zone-id tie-break instead of being separated by rounding.
 */
export function chooseNotifyingZone(
  decisions: readonly ZoneDecision[],
  params: AlertGatingParams = ALERT_GATING.values,
): readonly ZoneDecision[] {
  let winner: ZoneDecision | null = null;
  for (const candidate of decisions) {
    if (candidate.decision.outcome !== 'send') continue;
    if (winner === null || compareZones(candidate, winner, params) < 0) {
      winner = candidate;
    }
  }
  if (winner === null) return decisions;

  const chosen = winner;
  return decisions.map((entry) =>
    entry === chosen || entry.decision.outcome !== 'send'
      ? entry
      : {
          zone: entry.zone,
          decision: {
            ...entry.decision,
            outcome: 'suppress',
            reason: 'nearer_zone',
            alertType: null,
            alertSubkey: null,
            priority: null,
            nextState: entry.decision.nextState,
          },
        },
  );
}

export interface ZoneDecision {
  readonly zone: AlertZone;
  readonly decision: AlertDecision;
}

/** The two fields A1.12's "nearest zone" is decided on, and nothing else. */
export interface ZoneProximity {
  readonly zoneId: string;
  readonly distanceKm: number;
}

/**
 * A1.12's ordering on its own, so that the digest producer can fold several zones onto
 * one event without owning a second definition of "nearest". Two copies of this
 * comparator would be two answers to "which zone renders this fire", and the one that
 * drifted would be discovered as a user hearing about the same fire from two zones.
 *
 * Distance is compared quantised, so two zones drawn around the same village reach the
 * zone-id tie-break instead of being separated by rounding.
 */
export function compareZoneProximity(
  a: ZoneProximity,
  b: ZoneProximity,
  params: AlertGatingParams = ALERT_GATING.values,
): number {
  const distanceA = quantize(a.distanceKm, params.zoneDistanceQuantumKm);
  const distanceB = quantize(b.distanceKm, params.zoneDistanceQuantumKm);
  if (distanceA !== distanceB) return distanceA - distanceB;
  if (a.zoneId === b.zoneId) return 0;
  return a.zoneId < b.zoneId ? -1 : 1;
}

function compareZones(a: ZoneDecision, b: ZoneDecision, params: AlertGatingParams): number {
  return compareZoneProximity(a.zone, b.zone, params);
}

function quantize(km: number, quantum: number): number {
  if (!Number.isFinite(km) || km < 0) {
    throw new RangeError(`zone distance must be finite and non-negative, got ${String(km)}`);
  }
  return Math.round(km / quantum);
}
