/**
 * One cycle of the live digest pass (ADR-004 D1, D3, D4, A1.7, A1.8, A1.11, A1.12;
 * 07 §5.5.3; TASKS H3/D9/H7; migration 018).
 *
 * The evaluation loop's `defer` and the zone-creation `seed` advance a pair's state and
 * write no message: they are debts owed to the daily digest (D3). This pass collects them.
 * For every account with a live zone it asks {@link produceDigest} whether a window is due,
 * and if one is, writes what that window resolved to — in one transaction per account:
 *
 *   - **`none`** (no window due, or the reader started watching after it opened): nothing.
 *   - **`hold`** (the window opened inside quiet hours, A1.7): a `hold` row per live zone in
 *     `alert_digest_log`, once per window. The watermark does not move, so the same window
 *     is decided again after the quiet hours end, under the same A1.11 subkey.
 *   - **`suppress`** (nothing active, 07 §5.5.3): a `suppress` row per live zone. Spent.
 *   - **`send`**: a `send` row per live zone, then **one outbox row per zone that renders
 *     at least one line** (A1.12 renders each fire from the account's nearest zone), each
 *     carrying its group's nearest fire as the A1.11 event and `digestSubkey(window)` as
 *     the subkey. Spent.
 *
 * ## Never re-delivered
 *
 * The watermark *is* the log: an account's last spent window is the newest `send` or
 * `suppress` row over its zones (`AlertDigestTransaction.readWatermark`), written in the
 * same transaction as the outbox rows. A re-run of a committed window sees the watermark
 * and decides `none`. Two passes racing on one account both see the old watermark, but the
 * log's `UNIQUE (zone, window, outcome)` makes the second one's `send` rows conflict — and
 * a pass whose log insert conflicted writes **no** outbox row. The outbox's A1.11 key is
 * the second line: the same carrier in the same window inserts nothing.
 *
 * ## What each pair is owed as
 *
 * `produceDigest` filters candidates by kind (`isOwed`), so the kind has to be right. The
 * replay remembers debts in memory; here they are read back from the rows that recorded
 * them ({@link digestCandidateFor}):
 *
 *   - **`deferred`** — the pair's newest evaluation `defer` in the decision log (014) came
 *     after the last spent window was decided, so no digest has carried it yet.
 *   - **`seeded`** — likewise for `alert_states.seeded_at` (A1.8). `produceDigest` then only
 *     admits it from the first window that opens after the seed.
 *   - **`active`** — anything else the zone has been told about and that is still burning.
 *
 * The one place this can label a pair differently from the replay is a debt made inside a
 * window that a hold delayed: the replay clears it when that window is sent, and so does
 * this (the comparison is against the spent window's *decision* instant, not its start).
 * A debt left over from a window that was spent without it — only possible if the pair
 * was undigestible then — is `active` here and dropped by the replay; either way the fire
 * gets at most one line per window.
 *
 * ## Undeliverable
 *
 * A `send` needs a delivery target and reviewed copy ({@link AlertDigestRouting}). With no
 * target, or no copy for any group, the pass writes nothing for the account — no log row
 * either — so the window is **not** spent and is offered again on the next tick: a debt
 * must not be marked paid by a message nobody could receive. Counted as `undeliverable`.
 * A group with no copy while others have one is dropped and counted (`groupsWithoutCopy`).
 *
 * ## What the report never carries
 *
 * Counts only: no account id, zone id, event id, distance or coordinate. Decrypted centres
 * live only inside {@link digestAccount}.
 */

import { ALERT_GATING, type AlertGatingParams } from '../config/alert-gating.js';
import { DIGEST_PARAMS, type DigestParams } from '../config/digest-params.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import type { PlanarMetric } from '../clustering/clustering-params.js';
import type { Coordinate } from '../clustering/geometry.js';
import { epochMsFromIso, isoFromEpochMs, type Clock, type EpochMs } from '../ports/clock.js';
import type {
  AlertDigestStore,
  AlertDigestTransaction,
  DigestLogEntry,
  DigestPairRow,
  DigestWatermark,
} from '../ports/alert-digest-store.js';
import { DIGEST_LOG_REASON_FOR } from '../ports/alert-digest-store.js';
import type { AlertDigestRouting, DigestZoneGroup } from '../ports/alert-digest-routing.js';
import type { OutboxRowDraft } from '../ports/alert-outbox-store.js';
import type { AccountAlertSettings, StoredWatchZone } from '../ports/watch-zone-store.js';
import type { ZoneCentreCipher } from '../ports/zone-centre-cipher.js';
import {
  ALERT_DEFERRAL_REASONS,
  type AlertDeferralReason,
} from '../observability/alert-metrics.js';
import type { AlertZone } from './alert-decision.js';
import {
  DIGEST_CANDIDATE_KINDS,
  DIGEST_OUTCOMES,
  produceDigest,
  type DigestCandidate,
  type DigestCandidateKind,
  type DigestDecision,
  type DigestEntry,
  type DigestOutcome,
} from './digest.js';
import { digestZoneOutboxRow } from './outbox.js';
import { enqueueCountingDeferrals, noDeferrals } from './outbox-enqueue.js';
import { ZONE_MATCH_METRIC, zoneDistanceWithin } from './zone-match.js';

export interface AlertDigestCycleDeps {
  readonly store: AlertDigestStore;
  readonly cipher: ZoneCentreCipher;
  readonly routing: AlertDigestRouting;
  readonly clock: Clock;
  /** Accounts per page of the account listing. A positive integer. */
  readonly accountPageSize: number;
  readonly digest?: VersionedConfig<DigestParams>;
  readonly gating?: VersionedConfig<AlertGatingParams>;
  readonly metric?: PlanarMetric;
}

export interface AlertDigestCycleReport {
  /** The decision instant every account of this cycle was decided at. */
  readonly atIso: string;
  readonly pages: number;
  readonly accountsRead: number;
  /** Accounts whose transaction threw; rolled back, retried next cycle. */
  readonly accountsFailed: number;
  /** Accounts erased, tombstoned or left without live zones since they were listed. */
  readonly accountsGone: number;
  /** Per account, what the window resolved to (`undeliverable` sends included in `send`). */
  readonly outcomes: Readonly<Record<DigestOutcome, number>>;
  /** Accounts with a `send` and no target, or no copy for any group: nothing written. */
  readonly undeliverable: number;
  /** Zone groups dropped from an otherwise delivered digest for want of reviewed copy. */
  readonly groupsWithoutCopy: number;
  /** Accounts whose `send` log rows conflicted — another pass got there first. */
  readonly alreadyDecided: number;
  /** Zones whose centre failed to open; their pairs were left out. */
  readonly cipherFailures: number;
  readonly pairsRead: number;
  /** Pairs whose event now lies outside the zone; left out. */
  readonly pairsOutsideZone: number;
  readonly candidates: Readonly<Record<DigestCandidateKind, number>>;
  /** Lines in the digests written this cycle. */
  readonly linesSent: number;
  /** `alert_digest_log` rows inserted; a replayed window inserts none. */
  readonly digestsLogged: number;
  readonly outboxInserted: number;
  readonly outboxAlreadyDecided: number;
  /** Outbox rows newly inserted as `awaiting_approval`, by reason: zero while D5's B is unarmed. */
  readonly deferred: Readonly<Record<AlertDeferralReason, number>>;
}

/**
 * Decides every listed account's digest at one instant, a page of accounts at a time.
 *
 * One account's failure (a bad stored timezone, say) is counted and rolled back without
 * holding up every other account's digest. If every account read failed, the cycle throws
 * — that is an outage, not a data fault, and the loop's failure line must say so.
 */
export async function runAlertDigestCycle(
  deps: AlertDigestCycleDeps,
): Promise<AlertDigestCycleReport> {
  if (!Number.isSafeInteger(deps.accountPageSize) || deps.accountPageSize < 1) {
    throw new RangeError(
      `accountPageSize must be a positive integer, got ${String(deps.accountPageSize)}`,
    );
  }
  const at = deps.clock.now();
  const tally = new DigestTally();
  let firstError: unknown = null;

  let afterId: string | null = null;
  for (;;) {
    const ids = await deps.store.listAccountsAfter(afterId, deps.accountPageSize);
    tally.pages += 1;
    for (const accountId of ids) {
      tally.accountsRead += 1;
      const local = new DigestTally();
      try {
        await deps.store.withAccount(accountId, (tx) =>
          digestAccount(tx, accountId, deps, at, local),
        );
        tally.absorb(local);
      } catch (error) {
        // Deliberately no message in the report: it could name the account.
        tally.accountsFailed += 1;
        firstError ??= error;
      }
    }
    const last = ids[ids.length - 1];
    if (last === undefined || ids.length < deps.accountPageSize) break;
    afterId = last;
  }

  if (tally.accountsFailed > 0 && tally.accountsFailed === tally.accountsRead) {
    throw new Error(`every one of ${String(tally.accountsRead)} digest accounts failed`, {
      cause: firstError,
    });
  }
  return { atIso: isoFromEpochMs(at), ...tally.report() };
}

/** One account's digest, inside its transaction. Writes to `tally` only on commit paths. */
async function digestAccount(
  tx: AlertDigestTransaction,
  accountId: string,
  deps: AlertDigestCycleDeps,
  at: EpochMs,
  tally: DigestTally,
): Promise<void> {
  const config = deps.digest ?? DIGEST_PARAMS;
  const gating = deps.gating ?? ALERT_GATING;
  const metric = deps.metric ?? ZONE_MATCH_METRIC;
  const atIso = isoFromEpochMs(at);

  const settings = await tx.lockAccount(accountId);
  const zones = settings === null ? [] : await tx.listZones(accountId);
  if (settings === null || zones.length === 0) {
    tally.accountsGone += 1;
    return;
  }
  const watermark = await tx.readWatermark(accountId);
  const alertZones = zones.map((zone) => toAlertZone(zone, settings));
  const base = {
    accountId,
    zones: alertZones,
    lastWindowStartIso: watermark?.windowStartIso ?? null,
    watchingSince: earliestCreatedAt(zones),
    at,
  };

  // Probe first, with no candidates: `none` and `hold` do not depend on them, and a pass
  // that ticks every few minutes must not decrypt every zone just to find nothing due.
  const probe = produceDigest({ ...base, candidates: [] }, config, gating);
  if (probe.outcome === 'none') {
    tally.outcome('none');
    return;
  }
  if (probe.outcome === 'hold') {
    tally.outcome('hold');
    tally.digestsLogged += await tx.appendLog(digestLogEntries(probe, zones, atIso));
    return;
  }

  const pairs = await tx.loadPairs(accountId);
  tally.pairsRead += pairs.length;
  const candidates = candidatesFor(pairs, zones, watermark, at, deps.cipher, metric, tally);
  const decision = produceDigest({ ...base, candidates }, config, gating);
  tally.outcome(decision.outcome);

  if (decision.outcome !== 'send') {
    // `suppress` (or, defensively, whatever the probe did not already return).
    if (decision.outcome === 'suppress') {
      tally.digestsLogged += await tx.appendLog(digestLogEntries(decision, zones, atIso));
    }
    return;
  }

  const drafts = await carrierRows(decision, pairs, deps.routing, at, gating, tally);
  if (drafts === null) {
    tally.undeliverable += 1;
    return;
  }

  const entries = digestLogEntries(decision, zones, atIso);
  const logged = await tx.appendLog(entries);
  tally.digestsLogged += logged;
  if (logged < entries.length) {
    // Another pass logged this window first, and wrote its outbox rows with it.
    tally.alreadyDecided += 1;
    return;
  }
  tally.linesSent += decision.entries.length;
  const enqueued = await enqueueCountingDeferrals(tx.outbox, drafts);
  tally.outboxInserted += enqueued.inserted;
  tally.outboxAlreadyDecided += enqueued.alreadyDecided;
  for (const reason of ALERT_DEFERRAL_REASONS) tally.deferred[reason] += enqueued.deferred[reason];
}

/**
 * Pairs → candidates: the zone distance from the decrypted centre, then the kind.
 * A centre that fails to open leaves that zone's pairs out (counted once per zone); an
 * event that has drifted out of the zone is left out too — `produceDigest`'s precondition
 * is "active *in that zone*".
 */
function candidatesFor(
  pairs: readonly DigestPairRow[],
  zones: readonly StoredWatchZone[],
  watermark: DigestWatermark | null,
  at: EpochMs,
  cipher: ZoneCentreCipher,
  metric: PlanarMetric,
  tally: DigestTally,
): DigestCandidate[] {
  const zonesById = new Map(zones.map((zone) => [zone.id, zone]));
  const centres = new Map<string, Coordinate | null>();
  const paidAt = watermark === null ? null : epochMsFromIso(watermark.decidedAtIso);
  const candidates: DigestCandidate[] = [];

  for (const pair of pairs) {
    const zone = zonesById.get(pair.zoneId);
    if (zone === undefined) continue;
    if (!centres.has(zone.id)) {
      try {
        centres.set(zone.id, cipher.open(zone.id, zone.sealed));
      } catch {
        tally.cipherFailures += 1;
        centres.set(zone.id, null);
      }
    }
    const centre = centres.get(zone.id) ?? null;
    if (centre === null) continue;
    const distanceKm = zoneDistanceWithin(centre, zone.radiusM, pair.centroid, metric);
    if (distanceKm === null) {
      tally.pairsOutsideZone += 1;
      continue;
    }
    const candidate = digestCandidateFor(pair, distanceKm, paidAt, at);
    tally.candidates[candidate.kind] += 1;
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * What one pair is owed to the digest as. `paidAt` is when the account's last spent window
 * was decided (`null` for none): a debt recorded at or after it is still unpaid.
 */
export function digestCandidateFor(
  pair: DigestPairRow,
  distanceKm: number,
  paidAt: EpochMs | null,
  at: EpochMs,
): DigestCandidate {
  const unpaid = (iso: string | null): EpochMs | null => {
    if (iso === null) return null;
    const ms = epochMsFromIso(iso);
    return paidAt === null || ms >= paidAt ? ms : null;
  };
  const common = { zoneId: pair.zoneId, eventPublicId: pair.eventPublicId, distanceKm };

  const deferredAt = unpaid(pair.lastDeferredAtIso);
  if (deferredAt !== null) return { ...common, kind: 'deferred', since: deferredAt };
  const seededAt = unpaid(pair.seededAtIso);
  if (seededAt !== null) return { ...common, kind: 'seeded', since: seededAt };
  const known = pair.seededAtIso ?? pair.lastNotifiedAtIso;
  return { ...common, kind: 'active', since: known === null ? at : epochMsFromIso(known) };
}

/** A1.12's fold, regrouped by rendering zone, in the order of each zone's nearest line. */
export function groupEntriesByZone(
  entries: readonly DigestEntry[],
): readonly { readonly zoneId: string; readonly entries: readonly DigestEntry[] }[] {
  const groups = new Map<string, DigestEntry[]>();
  for (const entry of entries) {
    const held = groups.get(entry.zoneId);
    if (held === undefined) groups.set(entry.zoneId, [entry]);
    else held.push(entry);
  }
  return [...groups].map(([zoneId, grouped]) => ({ zoneId, entries: grouped }));
}

/**
 * The log rows for one account-level decision: the same outcome against every live zone,
 * which is what makes the watermark readable per zone and erasable with it.
 */
export function digestLogEntries(
  decision: DigestDecision,
  zones: readonly Pick<StoredWatchZone, 'id'>[],
  decidedAtIso: string,
): readonly DigestLogEntry[] {
  const { outcome, windowStartIso } = decision;
  if (outcome === 'none' || windowStartIso === null) return [];
  const entryCount = outcome === 'send' ? decision.entries.length : 0;
  return zones.map((zone) => ({
    zoneId: zone.id,
    windowStartIso,
    outcome,
    reason: DIGEST_LOG_REASON_FOR[outcome],
    entryCount,
    ruleVersion: decision.ruleVersion,
    decidedAtIso,
  }));
}

/**
 * One outbox row per zone group, or `null` when the digest cannot be delivered at all.
 */
async function carrierRows(
  decision: DigestDecision,
  pairs: readonly DigestPairRow[],
  routing: AlertDigestRouting,
  at: EpochMs,
  gating: VersionedConfig<AlertGatingParams>,
  tally: DigestTally,
): Promise<readonly OutboxRowDraft[] | null> {
  const windowStartIso = decision.windowStartIso;
  if (windowStartIso === null) return null;
  const target = await routing.targetFor(decision.accountId);
  if (target === null) return null;

  const pairsByKey = new Map(pairs.map((pair) => [`${pair.zoneId} ${pair.eventPublicId}`, pair]));
  const drafts: OutboxRowDraft[] = [];
  for (const { zoneId, entries } of groupEntriesByZone(decision.entries)) {
    const group: DigestZoneGroup = {
      accountId: decision.accountId,
      zoneId,
      windowStartIso,
      entries,
    };
    const copy = routing.digestCopyFor(group);
    const [carrier] = entries;
    const pair =
      carrier === undefined ? undefined : pairsByKey.get(`${zoneId} ${carrier.eventPublicId}`);
    if (copy === null || pair === undefined) {
      tally.groupsWithoutCopy += 1;
      continue;
    }
    drafts.push(
      digestZoneOutboxRow(
        decision,
        zoneId,
        entries,
        {
          fireEventId: pair.fireEventId,
          triggerRefSeq: pair.seq,
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
      ),
    );
  }
  return drafts.length === 0 ? null : drafts;
}

/** Distance is irrelevant to the window decision; the candidates carry their own. */
function toAlertZone(zone: StoredWatchZone, account: AccountAlertSettings): AlertZone {
  return {
    zoneId: zone.id,
    minScore: zone.minScore,
    timezone: account.timezone,
    quietHoursStart: account.quietHoursStart,
    quietHoursEnd: account.quietHoursEnd,
    newFireOverridesQuietHours: account.newFireOverridesQuietHours,
    distanceKm: 0,
  };
}

/**
 * The earliest `created_at` among the account's live zones. A reader who deleted their
 * first zone is treated as watching since their oldest surviving one — which only matters
 * before their first spent window, since the watermark governs after it.
 */
function earliestCreatedAt(zones: readonly StoredWatchZone[]): EpochMs {
  return Math.min(...zones.map((zone) => epochMsFromIso(zone.createdAtIso)));
}

class DigestTally {
  pages = 0;
  accountsRead = 0;
  accountsFailed = 0;
  accountsGone = 0;
  undeliverable = 0;
  groupsWithoutCopy = 0;
  alreadyDecided = 0;
  cipherFailures = 0;
  pairsRead = 0;
  pairsOutsideZone = 0;
  linesSent = 0;
  digestsLogged = 0;
  outboxInserted = 0;
  outboxAlreadyDecided = 0;
  readonly deferred = noDeferrals();
  readonly candidates = Object.fromEntries(
    DIGEST_CANDIDATE_KINDS.map((kind) => [kind, 0]),
  ) as Record<DigestCandidateKind, number>;
  readonly outcomes = Object.fromEntries(DIGEST_OUTCOMES.map((o) => [o, 0])) as Record<
    DigestOutcome,
    number
  >;

  outcome(outcome: DigestOutcome): void {
    this.outcomes[outcome] += 1;
  }

  /** Folds one committed account's counts in. A rolled-back account's are discarded. */
  absorb(other: DigestTally): void {
    this.accountsGone += other.accountsGone;
    this.undeliverable += other.undeliverable;
    this.groupsWithoutCopy += other.groupsWithoutCopy;
    this.alreadyDecided += other.alreadyDecided;
    this.cipherFailures += other.cipherFailures;
    this.pairsRead += other.pairsRead;
    this.pairsOutsideZone += other.pairsOutsideZone;
    this.linesSent += other.linesSent;
    this.digestsLogged += other.digestsLogged;
    this.outboxInserted += other.outboxInserted;
    this.outboxAlreadyDecided += other.outboxAlreadyDecided;
    for (const reason of ALERT_DEFERRAL_REASONS) this.deferred[reason] += other.deferred[reason];
    for (const kind of DIGEST_CANDIDATE_KINDS) this.candidates[kind] += other.candidates[kind];
    for (const outcome of DIGEST_OUTCOMES) this.outcomes[outcome] += other.outcomes[outcome];
  }

  report(): Omit<AlertDigestCycleReport, 'atIso'> {
    return {
      pages: this.pages,
      accountsRead: this.accountsRead,
      accountsFailed: this.accountsFailed,
      accountsGone: this.accountsGone,
      outcomes: { ...this.outcomes },
      undeliverable: this.undeliverable,
      groupsWithoutCopy: this.groupsWithoutCopy,
      alreadyDecided: this.alreadyDecided,
      cipherFailures: this.cipherFailures,
      pairsRead: this.pairsRead,
      pairsOutsideZone: this.pairsOutsideZone,
      candidates: { ...this.candidates },
      linesSent: this.linesSent,
      digestsLogged: this.digestsLogged,
      outboxInserted: this.outboxInserted,
      outboxAlreadyDecided: this.outboxAlreadyDecided,
      deferred: { ...this.deferred },
    };
  }
}
