/**
 * The golden-replay engine that runs the *real* alert gate (D9; gates CI-3, CI-6).
 *
 * `identity-engine.ts` answers "what happened". This answers "who would have been told,
 * and who deliberately would not" — the half of the product a user actually judges, and
 * the half whose bugs are measured in trust rather than in pixels. It is a wrapper, not a
 * fork: every detection still goes through `createIdentityEngine`, and the only thing
 * added is a pass over that engine's own output that calls `decideAlert` once per
 * (zone, event) per poll. There is no second copy of any gating rule here.
 *
 * Four things about the wiring are worth stating, because each is a place where a
 * plausible shortcut would produce a green fixture asserting the wrong thing:
 *
 *   - **Scores are stated by the fixture, never computed.** ADR-002 D6's scorer does not
 *     exist, and `AlertableEvent.score` is required. So a score is an *input* the scenario
 *     declares in `observations.json`, exactly like cloud cover, and an event no score
 *     names is skipped rather than given a default — an event that alerts because the
 *     harness invented 0.8 for it asserts the harness, not the gate. `ReplayEvent.bucket`
 *     stays `null` throughout for the same reason: a stated score may drive the gate and
 *     may never be reported back as an outcome.
 *   - **Every decision is emitted, not only the sending ones.** A `seed` that writes no
 *     message is precisely what S13 exists to pin, and a report that listed only sends
 *     could not tell "seeded, correctly silent" apart from "the gate never ran".
 *   - **The parent-chain fold happens before the gate, not inside it.** `decideAlert`
 *     requires an already-folded state row (A1.6), so a merge or a reignition link moves
 *     the parents' rows onto the survivor here, in the same pass that sees the merge —
 *     which is the replay's stand-in for doing it in the merge's own transaction.
 *   - **`lastNotified` is always {@link NOTHING_NOTIFIED}.** It comes from the outbox row
 *     the user received, and there is no outbox in a replay. The consequence is exact and
 *     worth knowing: ladder rungs 1 (score upgrade) and 2 (area doubling) can never hold
 *     in a fixture, and only rung 3 — lifecycle worsening and reignition, which read the
 *     event rather than the message — is reachable. That is a real limit of the harness,
 *     not a rule the gate is missing.
 *
 * The digest is the fifth thing, and it is a second pass rather than a fifth rule.
 * `decideAlert` answers one (zone, event) and, when it must not interrupt, returns `defer`
 * or `seed` — a debt, not a message. Once every event in the poll has been decided,
 * {@link produceDigest} runs once per account and asks whether a 09:00 window has opened
 * since the last one that account was given; if it has, the debts and the still-burning
 * events fold into one window's worth of rows, all sharing its subkey. Two consequences
 * are visible in every alert fixture: a poll that crosses 09:00 local emits digest rows
 * for fires that were correctly silent until then (which is A1.8's second half, and what
 * S13 now asserts), and a digest window is located through the tz database rather than by
 * adding a day of milliseconds (which is what S14 asserts, twice, across both transitions).
 */

import {
  SOURCE_REGISTRY,
  assertLifecycleState,
  assertSourceId,
  isRelationKind,
  type LifecycleState,
  type RelationKind,
} from '@fire-watch/contracts';

import { decideForAccount, type AccountZoneInput } from '../alerts/account-decision.js';
import { NOTHING_NOTIFIED, type AlertZone, type AlertableEvent } from '../alerts/alert-decision.js';
import { produceDigest, type DigestCandidate, type DigestCandidateKind } from '../alerts/digest.js';
import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import type { ClusteringConfig } from '../clustering/types.js';
import { ALERT_GATING, type AlertGatingParams } from '../config/alert-gating.js';
import { DIGEST_PARAMS, type DigestParams } from '../config/digest-params.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { epochMsFromIso, isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import { foldAlertStates, isNotified, type AlertStateRow } from '../registry/alert-state.js';
import type { FixtureScore, FixtureZone } from './fixture-format.js';
import { createIdentityEngine, requirePin } from './identity-engine.js';
import type { ReplayContext, ReplayDetection, ReplayEngine, ReplayEvent } from './runner.js';

export interface AlertEngineOptions {
  /** The clustering parameter set to replay under — handed straight to the inner engine. */
  readonly config?: ClusteringConfig;
  /** The gating parameter set. An argument so a v2 fixture can pin v2. */
  readonly gating?: VersionedConfig<AlertGatingParams>;
  /** The digest window. Separate from `gating` for the reason `digest-params.ts` gives. */
  readonly digest?: VersionedConfig<DigestParams>;
}

/** Builds the factory the CLI hands to `runReplay`. Curried, like `identityEngine`. */
export function alertEngine(
  options: AlertEngineOptions = {},
): (context: ReplayContext) => ReplayEngine {
  const config = options.config ?? CLUSTERING_PARAMS;
  const gating = options.gating ?? ALERT_GATING;
  const digest = options.digest ?? DIGEST_PARAMS;
  return (context) => createAlertEngine(context, config, gating, digest);
}

export function createAlertEngine(
  context: ReplayContext,
  config: ClusteringConfig = CLUSTERING_PARAMS,
  gating: VersionedConfig<AlertGatingParams> = ALERT_GATING,
  digest: VersionedConfig<DigestParams> = DIGEST_PARAMS,
): ReplayEngine {
  // The inner engine checks its own three pins; these are the fourth and fifth, and they
  // are the reason the alert engine is a separate id rather than a flag on `identity`:
  // nine identity fixtures that never call the gate should not have to name a version of
  // it. Both are named, not one: a fixture that moved the digest hour without saying so
  // would silently re-key every digest it asserts.
  requirePin(context.configVersions, gating.name, gating.version);
  requirePin(context.configVersions, digest.name, digest.version);

  const zones = sortedZones(context.observations.zones);
  const scores = sortedScores(context.observations.scores);
  assertGateHasInputs(zones, scores);
  const accounts = groupByAccount(zones);

  const inner = createIdentityEngine(context, config);

  /** Every detection seen so far, by uid — the evidence fields an event is judged on. */
  const detections = new Map<string, ReplayDetection>();
  /** `alert_states`, keyed as the table is. */
  const states = new Map<string, AlertStateRow>();
  /** D3's cross-event suppression window, per zone. */
  const zoneLastNotified = new Map<string, EpochMs>();
  /** Zones whose A1.8 seeding evaluation has already run. */
  const seeded = new Set<string>();
  /**
   * The last digest window each account was given, as its A1.11 subkey. Advanced only when
   * {@link produceDigest} says so — a window held by quiet hours must come back.
   */
  const digestWatermark = new Map<string, string>();
  /**
   * Deferrals and seeds still owed to a digest, by (zone, event). This is the replay's
   * stand-in for reading them back out of the outbox: a decision that wrote no message is
   * remembered as a debt until a window carries it.
   */
  const debts = new Map<string, DigestDebt>();
  /**
   * Each event's status as of the *previous* poll. Rung 3 asks which state is being left,
   * so it has to be captured before the tick that leaves it.
   */
  let statusBefore = new Map<string, LifecycleState | null>();

  return {
    ingest(batch: readonly ReplayDetection[]): void {
      for (const detection of batch) {
        detections.set(detection.detectionUid, detection);
      }
      inner.ingest(batch);

      const at = context.clock.now();
      const snapshot = [...inner.events()].sort((a, b) => compareAscii(a.publicId, b.publicId));

      const superseded = migrateParentStates(snapshot, states);

      for (const event of snapshot) {
        // A superseded event is a pointer, not a fire: its state has just been folded onto
        // the event that carries the story on, and gating it again would let one fire notify
        // a zone twice. Both legs need the skip, and only one of them is a tombstone — a
        // merge parent leaves the snapshot as a pointer, but a reignition parent stays in it
        // as an archived event, so without the second clause it comes back every poll with
        // no state row and is decided as a brand-new fire under its old id.
        if (event.mergedInto !== null || superseded.has(event.publicId)) continue;

        const alertable = toAlertableEvent(event, at, detections, scores, statusBefore);
        if (alertable === null) continue;

        for (const perAccount of accounts.values()) {
          const inputs: AccountZoneInput[] = [];
          for (const zone of perAccount) {
            if (at < zone.createdAtMs) continue;
            inputs.push({
              zone: toAlertZone(zone),
              state: states.get(stateKey(zone.zoneId, event.publicId)) ?? null,
              lastNotified: NOTHING_NOTIFIED,
              zoneLastNotifiedAt: zoneLastNotified.get(zone.zoneId) ?? null,
              zoneCreation: !seeded.has(zone.zoneId),
            });
          }
          if (inputs.length === 0) continue;

          // A1.12 runs per account, because "the nearest of my zones" is a statement about
          // one person's zones and nobody else's.
          for (const entry of decideForAccount(alertable, inputs, at, gating)) {
            const { decision } = entry;
            if (decision.nextState !== null) {
              states.set(stateKey(decision.zoneId, decision.eventPublicId), decision.nextState);
            }
            if (decision.outcome === 'send') {
              zoneLastNotified.set(decision.zoneId, at);
            }
            if (decision.outcome === 'defer' || decision.outcome === 'seed') {
              debts.set(stateKey(decision.zoneId, decision.eventPublicId), {
                kind: decision.outcome === 'defer' ? 'deferred' : 'seeded',
                since: at,
              });
            }
            context.emitAlert({
              zoneId: decision.zoneId,
              publicId: decision.eventPublicId,
              outcome: decision.outcome,
              reason: decision.reason,
              alertType: decision.alertType,
              alertSubkey: decision.alertSubkey,
              atIso: isoFromEpochMs(at),
            });
          }
        }
      }

      // The second pass. Once per account per poll, after every event has been decided —
      // a digest summarises the state the poll leaves behind, so it cannot run inside the
      // loop that is still changing it.
      for (const [accountId, perAccount] of accounts) {
        const live = perAccount.filter((zone) => at >= zone.createdAtMs);
        if (live.length === 0) continue;

        const summary = produceDigest(
          {
            accountId,
            zones: live.map(toAlertZone),
            candidates: digestCandidates(live, snapshot, superseded, states, debts, at),
            lastWindowStartIso: digestWatermark.get(accountId) ?? null,
            watchingSince: earliestCreatedAt(live),
            at,
          },
          digest,
          gating,
        );

        if (summary.advanceWatermark && summary.windowStartIso !== null) {
          digestWatermark.set(accountId, summary.windowStartIso);
        }
        if (summary.outcome !== 'send') continue;

        for (const entry of summary.entries) {
          // Settled for the whole account, not only for the zone that rendered it: A1.12
          // says one fire is one message, so the other zones' debts are paid by it too.
          for (const zone of live) debts.delete(stateKey(zone.zoneId, entry.eventPublicId));
          context.emitAlert({
            zoneId: entry.zoneId,
            publicId: entry.eventPublicId,
            outcome: summary.outcome,
            reason: summary.reason,
            alertType: summary.alertType,
            alertSubkey: summary.alertSubkey,
            atIso: isoFromEpochMs(at),
          });
        }
      }

      // Marked after the whole snapshot, not inside it: A1.8's seeding is one evaluation
      // covering every fire that already existed, so the second event in the same poll is
      // pre-existing too.
      for (const zone of zones) {
        if (at >= zone.createdAtMs) seeded.add(zone.zoneId);
      }

      statusBefore = new Map(
        snapshot.map((event) => [
          event.publicId,
          event.status === null ? null : toLifecycleState(event.status),
        ]),
      );
    },

    events: () => inner.events(),
  };
}

/** A decision that wrote no message and is owed to a digest. */
interface DigestDebt {
  readonly kind: Extract<DigestCandidateKind, 'deferred' | 'seeded'>;
  readonly since: EpochMs;
}

/**
 * Lifecycle states a daily summary reports.
 *
 * `no_longer_detected` is absent, and that absence is the product's rule rather than an
 * oversight: we never tell a reader a fire is out (07 §5.5.3, ADR-002 D4), so a fire we
 * have stopped seeing simply stops being repeated — which is not the same claim, and is
 * the only one the data supports. `archived` and both `officially_*` states are past
 * tense for the same reason.
 */
const DIGESTIBLE_STATES: ReadonlySet<string> = new Set<LifecycleState>([
  'active',
  'signal_weakening',
]);

/**
 * When the account began watching, which is the earliest of its zones' `created_at`. A
 * digest window that opened before that instant is nobody's: see `DigestInput.watchingSince`.
 */
function earliestCreatedAt(zones: readonly FixtureZone[]): EpochMs {
  let earliest: EpochMs | null = null;
  for (const zone of zones) {
    if (earliest === null || zone.createdAtMs < earliest) earliest = zone.createdAtMs;
  }
  if (earliest === null) throw new Error('unreachable: the caller filtered out empty accounts');
  return earliest;
}

/**
 * Every (zone, event) pair the account is owed a line about, as {@link produceDigest}'s
 * precondition requires: still burning, and known to that zone.
 *
 * "Known to that zone" is the state row, and it is what keeps a digest inside the reader's
 * own sensitivity — an event below the zone's floor never got a row, so it never reaches
 * the summary either. A debt names why the pair is owed; anything else still burning that
 * the zone has been told about is the ordinary `active` line.
 */
function digestCandidates(
  zones: readonly FixtureZone[],
  snapshot: readonly ReplayEvent[],
  superseded: ReadonlySet<string>,
  states: ReadonlyMap<string, AlertStateRow>,
  debts: ReadonlyMap<string, DigestDebt>,
  at: EpochMs,
): DigestCandidate[] {
  const candidates: DigestCandidate[] = [];
  for (const event of snapshot) {
    if (event.mergedInto !== null || superseded.has(event.publicId)) continue;
    if (event.status === null || !DIGESTIBLE_STATES.has(event.status)) continue;

    for (const zone of zones) {
      const key = stateKey(zone.zoneId, event.publicId);
      const state = states.get(key);
      if (state === undefined || !isNotified(state.state)) continue;

      const debt = debts.get(key);
      candidates.push({
        zoneId: zone.zoneId,
        eventPublicId: event.publicId,
        distanceKm: zone.distanceKm,
        kind: debt?.kind ?? 'active',
        since: debt?.since ?? knownSince(state, at),
      });
    }
  }
  return candidates;
}

/** When this zone first came to know the event — the seed or the first message. */
function knownSince(state: AlertStateRow, at: EpochMs): EpochMs {
  const iso = state.seededAtIso ?? state.lastNotifiedAtIso;
  return iso === null ? at : epochMsFromIso(iso);
}

/**
 * Moves every parent's alert state onto the survivor, per zone, and removes the parents'
 * rows — a state left behind on a tombstone is a second mouth (ADR-002 I3). Returns the
 * parents it emptied, because an event whose state now lives elsewhere must not be gated
 * on its own account any more.
 *
 * Both legs go through the same fold: a merge parent is a tombstone pointing here, and a
 * reignition parent is the event this one is linked back to. A1.6 chooses the alert type
 * on that chain, so a freshly minted reignition child that arrived at the gate with a raw
 * (empty) row would be announced as a new fire to a zone that has been following it.
 */
function migrateParentStates(
  snapshot: readonly ReplayEvent[],
  states: Map<string, AlertStateRow>,
): ReadonlySet<string> {
  const parentsOf = new Map<string, string[]>();
  const addParent = (child: string, parent: string): void => {
    const held = parentsOf.get(child);
    if (held === undefined) parentsOf.set(child, [parent]);
    else held.push(parent);
  };

  for (const event of snapshot) {
    if (event.mergedInto !== null) addParent(event.mergedInto, event.publicId);
    if (event.relation !== null) addParent(event.publicId, event.relation.publicId);
  }

  for (const [child, parents] of parentsOf) {
    const rows: AlertStateRow[] = [];
    const keys: string[] = [];
    for (const publicId of [child, ...parents]) {
      for (const [key, row] of states) {
        if (row.eventPublicId !== publicId) continue;
        rows.push(row);
        keys.push(key);
      }
    }
    if (rows.length === 0) continue;

    for (const key of keys) states.delete(key);
    for (const folded of foldAlertStates(rows, child, parents)) {
      states.set(stateKey(folded.zoneId, child), folded);
    }
  }

  // Every parent, not only the ones that held a row: an event the chain has moved past is
  // superseded whether or not a zone had been notified about it yet.
  return new Set([...parentsOf.values()].flat());
}

/**
 * The event as the gate is allowed to see it, or `null` when the fixture said nothing that
 * would let the gate run at all.
 *
 * `invalidated` and `quarantined` are `false` rather than declarable: no code sets either
 * yet (the masks are D10, the anomaly breaker is A1.5), and a fixture that could declare
 * them would be asserting a suppression nothing in the repo performs. `burnedAreaHa` is
 * `null` for the same reason — no perimeter is computed, so rung 2 cannot hold.
 */
function toAlertableEvent(
  event: ReplayEvent,
  at: EpochMs,
  detections: ReadonlyMap<string, ReplayDetection>,
  scores: readonly FixtureScore[],
  statusBefore: ReadonlyMap<string, LifecycleState | null>,
): AlertableEvent | null {
  // `null` is an event no tick has reached. A replay that ticks every batch cannot produce
  // one, and gating an event with no lifecycle would be gating a fire we know nothing of.
  if (event.status === null) return null;

  const score = scoreAt(event.detectionUids, at, scores);
  if (score === null) return null;

  const members: ReplayDetection[] = [];
  for (const uid of event.detectionUids) {
    const detection = detections.get(uid);
    if (detection !== undefined) members.push(detection);
  }
  if (members.length === 0) return null;

  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let nightHighConfidenceCount = 0;
  let geoOnly = true;
  for (const member of members) {
    const acquired = epochMsFromIso(member.acqTsIso);
    if (acquired < earliest) earliest = acquired;
    if (acquired > latest) latest = acquired;
    if (member.dayNight === 'N' && member.confidence === 'high') nightHighConfidenceCount += 1;
    if (SOURCE_REGISTRY[assertSourceId(member.source)].productTier !== 'GEO') geoOnly = false;
  }

  const relationKind: RelationKind | null =
    event.relation !== null && isRelationKind(event.relation.kind) ? event.relation.kind : null;

  return {
    publicId: event.publicId,
    score,
    detectionCount: members.length,
    nightHighConfidenceCount,
    geoOnly,
    invalidated: false,
    quarantined: false,
    status: toLifecycleState(event.status),
    statusBefore: statusBefore.get(event.publicId) ?? null,
    relationKind,
    burnedAreaHa: null,
    startedAt: earliest,
    lastDetectionAt: latest,
  };
}

/**
 * The most recent score in effect for this event, or `null`.
 *
 * An entry names its event by a detection the event holds, so an event that absorbed a
 * scored one inherits its score — which is the right answer: the merge said the two are
 * one fire. When several apply, the latest effective one wins, so a fixture raises a score
 * by adding an entry rather than by editing history.
 */
function scoreAt(
  detectionUids: readonly string[],
  at: EpochMs,
  scores: readonly FixtureScore[],
): number | null {
  const members = new Set(detectionUids);
  let answer: number | null = null;
  for (const entry of scores) {
    if (entry.fromMs > at) break;
    if (members.has(entry.detectionUid)) answer = entry.score;
  }
  return answer;
}

/**
 * `assertLifecycleState` narrows in place and returns nothing; the gate wants a value.
 * A fixture reporting a status outside the vocabulary is a harness bug, so this throws.
 */
function toLifecycleState(status: string): LifecycleState {
  assertLifecycleState(status);
  return status;
}

function toAlertZone(zone: FixtureZone): AlertZone {
  return {
    zoneId: zone.zoneId,
    minScore: zone.minScore,
    timezone: zone.timezone,
    quietHoursStart: zone.quietHoursStart,
    quietHoursEnd: zone.quietHoursEnd,
    newFireOverridesQuietHours: zone.newFireOverridesQuietHours,
    distanceKm: zone.distanceKm,
  };
}

function groupByAccount(zones: readonly FixtureZone[]): ReadonlyMap<string, FixtureZone[]> {
  const byAccount = new Map<string, FixtureZone[]>();
  for (const zone of zones) {
    const held = byAccount.get(zone.accountId);
    if (held === undefined) byAccount.set(zone.accountId, [zone]);
    else held.push(zone);
  }
  return byAccount;
}

/**
 * A fixture that runs the gate with nothing to run it on is the quiet failure this suite
 * cannot absorb: no zone means no decision, no score means no alertable event, and either
 * way `alerts: []` is recorded as the scenario's answer instead of as its absence.
 */
function assertGateHasInputs(zones: readonly FixtureZone[], scores: readonly FixtureScore[]): void {
  if (zones.length === 0) {
    throw new Error(
      'the alert engine was given no zones — a replay with nothing watching decides ' +
        'nothing, and would record that as "no alerts" (ADR-004 A1.7)',
    );
  }
  if (scores.length === 0) {
    throw new Error(
      'the alert engine was given no scores — nothing in the repo computes one (ADR-002 ' +
        'D6), so an unscored fixture leaves every event below every gate by default',
    );
  }
}

/** Zone order fixes the tie-break input and the emission order; both must not drift. */
function sortedZones(zones: readonly FixtureZone[]): readonly FixtureZone[] {
  return [...zones].sort((a, b) => compareAscii(a.zoneId, b.zoneId));
}

/** Ascending by effective instant, so `scoreAt` can stop at the first future entry. */
function sortedScores(scores: readonly FixtureScore[]): readonly FixtureScore[] {
  return [...scores].sort(
    (a, b) => a.fromMs - b.fromMs || compareAscii(a.detectionUid, b.detectionUid),
  );
}

function stateKey(zoneId: string, eventPublicId: string): string {
  return `${zoneId} ${eventPublicId}`;
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
