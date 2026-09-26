import { describe, expect, it } from 'vitest';

import { VirtualClock, epochMsFromIso, type EpochMs } from '../ports/clock.js';
import type {
  AlertDigestStore,
  AlertDigestTransaction,
  DigestLogEntry,
  DigestPairRow,
} from '../ports/alert-digest-store.js';
import type { AlertDigestRouting, DigestZoneGroup } from '../ports/alert-digest-routing.js';
import type { AlertCopy, AlertDeliveryTarget } from '../ports/alert-routing.js';
import type { EnqueueResult, OutboxRowDraft } from '../ports/alert-outbox-store.js';
import type { AccountAlertSettings, StoredWatchZone } from '../ports/watch-zone-store.js';
import type { SealedCentre, ZoneCentreCipher } from '../ports/zone-centre-cipher.js';
import type { Coordinate } from '../clustering/geometry.js';
import { ZONE_GRID, indexCellKey } from '../zones/zone-geometry.js';
import { digestSubkey } from './alert-decision.js';
import {
  digestCandidateFor,
  digestLogEntries,
  groupEntriesByZone,
  runAlertDigestCycle,
  type AlertDigestCycleDeps,
} from './digest-pass.js';
import type { DigestDecision } from './digest.js';
import { ZONE_MATCH_METRIC } from './zone-match.js';

// Europe/Sofia is UTC+3 in August, so the 09:00 window opens at 06:00Z.
const WINDOW = '2026-08-14T06:00:00Z';
const PREVIOUS_WINDOW = '2026-08-13T06:00:00Z';
const AT = '2026-08-14T06:05:00Z';
const MINUTE = 60_000;
const SOFIA: Coordinate = { lat: 42.6977, lon: 23.3219 };

function north(km: number, origin: Coordinate = SOFIA): Coordinate {
  return { lat: origin.lat + km / ZONE_MATCH_METRIC.kmPerDegreeLat, lon: origin.lon };
}

// ---------------------------------------------------------------------------------------
// Fakes

/** "Seals" by JSON-encoding; `keyId: 'revoked'` fails to open, as a rotated-out key does. */
const fakeCipher: ZoneCentreCipher = {
  seal: (_zoneId, centre) => ({
    ciphertext: new TextEncoder().encode(JSON.stringify(centre)),
    keyId: 'k1',
  }),
  open: (_zoneId, sealed: SealedCentre) => {
    if (sealed.keyId === 'revoked') throw new Error('unknown key id revoked');
    return JSON.parse(new TextDecoder().decode(sealed.ciphertext)) as Coordinate;
  },
};

const SETTINGS: AccountAlertSettings = {
  timezone: 'Europe/Sofia',
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  newFireOverridesQuietHours: true,
};

interface FakeZone extends StoredWatchZone {
  readonly deleted?: boolean;
}

function zone(
  id: string,
  accountId: string,
  centre: Coordinate = SOFIA,
  options: { radiusM?: number; keyId?: string; createdAtIso?: string; deleted?: boolean } = {},
): FakeZone {
  return {
    id,
    accountId,
    name: id,
    radiusM: options.radiusM ?? 20_000,
    minScore: 0.45,
    sealed: { ...fakeCipher.seal(id, centre), keyId: options.keyId ?? 'k1' },
    coarsened: true,
    gridVersion: ZONE_GRID.version,
    gridCell: indexCellKey(centre),
    createdAtIso: options.createdAtIso ?? '2026-08-01T00:00:00.000Z',
    ...(options.deleted === undefined ? {} : { deleted: options.deleted }),
  };
}

function pair(
  zoneId: string,
  n: number,
  km: number,
  overrides: Partial<DigestPairRow> = {},
): DigestPairRow {
  return {
    zoneId,
    fireEventId: String(100 + n),
    seq: String(1000 + n),
    eventPublicId: `fw-2026-e000${String(n)}`,
    centroid: north(km),
    seededAtIso: null,
    lastNotifiedAtIso: '2026-08-12T10:00:00.000Z',
    lastDeferredAtIso: null,
    ...overrides,
  };
}

interface Account {
  settings: AccountAlertSettings | null;
  pairs: DigestPairRow[];
}

interface World {
  accounts: Map<string, Account>;
  zones: FakeZone[];
  log: DigestLogEntry[];
  outbox: Map<string, OutboxRowDraft>;
}

function world(partial: Partial<World> = {}): World {
  return { accounts: new Map(), zones: [], log: [], outbox: new Map(), ...partial };
}

const logKey = (e: DigestLogEntry): string => `${e.zoneId}|${e.windowStartIso}|${e.outcome}`;
const outboxKey = (r: OutboxRowDraft): string =>
  `${r.watchZoneId}|${r.fireEventId}|${r.alertType}|${r.alertSubkey}`;

/** Commit-or-rollback over a copy of the world, like one database transaction. */
class FakeStore implements AlertDigestStore {
  transactions = 0;
  pairLoads = 0;
  /** Simulates a pass that read the watermark before a racing pass committed its window. */
  staleWatermark = false;
  /** Accounts whose transaction throws after writing, to prove the rollback. */
  readonly failing = new Set<string>();

  constructor(readonly w: World) {}

  listAccountsAfter(afterId: string | null, limit: number): Promise<readonly string[]> {
    const live = [...this.w.accounts]
      .filter(([id, account]) => {
        if (account.settings === null) return false;
        return this.w.zones.some((z) => z.accountId === id && z.deleted !== true);
      })
      .map(([id]) => id)
      .sort();
    return Promise.resolve(live.filter((id) => afterId === null || id > afterId).slice(0, limit));
  }

  async withAccount<T>(
    accountId: string,
    work: (tx: AlertDigestTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactions += 1;
    const draft: World = { ...this.w, log: [...this.w.log], outbox: new Map(this.w.outbox) };
    const result = await work(this.tx(draft));
    if (this.failing.has(accountId)) throw new Error('boom after the writes');
    Object.assign(this.w, draft);
    return result;
  }

  private tx(d: World): AlertDigestTransaction {
    const zonesOf = (accountId: string, includeDeleted: boolean): FakeZone[] =>
      d.zones.filter((z) => z.accountId === accountId && (includeDeleted || z.deleted !== true));
    return {
      lockAccount: (accountId) => Promise.resolve(d.accounts.get(accountId)?.settings ?? null),
      listZones: (accountId) => Promise.resolve(zonesOf(accountId, false)),
      readWatermark: (accountId) => {
        if (this.staleWatermark) return Promise.resolve(null);
        const ids = new Set(zonesOf(accountId, true).map((z) => z.id));
        const spent = d.log.filter(
          (e) => ids.has(e.zoneId) && (e.outcome === 'send' || e.outcome === 'suppress'),
        );
        if (spent.length === 0) return Promise.resolve(null);
        const windowStartIso =
          spent
            .map((e) => e.windowStartIso)
            .sort()
            .at(-1) ?? '';
        const decidedAtIso =
          spent
            .filter((e) => e.windowStartIso === windowStartIso)
            .map((e) => e.decidedAtIso)
            .sort()[0] ?? '';
        return Promise.resolve({ windowStartIso, decidedAtIso });
      },
      loadPairs: (accountId) => {
        this.pairLoads += 1;
        return Promise.resolve(d.accounts.get(accountId)?.pairs ?? []);
      },
      appendLog: (entries) => {
        const held = new Set(d.log.map(logKey));
        let inserted = 0;
        for (const entry of entries) {
          if (held.has(logKey(entry))) continue;
          held.add(logKey(entry));
          d.log.push(entry);
          inserted += 1;
        }
        return Promise.resolve(inserted);
      },
      outbox: {
        enqueue: (rows): Promise<EnqueueResult> => {
          let inserted = 0;
          for (const row of rows) {
            if (d.outbox.has(outboxKey(row))) continue;
            d.outbox.set(outboxKey(row), row);
            inserted += 1;
          }
          return Promise.resolve({
            received: rows.length,
            inserted,
            alreadyDecided: rows.length - inserted,
          });
        },
      },
    };
  }
}

class FakeRouting implements AlertDigestRouting {
  readonly groups: DigestZoneGroup[] = [];
  noTarget = new Set<string>();
  noCopyForZone = new Set<string>();

  targetFor(accountId: string): Promise<AlertDeliveryTarget | null> {
    if (this.noTarget.has(accountId)) return Promise.resolve(null);
    return Promise.resolve({ channel: 'push', channelSubscriptionId: `sub-${accountId}` });
  }

  digestCopyFor(group: DigestZoneGroup): AlertCopy | null {
    this.groups.push(group);
    if (this.noCopyForZone.has(group.zoneId)) return null;
    return { templateId: 'digest.test.v0', templateParams: { lines: group.entries.length } };
  }
}

function deps(
  store: FakeStore,
  routing: FakeRouting,
  at: string | EpochMs = AT,
  overrides: Partial<AlertDigestCycleDeps> = {},
): AlertDigestCycleDeps {
  return {
    store,
    cipher: fakeCipher,
    routing,
    clock: new VirtualClock(at),
    accountPageSize: 10,
    ...overrides,
  };
}

/** One account `a1` with two zones round Sofia, and the given pairs. */
function oneAccount(
  pairs: DigestPairRow[],
  settings: AccountAlertSettings = SETTINGS,
): { w: World; store: FakeStore; routing: FakeRouting } {
  const w = world({
    accounts: new Map([['a1', { settings, pairs }]]),
    zones: [zone('z1', 'a1'), zone('z2', 'a1', north(8))],
  });
  return { w, store: new FakeStore(w), routing: new FakeRouting() };
}

// ---------------------------------------------------------------------------------------

describe('runAlertDigestCycle', () => {
  it('sends a due window: one log row per live zone, one outbox row per rendering zone', async () => {
    const deferredAt = '2026-08-13T15:00:00.000Z';
    const { w, store, routing } = oneAccount([
      pair('z1', 1, 2, { lastDeferredAtIso: deferredAt }),
      pair('z1', 2, 5),
    ]);

    const report = await runAlertDigestCycle(deps(store, routing));

    expect(report).toMatchObject({
      atIso: AT,
      pages: 1,
      accountsRead: 1,
      accountsFailed: 0,
      outcomes: { send: 1, hold: 0, suppress: 0, none: 0 },
      candidates: { deferred: 1, seeded: 0, active: 1 },
      linesSent: 2,
      digestsLogged: 2,
      outboxInserted: 1,
      undeliverable: 0,
    });
    expect(w.log.map((e) => [e.zoneId, e.outcome, e.reason, e.entryCount])).toEqual([
      ['z1', 'send', 'daily_summary', 2],
      ['z2', 'send', 'daily_summary', 2],
    ]);
    expect(w.log.every((e) => e.windowStartIso === WINDOW && e.decidedAtIso === AT)).toBe(true);
    const rows = [...w.outbox.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      watchZoneId: 'z1',
      // The group's nearest fire carries the row (A1.11).
      fireEventId: '101',
      triggerRefSeq: '1001',
      alertType: 'digest',
      triggerType: 'digest',
      alertSubkey: digestSubkey(WINDOW),
      templateId: 'digest.test.v0',
      templateParams: { lines: 2 },
      channel: 'push',
      channelSubscriptionId: 'sub-a1',
      status: 'pending',
      budgetSeq: null,
      decidedAt: epochMsFromIso(AT),
    });
    expect(routing.groups[0]?.entries.map((e) => [e.eventPublicId, e.kind])).toEqual([
      ['fw-2026-e0001', 'deferred'],
      ['fw-2026-e0002', 'active'],
    ]);
  });

  it('never re-delivers a spent window, and skips the pair read when nothing is due', async () => {
    const { w, store, routing } = oneAccount([pair('z1', 1, 2)]);
    await runAlertDigestCycle(deps(store, routing));
    const loadsAfterFirst = store.pairLoads;

    const again = await runAlertDigestCycle(deps(store, routing, AT));
    const later = await runAlertDigestCycle(deps(store, routing, '2026-08-14T20:00:00.000Z'));

    expect(again.outcomes).toEqual({ send: 0, hold: 0, suppress: 0, none: 1 });
    expect(later.outcomes.none).toBe(1);
    expect(store.pairLoads).toBe(loadsAfterFirst);
    expect(w.log).toHaveLength(2);
    expect(w.outbox.size).toBe(1);
  });

  it('holds a window that opens in quiet hours, once per zone, then sends it under the same subkey', async () => {
    const quietMorning = { ...SETTINGS, quietHoursStart: '08:00', quietHoursEnd: '10:00' };
    const { w, store, routing } = oneAccount([pair('z1', 1, 2)], quietMorning);

    const first = await runAlertDigestCycle(deps(store, routing, AT));
    const second = await runAlertDigestCycle(deps(store, routing, '2026-08-14T06:35:00.000Z'));
    expect(first).toMatchObject({ outcomes: { hold: 1 }, digestsLogged: 2 });
    expect(second).toMatchObject({ outcomes: { hold: 1 }, digestsLogged: 0 });
    expect(store.pairLoads).toBe(0);
    expect(w.outbox.size).toBe(0);

    // 10:05 local: the quiet hours are over and the held window is still the one owed.
    const released = await runAlertDigestCycle(deps(store, routing, '2026-08-14T07:05:00.000Z'));

    expect(released).toMatchObject({ outcomes: { send: 1 }, outboxInserted: 1 });
    expect([...w.outbox.values()][0]?.alertSubkey).toBe(digestSubkey(WINDOW));
    expect(w.log.map((e) => `${e.zoneId}:${e.outcome}`)).toEqual([
      'z1:hold',
      'z2:hold',
      'z1:send',
      'z2:send',
    ]);
  });

  it('spends a window over a quiet map with a suppress row and no message', async () => {
    const { w, store, routing } = oneAccount([]);

    const report = await runAlertDigestCycle(deps(store, routing));
    const tomorrowEarly = await runAlertDigestCycle(
      deps(store, routing, '2026-08-15T05:00:00.000Z'),
    );

    expect(report).toMatchObject({ outcomes: { suppress: 1 }, digestsLogged: 2, linesSent: 0 });
    expect(w.log.map((e) => [e.outcome, e.reason, e.entryCount])).toEqual([
      ['suppress', 'nothing_active', 0],
      ['suppress', 'nothing_active', 0],
    ]);
    expect(w.outbox.size).toBe(0);
    expect(routing.groups).toEqual([]);
    expect(tomorrowEarly.outcomes.none).toBe(1);
  });

  it('writes nothing for an undeliverable digest, so the same window is offered again', async () => {
    const { w, store, routing } = oneAccount([pair('z1', 1, 2)]);
    routing.noTarget.add('a1');

    const blocked = await runAlertDigestCycle(deps(store, routing));
    expect(blocked).toMatchObject({ outcomes: { send: 1 }, undeliverable: 1, digestsLogged: 0 });
    expect(w.log).toEqual([]);
    expect(w.outbox.size).toBe(0);

    routing.noTarget.clear();
    const delivered = await runAlertDigestCycle(deps(store, routing, '2026-08-14T06:10:00.000Z'));
    expect(delivered).toMatchObject({ outcomes: { send: 1 }, outboxInserted: 1 });
    expect([...w.outbox.values()][0]?.alertSubkey).toBe(digestSubkey(WINDOW));
  });

  it('drops a zone group without reviewed copy, and is undeliverable when every group lacks it', async () => {
    const pairs = [pair('z1', 1, 1), pair('z2', 2, 9)];
    const partial = oneAccount(pairs);
    partial.routing.noCopyForZone.add('z2');

    const report = await runAlertDigestCycle(deps(partial.store, partial.routing));

    expect(report).toMatchObject({ groupsWithoutCopy: 1, outboxInserted: 1, undeliverable: 0 });
    expect([...partial.w.outbox.values()].map((r) => r.watchZoneId)).toEqual(['z1']);

    const none = oneAccount(pairs);
    none.routing.noCopyForZone.add('z1');
    none.routing.noCopyForZone.add('z2');
    const blocked = await runAlertDigestCycle(deps(none.store, none.routing));
    expect(blocked).toMatchObject({ groupsWithoutCopy: 2, undeliverable: 1, digestsLogged: 0 });
    expect(none.w.log).toEqual([]);
  });

  it('writes no outbox row when another pass already logged the window', async () => {
    const { w, store, routing } = oneAccount([pair('z1', 1, 2)]);
    await runAlertDigestCycle(deps(store, routing));
    w.outbox.clear(); // Whatever the winner wrote is its own; this pass must add nothing.
    store.staleWatermark = true;

    const loser = await runAlertDigestCycle(deps(store, routing, '2026-08-14T06:06:00.000Z'));

    expect(loser).toMatchObject({
      outcomes: { send: 1 },
      alreadyDecided: 1,
      digestsLogged: 0,
      linesSent: 0,
      outboxInserted: 0,
    });
    expect(w.outbox.size).toBe(0);
  });

  it('renders a fire once, from the nearest zone, across all of the account zones (A1.12)', async () => {
    // Event 1 lies 6 km north of Sofia: 6 km from z1 and 2 km from z2 (8 km north).
    const { w, store, routing } = oneAccount([
      pair('z1', 1, 6),
      pair('z2', 1, 6),
      pair('z1', 2, 1),
    ]);

    const report = await runAlertDigestCycle(deps(store, routing));

    expect(report).toMatchObject({ linesSent: 2, outboxInserted: 2 });
    expect(routing.groups.map((g) => [g.zoneId, g.entries.map((e) => e.eventPublicId)])).toEqual([
      ['z1', ['fw-2026-e0002']],
      ['z2', ['fw-2026-e0001']],
    ]);
    expect([...w.outbox.values()].map((r) => [r.watchZoneId, r.fireEventId])).toEqual([
      ['z1', '102'],
      ['z2', '101'],
    ]);
  });

  it('leaves out pairs outside their zone and zones whose centre does not open', async () => {
    const w = world({
      accounts: new Map([
        [
          'a1',
          { settings: SETTINGS, pairs: [pair('z1', 1, 30), pair('z1', 2, 3), pair('zr', 3, 1)] },
        ],
      ]),
      zones: [zone('z1', 'a1'), zone('zr', 'a1', SOFIA, { keyId: 'revoked' })],
    });
    const store = new FakeStore(w);
    const routing = new FakeRouting();

    const report = await runAlertDigestCycle(deps(store, routing));

    expect(report).toMatchObject({
      pairsRead: 3,
      pairsOutsideZone: 1,
      cipherFailures: 1,
      linesSent: 1,
    });
    expect(routing.groups.flatMap((g) => g.entries.map((e) => e.eventPublicId))).toEqual([
      'fw-2026-e0002',
    ]);
  });

  it('does not list a fire seeded after the window opened until the next window (A1.8)', async () => {
    const seeded = pair('z1', 1, 2, {
      seededAtIso: '2026-08-14T06:03:00.000Z',
      lastNotifiedAtIso: null,
    });
    const { w, store, routing } = oneAccount([seeded]);

    const today = await runAlertDigestCycle(deps(store, routing));
    const tomorrow = await runAlertDigestCycle(deps(store, routing, '2026-08-15T06:05:00.000Z'));

    expect(today).toMatchObject({ outcomes: { suppress: 1 }, candidates: { seeded: 1 } });
    expect(tomorrow).toMatchObject({ outcomes: { send: 1 }, candidates: { active: 1 } });
    expect(w.outbox.size).toBe(1);
  });

  it('counts an erased or zoneless account as gone and writes nothing for it', async () => {
    const w = world({
      accounts: new Map([['a1', { settings: SETTINGS, pairs: [pair('z1', 1, 2)] }]]),
      zones: [zone('z1', 'a1')],
    });
    const store = new FakeStore(w);
    const listed = await store.listAccountsAfter(null, 10);
    // Erased between the listing and the transaction.
    w.accounts.set('a1', { settings: null, pairs: [] });
    const erased: FakeStore = Object.assign(new FakeStore(w), {
      listAccountsAfter: () => Promise.resolve(listed),
    });

    const report = await runAlertDigestCycle(deps(erased, new FakeRouting()));

    expect(report).toMatchObject({ accountsRead: 1, accountsGone: 1, digestsLogged: 0 });
    expect(w.log).toEqual([]);
  });

  it('rolls back one failing account without holding up the others', async () => {
    const w = world({
      accounts: new Map([
        ['a1', { settings: SETTINGS, pairs: [pair('z1', 1, 2)] }],
        ['a2', { settings: SETTINGS, pairs: [pair('z2', 2, 2)] }],
      ]),
      zones: [zone('z1', 'a1'), zone('z2', 'a2')],
    });
    const store = new FakeStore(w);
    store.failing.add('a1');

    const report = await runAlertDigestCycle(deps(store, new FakeRouting()));

    expect(report).toMatchObject({
      accountsRead: 2,
      accountsFailed: 1,
      outcomes: { send: 1 },
      digestsLogged: 1,
      outboxInserted: 1,
    });
    expect(w.log.map((e) => e.zoneId)).toEqual(['z2']);
    expect([...w.outbox.values()].map((r) => r.watchZoneId)).toEqual(['z2']);
  });

  it('throws when every account failed: an outage, not a data fault', async () => {
    const { store, routing } = oneAccount([pair('z1', 1, 2)], {
      ...SETTINGS,
      timezone: 'Mars/Olympus_Mons',
    });

    await expect(runAlertDigestCycle(deps(store, routing))).rejects.toThrow(
      'every one of 1 digest accounts failed',
    );
  });

  it('pages through the accounts and refuses a bad page size', async () => {
    const accounts = new Map<string, Account>();
    const zones: FakeZone[] = [];
    for (const id of ['a1', 'a2', 'a3']) {
      accounts.set(id, { settings: SETTINGS, pairs: [] });
      zones.push(zone(`z-${id}`, id));
    }
    const store = new FakeStore(world({ accounts, zones }));

    const report = await runAlertDigestCycle(
      deps(store, new FakeRouting(), AT, { accountPageSize: 2 }),
    );

    expect(report).toMatchObject({ pages: 2, accountsRead: 3, outcomes: { suppress: 3 } });
    await expect(
      runAlertDigestCycle(deps(store, new FakeRouting(), AT, { accountPageSize: 0 })),
    ).rejects.toThrow(RangeError);
  });

  it('reports counts only: no account, zone or event id', async () => {
    const { store, routing } = oneAccount([pair('z1', 1, 2)]);

    const report = await runAlertDigestCycle(deps(store, routing));
    const text = JSON.stringify(report);

    for (const id of ['a1', 'z1', 'z2', 'fw-2026-e0001', '101', 'sub-a1']) {
      expect(text).not.toContain(`"${id}"`);
    }
  });

  it('keeps the watermark across a deleted zone: its spent window stays spent', async () => {
    const { w, store, routing } = oneAccount([pair('z1', 1, 2)]);
    await runAlertDigestCycle(deps(store, routing));
    w.zones = w.zones.map((z) => (z.id === 'z1' ? { ...z, deleted: true } : z));
    w.log = w.log.filter((e) => e.zoneId === 'z1');

    const again = await runAlertDigestCycle(deps(store, routing, '2026-08-14T06:30:00.000Z'));

    expect(again.outcomes.none).toBe(1);
  });
});

describe('digestCandidateFor', () => {
  const at = epochMsFromIso(AT);
  const paidAt = epochMsFromIso('2026-08-13T06:02:00.000Z');

  it('owes a deferral recorded at or after the last spent window as deferred', () => {
    const p = pair('z1', 1, 2, { lastDeferredAtIso: '2026-08-13T06:02:00.000Z' });
    expect(digestCandidateFor(p, 2, paidAt, at)).toMatchObject({
      kind: 'deferred',
      since: paidAt,
      distanceKm: 2,
    });
  });

  it('reads a deferral the last window already carried as active', () => {
    const p = pair('z1', 1, 2, {
      lastDeferredAtIso: '2026-08-13T06:01:59.000Z',
      lastNotifiedAtIso: '2026-08-12T10:00:00.000Z',
    });
    expect(digestCandidateFor(p, 2, paidAt, at)).toMatchObject({
      kind: 'active',
      since: epochMsFromIso('2026-08-12T10:00:00.000Z'),
    });
  });

  it('owes every deferral when no window was ever spent', () => {
    const p = pair('z1', 1, 2, { lastDeferredAtIso: '2026-01-01T00:00:00.000Z' });
    expect(digestCandidateFor(p, 2, null, at).kind).toBe('deferred');
  });

  it('prefers a deferral over a seed, and a seed over plain activity', () => {
    const both = pair('z1', 1, 2, {
      lastDeferredAtIso: '2026-08-14T01:00:00.000Z',
      seededAtIso: '2026-08-14T00:00:00.000Z',
    });
    const seededOnly = pair('z1', 1, 2, { seededAtIso: '2026-08-14T00:00:00.000Z' });
    expect(digestCandidateFor(both, 2, paidAt, at).kind).toBe('deferred');
    expect(digestCandidateFor(seededOnly, 2, paidAt, at)).toMatchObject({
      kind: 'seeded',
      since: epochMsFromIso('2026-08-14T00:00:00.000Z'),
    });
  });

  it('dates an active pair from its seed, then its last notification, then now', () => {
    const oldSeed = pair('z1', 1, 2, {
      seededAtIso: '2026-08-10T00:00:00.000Z',
      lastNotifiedAtIso: '2026-08-12T00:00:00.000Z',
    });
    const neither = pair('z1', 1, 2, { seededAtIso: null, lastNotifiedAtIso: null });
    expect(digestCandidateFor(oldSeed, 2, paidAt, at)).toMatchObject({
      kind: 'active',
      since: epochMsFromIso('2026-08-10T00:00:00.000Z'),
    });
    expect(digestCandidateFor(neither, 2, paidAt, at)).toMatchObject({ kind: 'active', since: at });
  });
});

describe('digestLogEntries and groupEntriesByZone', () => {
  const decision = (overrides: Partial<DigestDecision>): DigestDecision => ({
    accountId: 'a1',
    outcome: 'send',
    reason: 'daily_summary',
    windowStartIso: WINDOW,
    alertType: 'digest',
    alertSubkey: WINDOW,
    priority: 30,
    advanceWatermark: true,
    ruleVersion: 'digest_params_v1',
    entries: [
      { zoneId: 'z2', eventPublicId: 'e1', distanceKm: 1, kind: 'active' },
      { zoneId: 'z1', eventPublicId: 'e2', distanceKm: 2, kind: 'deferred' },
      { zoneId: 'z2', eventPublicId: 'e3', distanceKm: 3, kind: 'seeded' },
    ],
    ...overrides,
  });

  it('logs one row per zone with migration 018 reasons, and nothing for none', () => {
    const zones = [{ id: 'z1' }, { id: 'z2' }];
    expect(digestLogEntries(decision({}), zones, AT)).toEqual([
      {
        zoneId: 'z1',
        windowStartIso: WINDOW,
        outcome: 'send',
        reason: 'daily_summary',
        entryCount: 3,
        ruleVersion: 'digest_params_v1',
        decidedAtIso: AT,
      },
      {
        zoneId: 'z2',
        windowStartIso: WINDOW,
        outcome: 'send',
        reason: 'daily_summary',
        entryCount: 3,
        ruleVersion: 'digest_params_v1',
        decidedAtIso: AT,
      },
    ]);
    expect(
      digestLogEntries(decision({ outcome: 'hold', reason: 'quiet_hours' }), zones, AT).map((e) => [
        e.reason,
        e.entryCount,
      ]),
    ).toEqual([
      ['quiet_hours', 0],
      ['quiet_hours', 0],
    ]);
    expect(
      digestLogEntries(decision({ outcome: 'none', windowStartIso: null }), zones, AT),
    ).toEqual([]);
  });

  it('groups by rendering zone in the order of each zone nearest line', () => {
    expect(
      groupEntriesByZone(decision({}).entries).map((g) => [
        g.zoneId,
        g.entries.map((e) => e.eventPublicId),
      ]),
    ).toEqual([
      ['z2', ['e1', 'e3']],
      ['z1', ['e2']],
    ]);
  });
});

describe('the probe', () => {
  it('decides "none" before the first window the reader was watching for', async () => {
    const w = world({
      accounts: new Map([['a1', { settings: SETTINGS, pairs: [pair('z1', 1, 2)] }]]),
      // Created at 11:00 local, after today's window: tomorrow's is the first one owed.
      zones: [zone('z1', 'a1', SOFIA, { createdAtIso: '2026-08-14T08:00:00.000Z' })],
    });
    const store = new FakeStore(w);

    const report = await runAlertDigestCycle(
      deps(store, new FakeRouting(), epochMsFromIso('2026-08-14T08:00:00.000Z') + 5 * MINUTE),
    );

    expect(report.outcomes.none).toBe(1);
    expect(store.pairLoads).toBe(0);
    expect(w.log).toEqual([]);
  });

  it('logs nothing and loads nothing for a watermark already at today', () => {
    const entries = digestLogEntries(
      {
        accountId: 'a1',
        outcome: 'none',
        reason: 'no_window_due',
        windowStartIso: null,
        alertType: null,
        alertSubkey: null,
        priority: null,
        advanceWatermark: false,
        ruleVersion: 'digest_params_v1',
        entries: [],
      },
      [{ id: 'z1' }],
      PREVIOUS_WINDOW,
    );
    expect(entries).toEqual([]);
  });
});
