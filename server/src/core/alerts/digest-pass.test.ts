import { describe, expect, it } from 'vitest';

import { VirtualClock, epochMsFromIso } from '../ports/clock.js';
import type {
  AlertDigestStore,
  AlertDigestTransaction,
  DigestLogEntry,
  DigestPairRow,
  DigestWatermark,
} from '../ports/alert-digest-store.js';
import type { AlertDigestRouting } from '../ports/alert-digest-routing.js';
import type { EnqueueResult, OutboxRowDraft } from '../ports/alert-outbox-store.js';
import type { AccountAlertSettings, StoredWatchZone } from '../ports/watch-zone-store.js';
import type { SealedCentre, ZoneCentreCipher } from '../ports/zone-centre-cipher.js';
import type { Coordinate } from '../clustering/geometry.js';
import { ZONE_GRID, indexCellKey } from '../zones/zone-geometry.js';
import {
  digestCandidateFor,
  runAlertDigestCycle,
  type AlertDigestCycleDeps,
} from './digest-pass.js';
import { ZONE_MATCH_METRIC } from './zone-match.js';

// Sofia is UTC+3 in August, so the 09:00 local digest window opens at 06:00Z.
const WINDOW = '2026-08-14T06:00:00Z';
const NEXT_WINDOW = '2026-08-15T06:00:00Z';
const AFTERNOON = epochMsFromIso('2026-08-14T12:00:00Z'); // 15:00 local
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

function zone(
  id: string,
  accountId: string,
  centre: Coordinate = SOFIA,
  options: { radiusM?: number; keyId?: string; createdAtIso?: string } = {},
): StoredWatchZone {
  return {
    id,
    accountId,
    name: id,
    radiusM: options.radiusM ?? 10_000,
    minScore: 0.45,
    sealed: { ...fakeCipher.seal(id, centre), keyId: options.keyId ?? 'k1' },
    coarsened: true,
    gridVersion: ZONE_GRID.version,
    gridCell: indexCellKey(centre),
    createdAtIso: options.createdAtIso ?? '2026-08-01T00:00:00.000Z',
  };
}

function pair(zoneId: string, publicId: string, overrides: Partial<DigestPairRow> = {}) {
  return {
    zoneId,
    fireEventId: `id-${publicId}`,
    seq: '41',
    eventPublicId: publicId,
    centroid: north(2),
    seededAtIso: null,
    lastNotifiedAtIso: '2026-08-13T10:00:00.000Z',
    lastDeferredAtIso: null,
    ...overrides,
  } satisfies DigestPairRow;
}

interface Account {
  settings: AccountAlertSettings | null;
  zones: StoredWatchZone[];
  pairs: DigestPairRow[];
}

interface World {
  accounts: Map<string, Account>;
  /** `alert_digest_log`, keyed by its UNIQUE (zone, window, outcome). */
  log: Map<string, DigestLogEntry>;
  /** `alert_outbox`, keyed by A1.11's (zone, event, type, subkey). */
  outbox: Map<string, OutboxRowDraft>;
}

const logKey = (e: Pick<DigestLogEntry, 'zoneId' | 'windowStartIso' | 'outcome'>): string =>
  [e.zoneId, e.windowStartIso, e.outcome].join('|');

/**
 * The port as migration 018 defines it. The watermark is derived from the log — newest
 * `send`/`suppress` window over every zone the account ever had — and a transaction's
 * writes land only if `work` resolves.
 */
class FakeDigestStore implements AlertDigestStore {
  /** Zone ids per account, soft-deleted ones included (they still carry the watermark). */
  readonly everZones = new Map<string, string[]>();
  failFor = new Set<string>();
  /** Runs inside the transaction just before `appendLog`, to stage a racing pass. */
  beforeAppend: ((world: World) => void) | null = null;

  constructor(readonly w: World) {
    for (const [id, account] of w.accounts) {
      this.everZones.set(
        id,
        account.zones.map((z) => z.id),
      );
    }
  }

  listAccountsAfter(afterId: string | null, limit: number): Promise<readonly string[]> {
    const live = [...this.w.accounts]
      .filter(([, a]) => a.settings !== null && a.zones.length > 0)
      .map(([id]) => id)
      .sort()
      .filter((id) => afterId === null || id > afterId);
    return Promise.resolve(live.slice(0, limit));
  }

  async withAccount<T>(
    accountId: string,
    work: (tx: AlertDigestTransaction) => Promise<T>,
  ): Promise<T> {
    const draft: World = { ...this.w, log: new Map(this.w.log), outbox: new Map(this.w.outbox) };
    const result = await work(this.tx(draft, accountId));
    if (this.failFor.has(accountId)) throw new Error('commit failed');
    Object.assign(this.w, draft);
    return result;
  }

  private tx(d: World, accountId: string): AlertDigestTransaction {
    const account = d.accounts.get(accountId);
    const everZones = new Set(this.everZones.get(accountId) ?? []);
    return {
      lockAccount: () => Promise.resolve(account?.settings ?? null),
      listZones: () => Promise.resolve(account?.zones ?? []),
      readWatermark: (): Promise<DigestWatermark | null> => {
        const spent = [...d.log.values()]
          .filter((e) => everZones.has(e.zoneId) && e.outcome !== 'hold')
          .sort((a, b) => (a.windowStartIso < b.windowStartIso ? 1 : -1));
        const [newest] = spent;
        return Promise.resolve(
          newest === undefined
            ? null
            : { windowStartIso: newest.windowStartIso, decidedAtIso: newest.decidedAtIso },
        );
      },
      loadPairs: () => Promise.resolve(account?.pairs ?? []),
      appendLog: (entries) => {
        this.beforeAppend?.(d);
        let inserted = 0;
        for (const entry of entries) {
          if (d.log.has(logKey(entry))) continue;
          d.log.set(logKey(entry), entry);
          inserted += 1;
        }
        return Promise.resolve(inserted);
      },
      outbox: {
        enqueue: (rows): Promise<EnqueueResult> => {
          let inserted = 0;
          for (const row of rows) {
            const k = [row.watchZoneId, row.fireEventId, row.alertType, row.alertSubkey].join('|');
            if (d.outbox.has(k)) continue;
            d.outbox.set(k, row);
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

const routing: AlertDigestRouting = {
  targetFor: () => Promise.resolve({ channel: 'push', channelSubscriptionId: 'sub-1' }),
  digestCopyFor: (group) => ({
    templateId: 'test.digest',
    templateParams: { lines: group.entries.map((e) => e.eventPublicId) },
  }),
};

function world(accounts: Record<string, Account>): World {
  return { accounts: new Map(Object.entries(accounts)), log: new Map(), outbox: new Map() };
}

function deps(
  store: AlertDigestStore,
  at = AFTERNOON,
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

function oneFire(): World {
  return world({
    a1: { settings: SETTINGS, zones: [zone('z1', 'a1')], pairs: [pair('z1', 'fw-2026-aaaaa')] },
  });
}

// ---------------------------------------------------------------------------------------

describe('runAlertDigestCycle — the window outcomes', () => {
  it('sends a due window: one log row per live zone, one outbox row, then spends it', async () => {
    const w = oneFire();
    const store = new FakeDigestStore(w);

    const report = await runAlertDigestCycle(deps(store));

    expect(report.outcomes.send).toBe(1);
    expect([...w.log.values()]).toEqual([
      expect.objectContaining({
        zoneId: 'z1',
        windowStartIso: WINDOW,
        outcome: 'send',
        reason: 'daily_summary',
        entryCount: 1,
        ruleVersion: 'digest_params_v1',
      }),
    ]);
    const [row] = [...w.outbox.values()];
    expect(row).toMatchObject({
      watchZoneId: 'z1',
      fireEventId: 'id-fw-2026-aaaaa',
      triggerRefSeq: '41',
      alertType: 'digest',
      alertSubkey: WINDOW,
      templateId: 'test.digest',
      channel: 'push',
      status: 'pending',
    });
    expect(report).toMatchObject({ linesSent: 1, digestsLogged: 1, outboxInserted: 1 });

    // The watermark is the log: the same window is never offered twice.
    const again = await runAlertDigestCycle(deps(store, AFTERNOON + 3_600_000));
    expect(again.outcomes).toMatchObject({ none: 1, send: 0 });
    expect(w.outbox.size).toBe(1);
    expect(w.log.size).toBe(1);
  });

  it('holds a window that opens inside quiet hours, once, then sends it under the same subkey', async () => {
    const w = oneFire();
    const account = w.accounts.get('a1');
    if (account === undefined) throw new Error('fixture');
    account.settings = { ...SETTINGS, quietHoursStart: '08:00', quietHoursEnd: '16:00' };
    const store = new FakeDigestStore(w);

    const held = await runAlertDigestCycle(deps(store)); // 15:00 local: quiet
    expect(held.outcomes.hold).toBe(1);
    expect(w.outbox.size).toBe(0);
    expect([...w.log.values()].map((e) => e.outcome)).toEqual(['hold']);

    // A pass ticking through the quiet hours writes no second hold row.
    const stillHeld = await runAlertDigestCycle(deps(store, AFTERNOON + 30 * 60_000));
    expect(stillHeld.outcomes.hold).toBe(1);
    expect(stillHeld.digestsLogged).toBe(0);

    // A hold never spends the window: at 17:00 local the same window goes out.
    const sent = await runAlertDigestCycle(deps(store, AFTERNOON + 2 * 3_600_000));
    expect(sent.outcomes.send).toBe(1);
    expect([...w.outbox.values()][0]?.alertSubkey).toBe(WINDOW);
  });

  it('suppresses a window over a quiet map, and that spends it', async () => {
    const w = world({ a1: { settings: SETTINGS, zones: [zone('z1', 'a1')], pairs: [] } });
    const store = new FakeDigestStore(w);

    const report = await runAlertDigestCycle(deps(store));
    expect(report.outcomes.suppress).toBe(1);
    expect(w.outbox.size).toBe(0);
    expect([...w.log.values()]).toEqual([
      expect.objectContaining({ outcome: 'suppress', reason: 'nothing_active', entryCount: 0 }),
    ]);

    // A fire that starts after the window belongs to tomorrow's.
    const account = w.accounts.get('a1');
    if (account === undefined) throw new Error('fixture');
    account.pairs = [pair('z1', 'fw-2026-bbbbb')];
    expect((await runAlertDigestCycle(deps(store, AFTERNOON + 3_600_000))).outcomes.none).toBe(1);
    const tomorrow = epochMsFromIso(NEXT_WINDOW) + 60_000;
    expect((await runAlertDigestCycle(deps(store, tomorrow))).outcomes.send).toBe(1);
  });

  it('decides nothing for a reader who started watching after the window opened', async () => {
    const w = world({
      a1: {
        settings: SETTINGS,
        zones: [zone('z1', 'a1', SOFIA, { createdAtIso: '2026-08-14T08:00:00.000Z' })],
        pairs: [pair('z1', 'fw-2026-aaaaa')],
      },
    });
    const report = await runAlertDigestCycle(deps(new FakeDigestStore(w)));
    expect(report.outcomes.none).toBe(1);
    expect(w.log.size + w.outbox.size).toBe(0);
  });
});

describe('runAlertDigestCycle — a debt is never marked paid by a message nobody got', () => {
  it('writes nothing, and keeps the window owed, when the account has no delivery target', async () => {
    const w = oneFire();
    const store = new FakeDigestStore(w);
    const noTarget: AlertDigestRouting = { ...routing, targetFor: () => Promise.resolve(null) };

    const report = await runAlertDigestCycle(deps(store, AFTERNOON, { routing: noTarget }));
    expect(report).toMatchObject({ undeliverable: 1, digestsLogged: 0, outboxInserted: 0 });
    expect(w.log.size + w.outbox.size).toBe(0);

    // Offered again on the next tick, and delivered once a target exists.
    const later = await runAlertDigestCycle(deps(store, AFTERNOON + 60_000));
    expect(later.outcomes.send).toBe(1);
    expect(w.outbox.size).toBe(1);
  });

  it('writes nothing when no zone group has reviewed copy', async () => {
    const w = oneFire();
    const noCopy: AlertDigestRouting = { ...routing, digestCopyFor: () => null };
    const report = await runAlertDigestCycle(
      deps(new FakeDigestStore(w), AFTERNOON, { routing: noCopy }),
    );
    expect(report).toMatchObject({ undeliverable: 1, groupsWithoutCopy: 1 });
    expect(w.log.size + w.outbox.size).toBe(0);
  });

  it('writes no outbox row when another pass logged the window first', async () => {
    const w = oneFire();
    const store = new FakeDigestStore(w);
    // The racing pass read the same old watermark and committed its `send` first.
    store.beforeAppend = (d) => {
      const entry: DigestLogEntry = {
        zoneId: 'z1',
        windowStartIso: WINDOW,
        outcome: 'send',
        reason: 'daily_summary',
        entryCount: 1,
        ruleVersion: 'digest_params_v1',
        decidedAtIso: '2026-08-14T11:59:00.000Z',
      };
      d.log.set(logKey(entry), entry);
    };

    const report = await runAlertDigestCycle(deps(store));
    expect(report).toMatchObject({ alreadyDecided: 1, outboxInserted: 0, linesSent: 0 });
    expect(w.outbox.size).toBe(0);
  });
});

describe('runAlertDigestCycle — what gets onto a digest', () => {
  it('renders each fire once, from the account’s nearest zone, one outbox row per zone', async () => {
    const far = north(20);
    const w = world({
      a1: {
        settings: SETTINGS,
        zones: [zone('z1', 'a1', SOFIA), zone('z2', 'a1', far, { radiusM: 30_000 })],
        pairs: [
          // One fire seen from both zones: z1 is 2 km away, z2 18 km.
          pair('z1', 'fw-2026-aaaaa'),
          pair('z2', 'fw-2026-aaaaa'),
          // One fire only z2 covers.
          pair('z2', 'fw-2026-ccccc', { centroid: north(21), fireEventId: 'id-c', seq: '50' }),
        ],
      },
    });
    const report = await runAlertDigestCycle(deps(new FakeDigestStore(w)));

    expect(report.linesSent).toBe(2);
    expect(report.pairsRead).toBe(3);
    const rows = [...w.outbox.values()];
    expect(rows.map((r) => [r.watchZoneId, r.fireEventId])).toEqual([
      ['z2', 'id-c'],
      ['z1', 'id-fw-2026-aaaaa'],
    ]);
    // Every live zone carries the account-level decision, so the watermark reads per zone.
    expect([...w.log.values()].map((e) => [e.zoneId, e.outcome, e.entryCount])).toEqual([
      ['z1', 'send', 2],
      ['z2', 'send', 2],
    ]);
  });

  it('leaves out a pair whose fire has drifted out of the zone, and the pairs of a zone that will not open', async () => {
    const w = world({
      a1: {
        settings: SETTINGS,
        zones: [
          zone('z1', 'a1', SOFIA, { radiusM: 5_000 }),
          zone('z2', 'a1', SOFIA, { keyId: 'revoked' }),
        ],
        pairs: [pair('z1', 'fw-2026-aaaaa', { centroid: north(9) }), pair('z2', 'fw-2026-bbbbb')],
      },
    });
    const report = await runAlertDigestCycle(deps(new FakeDigestStore(w)));
    expect(report).toMatchObject({ pairsOutsideZone: 1, cipherFailures: 1 });
    // Nothing left to say: the window is answered by saying nothing.
    expect(report.outcomes.suppress).toBe(1);
  });
});

describe('runAlertDigestCycle — accounts, pages and failures', () => {
  it('pages through every account', async () => {
    const accounts: Record<string, Account> = {};
    for (const id of ['a1', 'a2', 'a3']) {
      accounts[id] = { settings: SETTINGS, zones: [zone(`z-${id}`, id)], pairs: [] };
    }
    const report = await runAlertDigestCycle(
      deps(new FakeDigestStore(world(accounts)), AFTERNOON, { accountPageSize: 2 }),
    );
    expect(report).toMatchObject({ pages: 2, accountsRead: 3 });
    expect(report.outcomes.suppress).toBe(3);
  });

  it('counts an account that vanished since the listing and writes nothing for it', async () => {
    const w = oneFire();
    const store = new FakeDigestStore(w);
    const erased: AlertDigestStore = {
      listAccountsAfter: (after, limit) => store.listAccountsAfter(after, limit),
      withAccount: (id, work) =>
        store.withAccount(id, (tx) => work({ ...tx, lockAccount: () => Promise.resolve(null) })),
    };
    const report = await runAlertDigestCycle(deps(erased));
    expect(report.accountsGone).toBe(1);
    expect(w.log.size + w.outbox.size).toBe(0);
  });

  it('rolls one failed account back without holding up the others', async () => {
    const accounts: Record<string, Account> = {
      a1: { settings: SETTINGS, zones: [zone('z1', 'a1')], pairs: [pair('z1', 'fw-2026-aaaaa')] },
      a2: { settings: SETTINGS, zones: [zone('z2', 'a2')], pairs: [pair('z2', 'fw-2026-bbbbb')] },
    };
    const w = world(accounts);
    const store = new FakeDigestStore(w);
    store.failFor.add('a1');

    const report = await runAlertDigestCycle(deps(store));
    expect(report).toMatchObject({ accountsRead: 2, accountsFailed: 1, outboxInserted: 1 });
    expect([...w.outbox.values()].map((r) => r.watchZoneId)).toEqual(['z2']);
    expect([...w.log.values()].map((e) => e.zoneId)).toEqual(['z2']);
  });

  it('throws when every account failed — an outage, not a data fault', async () => {
    const store = new FakeDigestStore(oneFire());
    store.failFor.add('a1');
    await expect(runAlertDigestCycle(deps(store))).rejects.toThrow(
      /every one of 1 digest accounts failed/,
    );
  });

  it('refuses a page size that is not a positive integer', async () => {
    await expect(
      runAlertDigestCycle(deps(new FakeDigestStore(oneFire()), AFTERNOON, { accountPageSize: 0 })),
    ).rejects.toThrow(/accountPageSize/);
  });

  it('reports counts only — no account, zone or event identifier', async () => {
    const report = await runAlertDigestCycle(deps(new FakeDigestStore(oneFire())));
    const text = JSON.stringify(report);
    for (const id of ['a1', 'z1', 'fw-2026-aaaaa', 'id-fw-2026-aaaaa', 'sub-1']) {
      expect(text).not.toContain(id);
    }
  });
});

describe('digestCandidateFor', () => {
  const at = AFTERNOON;
  const paidAt = epochMsFromIso('2026-08-13T06:05:00Z');

  it('owes a defer recorded at or after the last spent window was decided', () => {
    const exactly = pair('z1', 'e', { lastDeferredAtIso: '2026-08-13T06:05:00.000Z' });
    expect(digestCandidateFor(exactly, 2, paidAt, at)).toMatchObject({
      kind: 'deferred',
      since: paidAt,
    });
    const earlier = pair('z1', 'e', { lastDeferredAtIso: '2026-08-13T06:04:59.999Z' });
    expect(digestCandidateFor(earlier, 2, paidAt, at).kind).toBe('active');
  });

  it('owes an unpaid seed, and prefers an unpaid defer over it', () => {
    const seeded = pair('z1', 'e', { seededAtIso: '2026-08-13T20:00:00.000Z' });
    expect(digestCandidateFor(seeded, 2, paidAt, at).kind).toBe('seeded');
    const both = pair('z1', 'e', {
      seededAtIso: '2026-08-13T20:00:00.000Z',
      lastDeferredAtIso: '2026-08-13T21:00:00.000Z',
    });
    expect(digestCandidateFor(both, 2, paidAt, at).kind).toBe('deferred');
  });

  it('treats everything as unpaid before the first spent window', () => {
    const old = pair('z1', 'e', { lastDeferredAtIso: '2026-08-01T00:00:00.000Z' });
    expect(digestCandidateFor(old, 2, null, at).kind).toBe('deferred');
  });

  it('dates an active fire from its seed, else its last notification, else now', () => {
    const noted = pair('z1', 'e');
    expect(digestCandidateFor(noted, 2, paidAt, at).since).toBe(
      epochMsFromIso('2026-08-13T10:00:00.000Z'),
    );
    const never = pair('z1', 'e', { lastNotifiedAtIso: null });
    expect(digestCandidateFor(never, 2, paidAt, at).since).toBe(at);
  });
});
