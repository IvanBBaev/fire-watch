/**
 * "Why this alert?" and "Why no alert?" as data (TASKS H7; 07 §5.5.6 / P17; ADR-004 D4).
 *
 * Both surfaces answer one question — which gate decided — and `decideAlert` already
 * answers it: every decision carries a `reason`, and the gates run in a fixed order of
 * authority. So this module adds no rule. It turns a decision, and the inputs it was
 * decided on, into a stable code plus the facts that gate consulted, and it does so
 * without a single sentence of copy. That split is the design, for two reasons:
 *
 *   - **Copy is not ours to write.** What a user reads about a fire is a founder decision
 *     and passes the never-send lint (CI-10/CI-11) before it ships; a string built here
 *     would be copy that lint never saw. A code is a key the renderer's catalog maps to
 *     reviewed words, exactly as D7's template ids are.
 *   - **A reason invented at rendering time is a second rule set.** The explanation is a
 *     projection of the decision, never a re-derivation of it: the code comes from the
 *     `(outcome, reason)` pair the decision already holds, and the facts are only ever
 *     the values the named gate compared. If the two could disagree, "why no alert?"
 *     would be answering a question about a function that did not run.
 *
 * The facts are deliberately coarse where the product is. The raw score never leaves the
 * server (ADR-003 D4), so a sensitivity explanation carries the score *bucket* and the
 * zone's named tier, which is the comparison a user can act on; the thresholds that are
 * not user-adjustable (the persistence gate) are carried as numbers because "2 detections
 * were needed, 1 was seen" is the honest answer and nothing about it is sensitive.
 *
 * What the persisted rows can and cannot reproduce is stated in {@link explainPersisted}:
 * a `send` is fully reproducible from its outbox row, a `seed` from its state row minus the
 * rule version, and — since migration 014 — a `defer` or a `suppress` from the decision
 * log, which names the reason and the rule version of every decision the evaluation loop
 * took effect on.
 */

import type { ScoreBucket } from '@fire-watch/contracts';
import { scoreBucket } from '@fire-watch/contracts';

import {
  ALERT_GATING,
  type AlertGatingParams,
  type AlertType,
  type EscalationRung,
} from '../config/alert-gating.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import type { OutboxRowDraft } from '../ports/alert-outbox-store.js';
import { epochMsFromIso, isoFromEpochMs } from '../ports/clock.js';
import type { AlertState, AlertStateRow } from '../registry/alert-state.js';
import {
  NEW_FIRE_SUBKEY,
  escalationStep,
  type AlertDecision,
  type AlertDecisionInput,
  type DecisionOutcome,
  type DecisionReason,
} from './alert-decision.js';

/** Which of the two P17 surfaces an explanation belongs on. */
export const EXPLANATION_KINDS = ['why_this_alert', 'why_no_alert'] as const;
export type ExplanationKind = (typeof EXPLANATION_KINDS)[number];

/**
 * The gate that answered, in `decideAlert`'s order of authority. `opened` is the
 * pseudo-gate of a `send`: every gate let it through.
 */
export const EXPLANATION_GATES = [
  'system_gate',
  'sensitivity',
  'alert_state',
  'zone_creation',
  'escalation_ladder',
  'rate_limit',
  'push_ttl',
  'quiet_hours',
  'zone_choice',
  'opened',
] as const;
export type ExplanationGate = (typeof EXPLANATION_GATES)[number];

/**
 * What happened to the message. A deferred decision is not lost — it folds into the next
 * digest — and a seeded one returns in it (A1.8, S13); saying so is half of what
 * "quiet hours held it (with the digest reference)" means in 07 §5.5.6.
 */
export const EXPLANATION_DELIVERIES = ['immediate', 'digest', 'none'] as const;
export type ExplanationDelivery = (typeof EXPLANATION_DELIVERIES)[number];

/**
 * One code per reachable `(outcome, reason)` branch of `decideAlert`, and the only
 * vocabulary the renderer is given. Stable: a code is a catalog key, so renaming one is
 * a copy change with a lint run behind it, not a refactor.
 */
export const EXPLANATION_CODES = [
  'sent_first_alert',
  'sent_ladder_step',
  'deferred_digest_floor',
  'deferred_suppression_window',
  'deferred_stale_trigger',
  'deferred_quiet_hours',
  'seeded_pre_existing_event',
  'suppressed_quarantined_batch',
  'suppressed_invalidated',
  'suppressed_geo_only',
  'suppressed_insufficient_persistence',
  'suppressed_below_zone_threshold',
  'suppressed_cooldown',
  'suppressed_pre_existing_event',
  'suppressed_no_new_ladder_step',
  'suppressed_nearer_zone',
] as const;
export type ExplanationCode = (typeof EXPLANATION_CODES)[number];

interface BranchSpec {
  readonly outcome: DecisionOutcome;
  readonly reason: DecisionReason;
  readonly code: ExplanationCode;
  readonly gate: ExplanationGate;
}

/**
 * The branch table. Exported so the tests can hold it against `decideAlert` rather than
 * against a second copy of itself: every row must be reachable, and every decision must
 * land on exactly one row.
 */
export const EXPLANATION_BRANCHES: readonly BranchSpec[] = Object.freeze([
  { outcome: 'send', reason: 'first_alert', code: 'sent_first_alert', gate: 'opened' },
  { outcome: 'send', reason: 'ladder_step', code: 'sent_ladder_step', gate: 'opened' },
  { outcome: 'defer', reason: 'digest_floor', code: 'deferred_digest_floor', gate: 'rate_limit' },
  {
    outcome: 'defer',
    reason: 'suppression_window',
    code: 'deferred_suppression_window',
    gate: 'rate_limit',
  },
  { outcome: 'defer', reason: 'stale_trigger', code: 'deferred_stale_trigger', gate: 'push_ttl' },
  { outcome: 'defer', reason: 'quiet_hours', code: 'deferred_quiet_hours', gate: 'quiet_hours' },
  {
    outcome: 'seed',
    reason: 'pre_existing_event',
    code: 'seeded_pre_existing_event',
    gate: 'zone_creation',
  },
  {
    outcome: 'suppress',
    reason: 'quarantined_batch',
    code: 'suppressed_quarantined_batch',
    gate: 'system_gate',
  },
  {
    outcome: 'suppress',
    reason: 'invalidated',
    code: 'suppressed_invalidated',
    gate: 'system_gate',
  },
  { outcome: 'suppress', reason: 'geo_only', code: 'suppressed_geo_only', gate: 'system_gate' },
  {
    outcome: 'suppress',
    reason: 'insufficient_persistence',
    code: 'suppressed_insufficient_persistence',
    gate: 'system_gate',
  },
  {
    outcome: 'suppress',
    reason: 'below_zone_threshold',
    code: 'suppressed_below_zone_threshold',
    gate: 'sensitivity',
  },
  { outcome: 'suppress', reason: 'cooldown', code: 'suppressed_cooldown', gate: 'alert_state' },
  {
    outcome: 'suppress',
    reason: 'pre_existing_event',
    code: 'suppressed_pre_existing_event',
    gate: 'zone_creation',
  },
  {
    outcome: 'suppress',
    reason: 'no_new_ladder_step',
    code: 'suppressed_no_new_ladder_step',
    gate: 'escalation_ladder',
  },
  {
    outcome: 'suppress',
    reason: 'nearer_zone',
    code: 'suppressed_nearer_zone',
    gate: 'zone_choice',
  },
]);

/** A1.7's three named sensitivity positions, as a user chose them. */
export const SENSITIVITY_TIERS = ['confirmed', 'likely', 'early_signals'] as const;
export type SensitivityTier = (typeof SENSITIVITY_TIERS)[number];

/** Why a `new_fire` inside quiet hours did not pierce them, in `piercesQuietHours` order. */
export const QUIET_HOURS_HOLDS = [
  'not_new_fire',
  'override_off',
  'early_signals_zone',
  'unverified_bucket',
] as const;
export type QuietHoursHold = (typeof QUIET_HOURS_HOLDS)[number];

/**
 * The values the answering gate compared — only those, so a renderer cannot be tempted
 * into explaining a gate that did not run. Timestamps are ISO-8601 UTC; the renderer owns
 * the local rendering, as it does everywhere else.
 */
export type ExplanationFacts =
  | { readonly gate: 'system_gate'; readonly check: 'quarantined' | 'invalidated' | 'geo_only' }
  | {
      readonly gate: 'system_gate';
      readonly check: 'persistence';
      readonly detectionCount: number;
      readonly minDetections: number;
      readonly nightHighConfidenceCount: number;
      readonly minNightHighConfidenceDetections: number;
    }
  | {
      readonly gate: 'sensitivity';
      readonly scoreBucket: ScoreBucket;
      /** `null` for a floor that is none of the three named tiers. */
      readonly zoneSensitivity: SensitivityTier | null;
    }
  | { readonly gate: 'alert_state'; readonly state: AlertState }
  | {
      readonly gate: 'zone_creation';
      readonly priorState: AlertState;
      /** Set on a seed: when the zone learned of the fire without being told. */
      readonly seededAtIso: string | null;
    }
  | {
      readonly gate: 'escalation_ladder';
      /** The highest rung that holds now; at or below the watermark, which is why. */
      readonly step: number;
      readonly watermark: number;
    }
  | {
      readonly gate: 'rate_limit';
      /** Whether the window was this event's own or the zone's cross-event one. */
      readonly scope: 'this_event' | 'zone';
      readonly lastNotifiedAtIso: string;
      /** The limit compared against: the digest floor or the suppression window. */
      readonly thresholdMs: number;
      /** When the suppression window closes — the earliest the next push is possible. */
      readonly windowEndsAtIso: string;
    }
  | {
      readonly gate: 'push_ttl';
      readonly lastDetectionAtIso: string;
      readonly pushTtlMs: number;
      readonly expiredAtIso: string;
    }
  | {
      readonly gate: 'quiet_hours';
      readonly timezone: string;
      readonly start: string;
      readonly end: string;
      readonly heldBecause: QuietHoursHold;
    }
  | { readonly gate: 'zone_choice' }
  | {
      readonly gate: 'opened';
      readonly scoreBucket: ScoreBucket;
      readonly detectionCount: number;
      /** The rung announced, or `null` for a `new_fire`. */
      readonly rung: EscalationRung | null;
      /** A `new_fire` sent inside quiet hours because the zone lets it pierce them. */
      readonly piercedQuietHours: boolean;
    };

/**
 * The part of an explanation that names the decision rather than the evidence — what
 * "why this alert?" leads with, and the part {@link explainPersisted} can rebuild.
 */
export interface ExplanationHeadline {
  readonly code: ExplanationCode;
  readonly kind: ExplanationKind;
  readonly gate: ExplanationGate;
  readonly outcome: DecisionOutcome;
  readonly reason: DecisionReason;
  readonly delivery: ExplanationDelivery;
  readonly zoneId: string;
  readonly alertType: AlertType | null;
  readonly ladderStep: number;
  /** The gating config that decided; `null` only where the surviving row does not carry it. */
  readonly ruleVersion: string | null;
  readonly decidedAtIso: string;
}

export interface AlertExplanation {
  readonly eventPublicId: string;
  readonly headline: ExplanationHeadline;
  readonly facts: ExplanationFacts;
}

/** The branch a decision took, or a throw for a pair `decideAlert` never produces. */
export function branchOf(outcome: DecisionOutcome, reason: DecisionReason): BranchSpec {
  const found = EXPLANATION_BRANCHES.find(
    (branch) => branch.outcome === outcome && branch.reason === reason,
  );
  if (found === undefined) {
    throw new RangeError(`no decision branch is ${outcome}/${reason}`);
  }
  return found;
}

/**
 * The explanation of one decision, from the decision and the input it was decided on.
 *
 * Refuses a mismatched pair rather than explaining it: a decision explained against
 * another zone's input, or under a config it was not decided by, would be a confident
 * answer about a different decision. The config must be the one `decideAlert` ran with —
 * the facts quote its thresholds, and `ruleVersion` is how that is checked.
 */
export function explainDecision(
  decision: AlertDecision,
  input: AlertDecisionInput,
  config: VersionedConfig<AlertGatingParams> = ALERT_GATING,
): AlertExplanation {
  if (decision.zoneId !== input.zone.zoneId || decision.eventPublicId !== input.event.publicId) {
    throw new RangeError(
      `decision for ${decision.zoneId}/${decision.eventPublicId} explained against ` +
        `${input.zone.zoneId}/${input.event.publicId}`,
    );
  }
  if (decision.ruleVersion !== config.version) {
    throw new RangeError(
      `decision taken under ${decision.ruleVersion} explained under ${config.version}`,
    );
  }
  const branch = branchOf(decision.outcome, decision.reason);
  return {
    eventPublicId: decision.eventPublicId,
    headline: {
      code: branch.code,
      kind: decision.outcome === 'send' ? 'why_this_alert' : 'why_no_alert',
      gate: branch.gate,
      outcome: decision.outcome,
      reason: decision.reason,
      delivery: deliveryOf(decision.outcome),
      zoneId: decision.zoneId,
      alertType: decision.alertType,
      ladderStep: decision.ladderStep,
      ruleVersion: decision.ruleVersion,
      decidedAtIso: isoFromEpochMs(input.at),
    },
    facts: factsFor(branch, decision, input, config.values),
  };
}

function deliveryOf(outcome: DecisionOutcome): ExplanationDelivery {
  switch (outcome) {
    case 'send':
      return 'immediate';
    case 'defer':
    case 'seed':
      return 'digest';
    case 'suppress':
      return 'none';
  }
}

function factsFor(
  branch: BranchSpec,
  decision: AlertDecision,
  input: AlertDecisionInput,
  params: AlertGatingParams,
): ExplanationFacts {
  const { event, zone, state, at } = input;
  switch (branch.reason) {
    case 'quarantined_batch':
      return { gate: 'system_gate', check: 'quarantined' };
    case 'invalidated':
      return { gate: 'system_gate', check: 'invalidated' };
    case 'geo_only':
      return { gate: 'system_gate', check: 'geo_only' };
    case 'insufficient_persistence':
      return {
        gate: 'system_gate',
        check: 'persistence',
        detectionCount: event.detectionCount,
        minDetections: params.minDetections,
        nightHighConfidenceCount: event.nightHighConfidenceCount,
        minNightHighConfidenceDetections: params.minNightHighConfidenceDetections,
      };
    case 'below_zone_threshold':
      return {
        gate: 'sensitivity',
        scoreBucket: scoreBucket(event.score),
        zoneSensitivity: sensitivityTier(zone.minScore, params),
      };
    case 'cooldown':
      return { gate: 'alert_state', state: state?.state ?? 'none' };
    case 'pre_existing_event':
      return {
        gate: 'zone_creation',
        priorState: state?.state ?? 'none',
        seededAtIso: decision.outcome === 'seed' ? isoFromEpochMs(at) : null,
      };
    case 'no_new_ladder_step':
      return {
        gate: 'escalation_ladder',
        step: escalationStep(event, input.lastNotified, params),
        watermark: state?.escalationWatermark ?? 0,
      };
    case 'digest_floor':
    case 'suppression_window':
      return windowFacts(branch.reason, input, params);
    case 'stale_trigger':
      return {
        gate: 'push_ttl',
        lastDetectionAtIso: isoFromEpochMs(event.lastDetectionAt),
        pushTtlMs: params.pushTtlMs,
        expiredAtIso: isoFromEpochMs(event.lastDetectionAt + params.pushTtlMs),
      };
    case 'quiet_hours':
      return {
        gate: 'quiet_hours',
        timezone: zone.timezone,
        start: zone.quietHoursStart,
        end: zone.quietHoursEnd,
        heldBecause: quietHoursHold(decision.alertType, input, params),
      };
    case 'nearer_zone':
      return { gate: 'zone_choice' };
    case 'first_alert':
    case 'ladder_step':
      return {
        gate: 'opened',
        scoreBucket: scoreBucket(event.score),
        detectionCount: event.detectionCount,
        rung: decision.ladderStep > 0 ? rungAt(decision.ladderStep, params) : null,
        piercedQuietHours: decision.inQuietHours,
      };
  }
}

/**
 * Which window held the decision, and the threshold it was held against. The per-event
 * window is checked first in `decideAlert` and wins when both would hold, so it is
 * checked first here too; a `digest_floor` is always per-event, because the zone-wide
 * half of the window has no floor of its own.
 *
 * `threshold` is the comparison that answered — the digest floor for `digest_floor`, the
 * suppression window otherwise — and `windowEndsAtIso` is when the suppression window
 * closes either way, because that, not the floor, is when the next immediate message
 * becomes possible. Until then the held news is in the digest, which is what
 * `delivery: 'digest'` already says.
 */
function windowFacts(
  reason: 'digest_floor' | 'suppression_window',
  input: AlertDecisionInput,
  params: AlertGatingParams,
): ExplanationFacts {
  const threshold = reason === 'digest_floor' ? params.digestFloorMs : params.suppressionWindowMs;
  const own = input.state?.lastNotifiedAtIso ?? null;
  if (own !== null) {
    const last = epochMsFromIso(own);
    if (input.at - last < params.suppressionWindowMs) {
      return rateLimit('this_event', last, threshold, params);
    }
  }
  if (reason === 'digest_floor' || input.zoneLastNotifiedAt === null) {
    throw new RangeError(`a ${reason} decision with no notification it could be measured from`);
  }
  return rateLimit('zone', input.zoneLastNotifiedAt, threshold, params);
}

function rateLimit(
  scope: 'this_event' | 'zone',
  lastNotifiedAt: number,
  threshold: number,
  params: AlertGatingParams,
): ExplanationFacts {
  return {
    gate: 'rate_limit',
    scope,
    lastNotifiedAtIso: isoFromEpochMs(lastNotifiedAt),
    thresholdMs: threshold,
    windowEndsAtIso: isoFromEpochMs(lastNotifiedAt + params.suppressionWindowMs),
  };
}

/** `piercesQuietHours`, read as "which condition failed first". */
function quietHoursHold(
  alertType: AlertType | null,
  input: AlertDecisionInput,
  params: AlertGatingParams,
): QuietHoursHold {
  if (alertType !== 'new_fire') return 'not_new_fire';
  if (!input.zone.newFireOverridesQuietHours) return 'override_off';
  if (input.zone.minScore < params.quietHoursOverrideFloor) return 'early_signals_zone';
  return 'unverified_bucket';
}

function sensitivityTier(minScore: number, params: AlertGatingParams): SensitivityTier | null {
  const floors = params.sensitivityFloors;
  if (minScore === floors.confirmed) return 'confirmed';
  if (minScore === floors.likely) return 'likely';
  if (minScore === floors.earlySignals) return 'early_signals';
  return null;
}

function rungAt(step: number, params: AlertGatingParams): EscalationRung {
  const rung = params.ladder[step - 1];
  if (rung === undefined) {
    throw new RangeError(`ladder step ${String(step)} is not in ${params.ladder.join(', ')}`);
  }
  return rung;
}

/**
 * One row of the decision log (migration 014), as {@link explainPersisted} reads it.
 * Structural on purpose: `ports/alert-decision-log.ts`'s `DecisionLogEntry` satisfies it,
 * and this module does not import the port that already imports its code vocabulary.
 */
export interface LoggedDecision {
  readonly zoneId: string;
  readonly fireEventId: string;
  readonly triggerRefSeq: string;
  readonly outcome: DecisionOutcome;
  readonly reason: DecisionReason;
  readonly code: ExplanationCode;
  readonly alertType: AlertType | null;
  readonly ladderStep: number;
  readonly ruleVersion: string;
  readonly decidedAtIso: string;
}

/**
 * The headline rebuilt from what the database holds, or `null` when it holds nothing that
 * names a decision.
 *
 *   - **An automatic outbox row** carries the type, the subkey (so the rung), the rule
 *     version and the decision instant — everything a `send` headline says. The row is
 *     authoritative where it exists, because it is the liability artifact (D1): "why this
 *     alert?" is asked about a message the user received, and a later suppression of the
 *     same pair does not change why that message was sent.
 *   - **The decision log** (migration 014) names every decision the evaluation loop took
 *     effect on — `defer` and `suppress` included — with its reason and rule version. With
 *     no outbox row, the latest logged decision is the answer to "why no alert?".
 *   - **A state row with `seededAtIso`** records a seed (A1.8) and when it happened, but
 *     `alert_states` has no rule-version column, so that half comes back `null`. The
 *     seed survives every later transition — `advance` and the merge fold both keep it —
 *     so it is the answer only when no logged decision is later than it. The zone-creation
 *     pass does not write the log yet, which is why the seed is still read from the state.
 *   - **Nothing else.** A pair decided before migration 014, and never since, has no row
 *     that names a `defer` or a `suppress`; that answer is not reconstructed here.
 *
 * The log must be one pair's — every entry for the same zone and event — and each entry's
 * code must be the branch table's code for its outcome and reason; anything else throws,
 * because a headline about a different pair, or under a code the renderer would not have
 * produced, is a confident answer to a different question.
 *
 * A `digest` row is not a `decideAlert` decision (it is `produceDigest`'s), and a
 * `manual` row's explanation is its approval trail (A1.1); both return `null` here rather
 * than a headline borrowed from a branch they did not take.
 */
export function explainPersisted(rows: {
  readonly outbox: OutboxRowDraft | null;
  readonly state: AlertStateRow | null;
  readonly log?: readonly LoggedDecision[];
}): ExplanationHeadline | null {
  const { outbox, state } = rows;
  const logged = latestLogged(rows.log ?? []);
  if (outbox !== null) {
    if (outbox.triggerType === 'manual' || outbox.alertType === 'digest') return null;
    const alertType = outbox.alertType;
    const ladderStep = alertType === 'escalation' ? stepFromSubkey(outbox.alertSubkey) : 0;
    if (alertType === 'new_fire' && outbox.alertSubkey !== NEW_FIRE_SUBKEY) {
      throw new RangeError(`a new_fire row keyed ${JSON.stringify(outbox.alertSubkey)}`);
    }
    if (logged !== null && logged.zoneId !== outbox.watchZoneId) {
      throw new RangeError(
        `decision log for zone ${logged.zoneId} read beside an outbox row for ${outbox.watchZoneId}`,
      );
    }
    const branch = branchOf('send', alertType === 'new_fire' ? 'first_alert' : 'ladder_step');
    return {
      code: branch.code,
      kind: 'why_this_alert',
      gate: branch.gate,
      outcome: branch.outcome,
      reason: branch.reason,
      delivery: 'immediate',
      zoneId: outbox.watchZoneId,
      alertType,
      ladderStep,
      ruleVersion: outbox.ruleVersion,
      decidedAtIso: isoFromEpochMs(outbox.decidedAt),
    };
  }
  if (logged !== null && state !== null && logged.zoneId !== state.zoneId) {
    throw new RangeError(
      `decision log for zone ${logged.zoneId} read beside a state row for ${state.zoneId}`,
    );
  }
  const seededAtIso = state?.seededAtIso ?? null;
  if (
    logged !== null &&
    (seededAtIso === null || epochMsFromIso(logged.decidedAtIso) >= epochMsFromIso(seededAtIso))
  ) {
    return headlineFromLog(logged);
  }
  if (state !== null && seededAtIso !== null) {
    const branch = branchOf('seed', 'pre_existing_event');
    return {
      code: branch.code,
      kind: 'why_no_alert',
      gate: branch.gate,
      outcome: branch.outcome,
      reason: branch.reason,
      delivery: 'digest',
      zoneId: state.zoneId,
      alertType: null,
      ladderStep: 0,
      ruleVersion: null,
      decidedAtIso: seededAtIso,
    };
  }
  return null;
}

/** The latest entry of one pair's log (by decision instant, then trigger seq), or `null`. */
function latestLogged(log: readonly LoggedDecision[]): LoggedDecision | null {
  let latest: LoggedDecision | null = null;
  for (const entry of log) {
    if (
      latest !== null &&
      (entry.zoneId !== latest.zoneId || entry.fireEventId !== latest.fireEventId)
    ) {
      throw new RangeError(
        `decision log mixes ${latest.zoneId}/${latest.fireEventId} and ${entry.zoneId}/${entry.fireEventId}`,
      );
    }
    const branch = branchOf(entry.outcome, entry.reason);
    if (branch.code !== entry.code) {
      throw new RangeError(
        `decision log names ${entry.code} for ${entry.outcome}/${entry.reason}, the branch is ${branch.code}`,
      );
    }
    if (latest === null || laterThan(entry, latest)) latest = entry;
  }
  return latest;
}

function laterThan(a: LoggedDecision, b: LoggedDecision): boolean {
  const at = epochMsFromIso(a.decidedAtIso) - epochMsFromIso(b.decidedAtIso);
  if (at !== 0) return at > 0;
  return BigInt(a.triggerRefSeq) > BigInt(b.triggerRefSeq);
}

function headlineFromLog(entry: LoggedDecision): ExplanationHeadline {
  const branch = branchOf(entry.outcome, entry.reason);
  return {
    code: branch.code,
    kind: entry.outcome === 'send' ? 'why_this_alert' : 'why_no_alert',
    gate: branch.gate,
    outcome: entry.outcome,
    reason: entry.reason,
    delivery: deliveryOf(entry.outcome),
    zoneId: entry.zoneId,
    alertType: entry.alertType,
    ladderStep: entry.ladderStep,
    ruleVersion: entry.ruleVersion,
    decidedAtIso: entry.decidedAtIso,
  };
}

function stepFromSubkey(subkey: string): number {
  const digits = /^step-([1-9]\d*)$/.exec(subkey)?.[1];
  if (digits === undefined) {
    throw new RangeError(`an escalation row keyed ${JSON.stringify(subkey)}`);
  }
  return Number(digits);
}
