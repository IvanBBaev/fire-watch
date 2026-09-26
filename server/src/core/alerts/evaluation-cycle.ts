/**
 * One cycle of the live alert evaluation loop (ADR-004 D1, D3, A1.6, A1.8, A1.10, A1.12;
 * TASKS H3).
 *
 * `fire_events` → the watch zones that contain each changed event → `decideAlert` →
 * `alert_states` and `alert_outbox`, in one transaction per batch. This is the live
 * counterpart of the replay's alert pass (`replay/alert-engine.ts`), and the step both of
 * them run — decide every zone of one account, then keep only the nearest zone's `send`
 * — is one function, `decideForAccount`, so the CI-1 replay proves the code this runs.
 *
 * ## The batch
 *
 * The events read are those whose `seq` moved past the loop's durable cursor, oldest
 * first, one row each: `seq` is bumped by every insert, every aggregate change and every
 * lifecycle transition (ADR-003 A1.4), which is exactly the set of events whose gate
 * inputs may have changed. Everything below runs inside one
 * {@link AlertEvaluationStore.withTransaction}: read the cursor, read the page, match,
 * decide, write the states, enqueue the sends, log the decisions, mark the events
 * evaluated, advance the cursor. A batch that throws rolls back whole and is re-read next cycle from the same
 * cursor; the outbox's A1.11 key makes a re-decided send a no-op.
 *
 * ## What is the same as the replay
 *
 *   - **Skipped before the gate:** merge tombstones and superseded reignition parents
 *     (their state was folded onto the survivor inside the clustering transaction, which
 *     is where `merge-plan.ts` and `reignition-plan.ts` apply it), and an event with no
 *     member detections.
 *   - **`zoneCreation` is `false`.** A1.8's seed runs once, inside the zone-write
 *     transaction; every routine evaluation is ordinary.
 *   - **`lastNotified` is {@link NOTHING_NOTIFIED}.** It should be read back from the
 *     outbox row the user received, and `template_params` has no ratified schema for the
 *     score bucket and burned area yet. The consequence is the replay's: ladder rungs 1
 *     and 2 cannot hold. Stated here and in the H3 report, not papered over.
 *   - **Accounts and zones are decided in id order**, the zone order being A1.12's
 *     tie-break input; a zone's cross-event window (D3) is updated in memory as soon as it
 *     sends, so a second event later in the same batch sees it.
 *
 * ## What is live-only
 *
 *   - **Matching.** The candidates are the live sealed zones filed in the index cells a
 *     zone of the largest allowed radius could occupy (the clear-text grid key, 05
 *     §5.3.2), and the decision is the exact distance from the decrypted stored centre
 *     (`zone-match.ts`). A centre that fails to open is counted and that zone skipped for
 *     this event; nothing about it — and never a coordinate — is written to the report.
 *   - **`statusBefore` is persisted** per event as the status this loop last evaluated,
 *     so rung 3 ("re-detected after weakening") sees the state being left even across a
 *     restart.
 *   - **Routing.** A `send` needs a delivery target and a reviewed template
 *     ({@link AlertRouting}). When an account has a `send` and either is missing, the cycle
 *     writes nothing for that (account, event) — no state row, no outbox row, no decision
 *     log entry — because
 *     advancing the state without the message is a user who will never be told. It is
 *     counted as `undeliverable`; the pair is decided again the next time the event's
 *     `seq` moves.
 *
 * ## What is not here
 *
 *   - **The digest pass.** `produceDigest` needs a per-account digest watermark and the
 *     deferred/seeded debts, and neither is persisted yet. Until it is, a `defer` advances
 *     the pair's state and is never delivered — the reason arming this loop waits on it.
 *   - **Budget ranking (D5).** Rows are written `pending` with `budget_seq` null: the
 *     budget-B cutoff is unarmed, and no number for it is invented here. The deferral
 *     counter is already produced (`deferred` in the report, through
 *     `enqueueCountingDeferrals`), so arming B needs no metrics change: it reports zero
 *     until then.
 */

import { isoFromEpochMs, type Clock, type EpochMs } from '../ports/clock.js';
import type {
  AlertEvaluationStore,
  AlertEvaluationTransaction,
  EvaluatedEventMark,
  EvaluationEventRow,
} from '../ports/alert-evaluation-store.js';
import type { DecisionLogEntry } from '../ports/alert-decision-log.js';
import type { OutboxRowDraft } from '../ports/alert-outbox-store.js';
import type { AlertDeliveryTarget, AlertRouting } from '../ports/alert-routing.js';
import type { AccountAlertSettings, StoredWatchZone } from '../ports/watch-zone-store.js';
import type { ZoneCentreCipher } from '../ports/zone-centre-cipher.js';
import type { AlertGatingParams } from '../config/alert-gating.js';
import { ALERT_GATING } from '../config/alert-gating.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import type { PlanarMetric } from '../clustering/clustering-params.js';
import type { AlertStateKey, AlertStateRow } from '../registry/alert-state.js';
import { ZONE_GRID, type ZoneGridParams } from '../zones/zone-geometry.js';
import { epochMsFromIso } from '../ports/clock.js';
import { decideForAccount, type AccountZoneInput } from './account-decision.js';
import {
  DECISION_OUTCOMES,
  DECISION_REASONS,
  NOTHING_NOTIFIED,
  type AlertZone,
  type DecisionOutcome,
  type DecisionReason,
  type ZoneDecision,
} from './alert-decision.js';
import { decisionLogEntryFor } from './decision-log.js';
import { outboxRowFor } from './outbox.js';
import { enqueueCountingDeferrals, noDeferrals } from './outbox-enqueue.js';
import {
  ALERT_DEFERRAL_REASONS,
  type AlertDeferralReason,
} from '../observability/alert-metrics.js';
import { ZONE_MATCH_METRIC, candidateCellsFor, zoneDistanceWithin } from './zone-match.js';

export interface AlertEvaluationCycleDeps {
  readonly store: AlertEvaluationStore;
  readonly cipher: ZoneCentreCipher;
  readonly routing: AlertRouting;
  readonly clock: Clock;
  /** Events per batch (one transaction each). A positive integer. */
  readonly batchLimit: number;
  /** Batches per cycle; a cycle that uses them all reports `behind`. A positive integer. */
  readonly maxBatchesPerCycle: number;
  readonly gating?: VersionedConfig<AlertGatingParams>;
  readonly grid?: VersionedConfig<ZoneGridParams>;
  readonly metric?: PlanarMetric;
}

export interface AlertEvaluationCycleReport {
  /** The decision instant every batch of this cycle was decided at. */
  readonly atIso: string;
  readonly cursorFrom: string;
  readonly cursorTo: string;
  readonly batches: number;
  /** The last batch came back full: the loop is catching up rather than idle. */
  readonly behind: boolean;
  readonly eventsRead: number;
  readonly skipped: {
    readonly merged: number;
    readonly superseded: number;
    readonly noMembers: number;
  };
  /** Candidate zones that failed to open. The zone is skipped for that event. */
  readonly cipherFailures: number;
  /** Zones whose account has no alert settings (deleted or missing account). */
  readonly accountsWithoutSettings: number;
  /** (zone, event) pairs decided. */
  readonly pairsDecided: number;
  readonly outcomes: Readonly<Record<DecisionOutcome, number>>;
  readonly reasons: Readonly<Partial<Record<DecisionReason, number>>>;
  /** (account, event) groups written nothing because a `send` had no target or copy. */
  readonly undeliverable: number;
  readonly statesWritten: number;
  readonly outboxInserted: number;
  readonly outboxAlreadyDecided: number;
  /** Decision log rows inserted (migration 014); a replayed batch inserts none. */
  readonly decisionsLogged: number;
  /**
   * Outbox rows newly inserted as `awaiting_approval`, by A1.12 reason — the producer of
   * `fw_alert_sends_deferred_total`. All zero while D5's budget B is unarmed, because
   * every row is written `pending`; counted from what the outbox actually inserted, so a
   * re-decided batch adds nothing.
   */
  readonly deferred: Readonly<Record<AlertDeferralReason, number>>;
}

/** Runs batches until one comes back short or the per-cycle limit is reached. */
export async function runAlertEvaluationCycle(
  deps: AlertEvaluationCycleDeps,
): Promise<AlertEvaluationCycleReport> {
  assertPositiveInteger(deps.batchLimit, 'batchLimit');
  assertPositiveInteger(deps.maxBatchesPerCycle, 'maxBatchesPerCycle');
  const at = deps.clock.now();
  const tally = new Tally();

  let cursorFrom: string | null = null;
  let cursorTo = '0';
  let batches = 0;
  let behind = false;
  while (batches < deps.maxBatchesPerCycle) {
    const batch = await deps.store.withTransaction((tx) => evaluateBatch(tx, deps, at, tally));
    batches += 1;
    cursorFrom ??= batch.cursorFrom;
    cursorTo = batch.cursorTo;
    behind = batch.full;
    if (!batch.full) break;
  }

  return {
    atIso: isoFromEpochMs(at),
    cursorFrom: cursorFrom ?? cursorTo,
    cursorTo,
    batches,
    behind,
    ...tally.report(),
  };
}

interface BatchResult {
  readonly cursorFrom: string;
  readonly cursorTo: string;
  readonly full: boolean;
}

/** A candidate zone that contains the event, with its measured distance. */
interface MatchedZone {
  readonly zone: StoredWatchZone;
  readonly distanceKm: number;
}

async function evaluateBatch(
  tx: AlertEvaluationTransaction,
  deps: AlertEvaluationCycleDeps,
  at: EpochMs,
  tally: Tally,
): Promise<BatchResult> {
  const gating = deps.gating ?? ALERT_GATING;
  const grid = deps.grid ?? ZONE_GRID;
  const metric = deps.metric ?? ZONE_MATCH_METRIC;
  const atIso = isoFromEpochMs(at);

  const cursorFrom = await tx.readCursor();
  const rows = await tx.readEventsAfter(cursorFrom, deps.batchLimit);
  const last = rows[rows.length - 1];
  if (last === undefined) return { cursorFrom, cursorTo: cursorFrom, full: false };
  tally.eventsRead += rows.length;

  const gated = rows.filter((row) => gateable(row, tally));

  // One candidate read for the whole batch: the union of every gated event's cells.
  const cellsByEvent = new Map<string, ReadonlySet<string>>();
  const allCells = new Set<string>();
  for (const row of gated) {
    const cells = new Set(candidateCellsFor(row.centroid, grid.values));
    cellsByEvent.set(row.fireEventId, cells);
    for (const cell of cells) allCells.add(cell);
  }
  const candidates = [
    ...(await tx.zones.listLiveInCells(grid.version, sortedAscii(allCells))),
  ].sort((a, b) => compareAscii(a.id, b.id));

  // Match, per event. Decrypted centres live only inside this loop.
  const matchesByEvent = new Map<string, readonly MatchedZone[]>();
  for (const row of gated) {
    const cells = cellsByEvent.get(row.fireEventId) ?? new Set<string>();
    const matched: MatchedZone[] = [];
    for (const zone of candidates) {
      if (zone.gridVersion !== grid.version || !cells.has(zone.gridCell)) continue;
      let distanceKm: number | null;
      try {
        distanceKm = zoneDistanceWithin(
          deps.cipher.open(zone.id, zone.sealed),
          zone.radiusM,
          row.centroid,
          metric,
        );
      } catch {
        // Deliberately no message: a cipher error about a zone is not something the
        // cycle report may carry verbatim.
        tally.cipherFailures += 1;
        continue;
      }
      if (distanceKm !== null) matched.push({ zone, distanceKm });
    }
    matchesByEvent.set(row.fireEventId, matched);
  }

  // Batch reads: account settings, state rows, and each zone's last notification.
  const settings = new Map<string, AccountAlertSettings | null>();
  const stateKeys: AlertStateKey[] = [];
  const zoneIds = new Set<string>();
  for (const row of gated) {
    for (const { zone } of matchesByEvent.get(row.fireEventId) ?? []) {
      if (!settings.has(zone.accountId)) {
        settings.set(zone.accountId, await tx.zones.loadAccountAlertSettings(zone.accountId));
      }
      stateKeys.push({ zoneId: zone.id, eventPublicId: row.event.publicId });
      zoneIds.add(zone.id);
    }
  }
  const states = new Map<string, AlertStateRow>();
  if (stateKeys.length > 0) {
    for (const state of await tx.alertStates.loadStates(stateKeys)) {
      states.set(stateKey(state.zoneId, state.eventPublicId), state);
    }
  }
  const zoneLastNotified = new Map<string, EpochMs>();
  if (zoneIds.size > 0) {
    const lastByZone = await tx.alertStates.lastNotifiedByZone(sortedAscii(zoneIds));
    for (const [zoneId, iso] of lastByZone) zoneLastNotified.set(zoneId, epochMsFromIso(iso));
  }

  const targets = new Map<string, AlertDeliveryTarget | null>();
  const stateWrites: AlertStateRow[] = [];
  const outboxRows: OutboxRowDraft[] = [];
  const logEntries: DecisionLogEntry[] = [];

  for (const row of gated) {
    const byAccount = groupByAccount(matchesByEvent.get(row.fireEventId) ?? []);
    for (const accountId of sortedAscii(byAccount.keys())) {
      const account = settings.get(accountId) ?? null;
      const zones = byAccount.get(accountId) ?? [];
      if (account === null) {
        tally.accountsWithoutSettings += zones.length;
        continue;
      }
      const inputs: AccountZoneInput[] = zones.map(({ zone, distanceKm }) => ({
        zone: toAlertZone(zone, account, distanceKm),
        state: states.get(stateKey(zone.id, row.event.publicId)) ?? null,
        lastNotified: NOTHING_NOTIFIED,
        zoneLastNotifiedAt: zoneLastNotified.get(zone.id) ?? null,
        zoneCreation: false,
      }));
      const decisions = decideForAccount(row.event, inputs, at, gating);

      const drafts = await outboxDraftsFor(decisions, row, accountId, at, deps, targets, gating);
      if (drafts === null) {
        tally.undeliverable += 1;
        continue;
      }

      for (const { decision } of decisions) {
        tally.decided(decision.outcome, decision.reason);
        if (decision.nextState !== null) stateWrites.push(decision.nextState);
        if (decision.outcome === 'send') zoneLastNotified.set(decision.zoneId, at);
        logEntries.push(
          decisionLogEntryFor(decision, {
            fireEventId: row.fireEventId,
            triggerRefSeq: row.seq,
            pass: 'evaluation',
            decidedAt: at,
          }),
        );
      }
      outboxRows.push(...drafts);
    }
  }

  // D1: the state change and its message in the same transaction as each other, and as
  // the cursor that says they were decided.
  if (stateWrites.length > 0) {
    tally.statesWritten += await tx.alertStates.upsert(stateWrites);
  }
  if (outboxRows.length > 0) {
    // Through the counting enqueue, so a row entering `awaiting_approval` (A1.12) is
    // counted the day budget B is armed, without this cycle having to remember to.
    const enqueued = await enqueueCountingDeferrals(tx.outbox, outboxRows);
    tally.outboxInserted += enqueued.inserted;
    tally.outboxAlreadyDecided += enqueued.alreadyDecided;
    for (const reason of ALERT_DEFERRAL_REASONS) {
      tally.deferred[reason] += enqueued.deferred[reason];
    }
  }
  // H7: the reason behind every applied decision, `defer` and `suppress` included, so
  // "why no alert?" is answerable from the rows rather than by re-deciding.
  if (logEntries.length > 0) {
    tally.decisionsLogged += await tx.decisionLog.append(logEntries);
  }
  const marks: EvaluatedEventMark[] = rows.map((row) => ({
    fireEventId: row.fireEventId,
    seq: row.seq,
    status: row.event.status,
  }));
  await tx.recordEvaluated(marks, atIso);
  await tx.advanceCursor(last.seq, atIso);

  return { cursorFrom, cursorTo: last.seq, full: rows.length >= deps.batchLimit };
}

/**
 * The outbox rows for one account's decisions about one event, or `null` when a `send`
 * among them cannot be routed — in which case the caller writes nothing for the group.
 */
async function outboxDraftsFor(
  decisions: readonly ZoneDecision[],
  row: EvaluationEventRow,
  accountId: string,
  at: EpochMs,
  deps: AlertEvaluationCycleDeps,
  targets: Map<string, AlertDeliveryTarget | null>,
  gating: VersionedConfig<AlertGatingParams>,
): Promise<readonly OutboxRowDraft[] | null> {
  const drafts: OutboxRowDraft[] = [];
  for (const { zone, decision } of decisions) {
    if (decision.outcome !== 'send') continue;
    if (!targets.has(accountId)) targets.set(accountId, await deps.routing.targetFor(accountId));
    const target = targets.get(accountId) ?? null;
    const copy = deps.routing.copyFor(decision, row.event, zone);
    if (target === null || copy === null) return null;
    const draft = outboxRowFor(
      decision,
      {
        fireEventId: row.fireEventId,
        triggerRefSeq: row.seq,
        channel: target.channel,
        channelSubscriptionId: target.channelSubscriptionId,
        ...(target.locale === undefined ? {} : { locale: target.locale }),
        templateId: copy.templateId,
        templateParams: copy.templateParams,
        decidedAt: at,
        // D5's budget-B cutoff is unarmed: no rank, no `awaiting_approval`.
        budgetSeq: null,
        status: 'pending',
      },
      gating,
    );
    if (draft !== null) drafts.push(draft);
  }
  return drafts;
}

function gateable(row: EvaluationEventRow, tally: Tally): boolean {
  if (row.merged) {
    tally.merged += 1;
    return false;
  }
  if (row.superseded) {
    tally.superseded += 1;
    return false;
  }
  if (row.memberCount === 0) {
    tally.noMembers += 1;
    return false;
  }
  return true;
}

function toAlertZone(
  zone: StoredWatchZone,
  account: AccountAlertSettings,
  distanceKm: number,
): AlertZone {
  return {
    zoneId: zone.id,
    minScore: zone.minScore,
    timezone: account.timezone,
    quietHoursStart: account.quietHoursStart,
    quietHoursEnd: account.quietHoursEnd,
    newFireOverridesQuietHours: account.newFireOverridesQuietHours,
    distanceKm,
  };
}

function groupByAccount(matches: readonly MatchedZone[]): ReadonlyMap<string, MatchedZone[]> {
  const byAccount = new Map<string, MatchedZone[]>();
  for (const match of matches) {
    const held = byAccount.get(match.zone.accountId);
    if (held === undefined) byAccount.set(match.zone.accountId, [match]);
    else held.push(match);
  }
  return byAccount;
}

class Tally {
  eventsRead = 0;
  merged = 0;
  superseded = 0;
  noMembers = 0;
  cipherFailures = 0;
  accountsWithoutSettings = 0;
  pairsDecided = 0;
  undeliverable = 0;
  statesWritten = 0;
  outboxInserted = 0;
  outboxAlreadyDecided = 0;
  decisionsLogged = 0;
  readonly deferred = noDeferrals();
  private readonly outcomes = new Map<DecisionOutcome, number>();
  private readonly reasons = new Map<DecisionReason, number>();

  decided(outcome: DecisionOutcome, reason: DecisionReason): void {
    this.pairsDecided += 1;
    this.outcomes.set(outcome, (this.outcomes.get(outcome) ?? 0) + 1);
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
  }

  report(): Omit<
    AlertEvaluationCycleReport,
    'atIso' | 'cursorFrom' | 'cursorTo' | 'batches' | 'behind'
  > {
    const outcomes = Object.fromEntries(
      DECISION_OUTCOMES.map((outcome) => [outcome, this.outcomes.get(outcome) ?? 0]),
    ) as Record<DecisionOutcome, number>;
    const reasons: Partial<Record<DecisionReason, number>> = {};
    for (const reason of DECISION_REASONS) {
      const count = this.reasons.get(reason);
      if (count !== undefined) reasons[reason] = count;
    }
    return {
      eventsRead: this.eventsRead,
      skipped: { merged: this.merged, superseded: this.superseded, noMembers: this.noMembers },
      cipherFailures: this.cipherFailures,
      accountsWithoutSettings: this.accountsWithoutSettings,
      pairsDecided: this.pairsDecided,
      outcomes,
      reasons,
      undeliverable: this.undeliverable,
      statesWritten: this.statesWritten,
      outboxInserted: this.outboxInserted,
      outboxAlreadyDecided: this.outboxAlreadyDecided,
      decisionsLogged: this.decisionsLogged,
      deferred: { ...this.deferred },
    };
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
}

function stateKey(zoneId: string, eventPublicId: string): string {
  return `${zoneId} ${eventPublicId}`;
}

function sortedAscii(values: Iterable<string>): string[] {
  return [...values].sort(compareAscii);
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
