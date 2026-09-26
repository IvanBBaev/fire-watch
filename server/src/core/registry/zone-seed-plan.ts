/**
 * Zone-creation seeding, as a value (ADR-004 A1.8, amending D3).
 *
 * The bug this exists to prevent is the first thing a new user would have experienced. The
 * state machine starts at `none`, so the ordinary onboarding path — someone hears there is
 * a fire near their village, installs the app, draws a zone around the village — met a
 * week-old event with no state row, decided `new_fire`, and pushed "нов пожар" about a fire
 * that had been burning since Tuesday. Alarming, and false: nothing about that fire is new.
 *
 * A1.8's answer is to write the state without the message. For every currently alertable
 * event intersecting the new zone, insert `(zone_id, event_id)` at **`notified_new`** with
 * `seeded_at` set, **inside the same transaction as the zone write**, and send nothing at
 * all. This module computes exactly that, and it is a plan rather than a set of writes for
 * the same reason `merge-plan.ts` is one: the rule is atomicity, and the cheapest way to
 * keep a rule like that is to make its violation unrepresentable. There is no
 * `seedZone(db, ...)` a caller could invoke halfway.
 *
 * Four of A1.8's clauses are structural here rather than tested into place:
 *
 *   - **Zero sends.** {@link ZoneSeedPlan} has no outbox field, and the decision list it
 *     does carry ({@link SeedDecisionRecord}, for the H7 decision log) is typed to
 *     `seed | suppress` with no subkey and no priority — nothing a gateway could build an
 *     idempotency key from. The only thing that could send is a `send` outcome from
 *     {@link decideAlert}, and this module refuses to carry one — see the throw below,
 *     which fires on a decision A1.8 says cannot happen rather than dropping it quietly.
 *   - **Shrinking a zone does not unseed.** The plan has no `deletes`. A zone edit that
 *     reduces coverage produces no plan at all; one that enlarges it produces a plan for the
 *     newly covered events only, because the events already covered already have rows.
 *   - **Enlargement does not re-seed.** An event this zone already holds a row for comes
 *     back as `skipped` with reason `pre_existing_event` and **no upsert**, so its original
 *     `seeded_at` — or its `last_notified_at`, if it was genuinely alerted — survives
 *     untouched. Re-stamping `seeded_at` on every edit would silently restart the digest
 *     debt of every fire in the zone.
 *   - **A zone deleted and re-created re-seeds from scratch.** Not enforced here: the new
 *     zone is a new `watch_zones.id`, so no row exists to be found, and the old zone's rows
 *     are already gone via `alert_states.watch_zone_id`'s `ON DELETE CASCADE`. Named
 *     because the clause reads like a requirement on this module and is not one.
 *
 * The fifth clause — "seeded events are eligible for the 09:00 digest from the next
 * window" — is the reason `seeded_at` is written at all. `produceDigest` collects them as
 * `DigestCandidate`s of kind `seeded`, keyed on that instant, so the digest's `since`
 * comparison is against the seed and not against the fire's own start. Which is also why
 * the plan carries the pairs it seeded and their distances: the caller needs both to build
 * those candidates, and re-deriving "which events did we just seed" from the table
 * afterwards would be a second answer to a question this function already answered.
 *
 * **A known limit, written down rather than worked around.** A1.8 says a seeded event that
 * later crosses an escalation step alerts as `escalation` (A1.11). Rung 1 of that ladder —
 * a score-bucket upgrade Likely → Confirmed — is measured against `LastNotifiedContent`,
 * which by construction comes from the outbox row the user actually received. A seeded pair
 * has no outbox row, and `alert_states` stores neither a score bucket nor an area, so rung 1
 * can never hold for a fire that was seeded and never alerted. Rung 2 falls back to the
 * area-doubling floor and rung 3 is unaffected, so a seeded fire can still escalate — but it
 * cannot escalate on the score bucket alone. Closing that would mean a new column and a new
 * normative rule about what a seed "notified", which is not this task's to invent.
 */

import {
  decideAlert,
  NOTHING_NOTIFIED,
  type AlertZone,
  type AlertableEvent,
  type DecisionReason,
} from '../alerts/alert-decision.js';
import type { AlertDecision } from '../alerts/alert-decision.js';
import type { AlertGatingParams } from '../config/alert-gating.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type { AlertStateRow } from './alert-state.js';

/**
 * The zone being created or enlarged, minus the one field that is not a property of the
 * zone at all.
 *
 * `AlertZone.distanceKm` is per `(zone, event)` — zone centre to *that event's* geometry —
 * so a zone evaluated against a dozen events has a dozen of them. Taking it off the zone
 * here and putting it on each candidate is not tidiness: a single `distanceKm` on the zone
 * would be one event's distance silently reused for the other eleven, and it is the number
 * the digest orders its lines by.
 */
export type SeedingZone = Omit<AlertZone, 'distanceKm'>;

/** One event intersecting the zone, with the distance that pair actually has. */
export interface ZoneSeedCandidate {
  readonly event: AlertableEvent;
  /** Zone centre to event geometry, km. A1.12's ordering key, and the digest's. */
  readonly distanceKm: number;
}

/**
 * One seeded pair, in the shape both consumers need: A1.8's onboarding surface ("вече
 * активни пожари във вашата зона", with permalinks built from the public id) and the digest
 * candidate that makes it reportable tomorrow morning.
 *
 * One of these exists for exactly the pairs in {@link ZoneSeedPlan.upserts}, in the same
 * order. They are separate lists because they are written to different places — one to
 * `alert_states`, one to a screen — and a row type carrying a distance the table has no
 * column for would invite someone to add the column.
 */
export interface SeededEvent {
  readonly zoneId: string;
  readonly eventPublicId: string;
  readonly distanceKm: number;
}

/**
 * An event that intersected the zone and was **not** seeded, with the gate that answered.
 *
 * Carried rather than dropped because "why is this fire not in my zone's list?" is the same
 * product question as "why no alert?" (D4), and the reasons are the ones `decideAlert`
 * already names — `geo_only`, `below_zone_threshold`, `insufficient_persistence`,
 * `invalidated`, `quarantined_batch`, `cooldown`, and `pre_existing_event` for a pair this
 * zone already holds.
 */
export interface SkippedEvent {
  readonly eventPublicId: string;
  readonly reason: DecisionReason;
}

/**
 * One seed-pass decision, as the decision log records it (TASKS H7, `pass='zone_creation'`).
 *
 * Every candidate yields exactly one — seeded or skipped — in the plan's output order. The
 * outcome is narrowed to the two A1.8 allows, and the record carries no `alertSubkey`,
 * `priority` or `nextState`: it is evidence of what the gate answered, not an instruction.
 */
export type SeedDecisionRecord = Pick<
  AlertDecision,
  | 'zoneId'
  | 'eventPublicId'
  | 'reason'
  | 'alertType'
  | 'ladderStep'
  | 'inQuietHours'
  | 'ruleVersion'
> & { readonly outcome: 'seed' | 'suppress' };

export interface ZoneSeedPlan {
  readonly zoneId: string;
  /** The transaction's instant. Every seeded row carries this exact value. */
  readonly seededAtIso: string;
  /** The `alert_states` rows to write. Never empty of `seeded_at`; never a `send`. */
  readonly upserts: readonly AlertStateRow[];
  readonly onboarding: readonly SeededEvent[];
  readonly skipped: readonly SkippedEvent[];
  /** One per candidate, ascending by public id: the rows the H7 decision log appends. */
  readonly decisions: readonly SeedDecisionRecord[];
}

export interface ZoneSeedPlanInput {
  readonly zone: SeedingZone;
  /**
   * Every event intersecting the zone's new coverage. Each event appears at most once; two
   * candidates for one public id would produce two rows for one primary key, and the store
   * refuses that batch rather than letting the database pick a winner.
   */
  readonly candidates: readonly ZoneSeedCandidate[];
  /**
   * The `alert_states` rows this zone already holds for those events, read **inside the
   * same transaction**. Empty for a genuinely new zone; non-empty for the enlargement case,
   * which is what stops an edit from re-stamping `seeded_at` over an existing seed.
   *
   * Must already be folded across parent chains — merge parents, and any
   * `possible_reignition` predecessor — exactly as `decideAlert` requires, because A1.6
   * chooses on the chain and not on the event id. `foldAlertStates` is that fold. A row for
   * another zone is a caller error, not something to ignore: it means the wrong zone's rows
   * were loaded, and the visible consequence would be a zone silently re-seeded.
   */
  readonly states: readonly AlertStateRow[];
  /** The decision instant. A parameter, never a clock read. */
  readonly at: EpochMs;
}

/**
 * Computes the seeding transaction for one zone.
 *
 * Every event goes through {@link decideAlert} with `zoneCreation: true` rather than through
 * a re-derived "is this alertable" test. That matters more than it looks: the system gate
 * (persistence, GEO-only, invalidation, quarantine) and the zone's own sensitivity floor are
 * what decide *which* events count as "currently alertable events intersecting the zone",
 * and a second copy of that predicate here would be a second answer to the invariant CI-3
 * exists to protect. The seeding rule proper is one boolean on the input.
 *
 * Output order is ascending by public id, not input order, so that two callers assembling
 * the same zone from differently ordered queries produce the same plan.
 */
export function buildZoneSeedPlan(
  input: ZoneSeedPlanInput,
  config?: VersionedConfig<AlertGatingParams>,
): ZoneSeedPlan {
  const { zone, at } = input;
  const seededAtIso = isoFromEpochMs(at);
  const states = indexStates(input.states, zone.zoneId);

  const upserts: AlertStateRow[] = [];
  const onboarding: SeededEvent[] = [];
  const skipped: SkippedEvent[] = [];
  const decisions: SeedDecisionRecord[] = [];

  for (const candidate of sortCandidates(input.candidates)) {
    const event = candidate.event;
    const decision = decideAlert(
      {
        event,
        zone: { ...zone, distanceKm: candidate.distanceKm },
        state: states.get(event.publicId) ?? null,
        // The seed branch returns before either is read: it does not choose an alert type,
        // so no ladder rung is evaluated, and no rate limit is measured. Passing the real
        // values would suggest they were consulted.
        lastNotified: NOTHING_NOTIFIED,
        zoneLastNotifiedAt: null,
        zoneCreation: true,
        at,
      },
      config,
    );

    if (decision.outcome === 'suppress') {
      decisions.push(seedDecisionRecord(decision, 'suppress'));
      skipped.push({ eventPublicId: event.publicId, reason: decision.reason });
      continue;
    }
    if (decision.outcome !== 'seed' || decision.nextState === null) {
      // Unreachable under A1.8, and loud on purpose. A `send` or a `defer` reaching this
      // point would mean the seeding branch had moved below the type choice, and the first
      // symptom in production would be a push about a week-old fire to a zone drawn ten
      // seconds ago — the exact failure A1.8 was written for.
      throw new RangeError(
        `zone creation decided ${decision.outcome} for ${event.publicId}; A1.8 seeds or refuses`,
      );
    }

    decisions.push(seedDecisionRecord(decision, 'seed'));
    upserts.push(decision.nextState);
    onboarding.push({
      zoneId: zone.zoneId,
      eventPublicId: event.publicId,
      distanceKm: candidate.distanceKm,
    });
  }

  return { zoneId: zone.zoneId, seededAtIso, upserts, onboarding, skipped, decisions };
}

function seedDecisionRecord(
  decision: AlertDecision,
  outcome: 'seed' | 'suppress',
): SeedDecisionRecord {
  return {
    zoneId: decision.zoneId,
    eventPublicId: decision.eventPublicId,
    outcome,
    reason: decision.reason,
    alertType: decision.alertType,
    ladderStep: decision.ladderStep,
    inQuietHours: decision.inQuietHours,
    ruleVersion: decision.ruleVersion,
  };
}

function sortCandidates(candidates: readonly ZoneSeedCandidate[]): readonly ZoneSeedCandidate[] {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const publicId = candidate.event.publicId;
    if (seen.has(publicId)) {
      throw new RangeError(`event ${publicId} appears twice among the seeding candidates`);
    }
    seen.add(publicId);
  }
  return [...candidates].sort((a, b) => compareIds(a.event.publicId, b.event.publicId));
}

function indexStates(
  rows: readonly AlertStateRow[],
  zoneId: string,
): ReadonlyMap<string, AlertStateRow> {
  const byEvent = new Map<string, AlertStateRow>();
  for (const row of rows) {
    if (row.zoneId !== zoneId) {
      throw new RangeError(
        `alert state for zone ${row.zoneId} was handed to the seeding of zone ${zoneId}`,
      );
    }
    if (byEvent.has(row.eventPublicId)) {
      throw new RangeError(
        `two alert states for ${zoneId} and ${row.eventPublicId}; fold them before seeding`,
      );
    }
    byEvent.set(row.eventPublicId, row);
  }
  return byEvent;
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
