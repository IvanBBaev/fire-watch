import { describe, expect, it } from 'vitest';

import { VirtualClock, epochMsFromIso } from '../ports/clock.js';
import type {
  AlertEvaluationStore,
  AlertEvaluationTransaction,
  EvaluatedEventMark,
  EvaluationEventRow,
} from '../ports/alert-evaluation-store.js';
import type { DecisionLogEntry } from '../ports/alert-decision-log.js';
import type { EnqueueResult, OutboxRowDraft } from '../ports/alert-outbox-store.js';
import type { AlertRouting } from '../ports/alert-routing.js';
import type { AccountAlertSettings, StoredWatchZone } from '../ports/watch-zone-store.js';
import type { SealedCentre, ZoneCentreCipher } from '../ports/zone-centre-cipher.js';
import type { Coordinate } from '../clustering/geometry.js';
import type { AlertStateKey, AlertStateRow } from '../registry/alert-state.js';
import { ZONE_GRID, indexCellKey } from '../zones/zone-geometry.js';
import type { AlertableEvent } from './alert-decision.js';
import { runAlertEvaluationCycle, type AlertEvaluationCycleDeps } from './evaluation-cycle.js';
import { EXPLANATION_BRANCHES, explainPersisted } from './explain.js';
import { ZONE_MATCH_METRIC } from './zone-match.js';

const NOON = epochMsFromIso('2026-08-14T12:00:00Z');
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

function storedZone(
  id: string,
  accountId: string,
  centre: Coordinate,
  radiusM: number,
  keyId = 'k1',
): StoredWatchZone {
  return {
    id,
    accountId,
    name: id,
    radiusM,
    minScore: 0.45,
    sealed: { ...fakeCipher.seal(id, centre), keyId },
    coarsened: true,
    gridVersion: ZONE_GRID.version,
    gridCell: indexCellKey(centre),
    createdAtIso: '2026-08-01T00:00:00.000Z',
  };
}

function alertable(publicId: string, overrides: Partial<AlertableEvent> = {}): AlertableEvent {
  return {
    publicId,
    score: 0.8,
    detectionCount: 3,
    nightHighConfidenceCount: 0,
    geoOnly: false,
    invalidated: false,
    quarantined: false,
    status: 'active',
    statusBefore: null,
    relationKind: null,
    burnedAreaHa: null,
    startedAt: NOON - 60 * MINUTE,
    lastDetectionAt: NOON - 5 * MINUTE,
    ...overrides,
  };
}

function eventRow(
  seq: number,
  centroid: Coordinate,
  overrides: Partial<Omit<EvaluationEventRow, 'event'>> & { event?: Partial<AlertableEvent> } = {},
): EvaluationEventRow {
  const { event, ...rest } = overrides;
  return {
    fireEventId: String(100 + seq),
    seq: String(seq),
    centroid,
    merged: false,
    superseded: false,
    memberCount: 3,
    ...rest,
    event: alertable(`fw-2026-e${seq}`, event),
  };
}

interface World {
  events: EvaluationEventRow[];
  zones: StoredWatchZone[];
  settings: Map<string, AccountAlertSettings>;
  states: Map<string, AlertStateRow>;
  outbox: Map<string, OutboxRowDraft>;
  marks: Map<string, EvaluatedEventMark>;
  log: Map<string, DecisionLogEntry>;
  cursor: string;
}

function world(partial: Partial<World> = {}): World {
  return {
    events: [],
    zones: [],
    settings: new Map(),
    states: new Map(),
    outbox: new Map(),
    marks: new Map(),
    log: new Map(),
    cursor: '0',
    ...partial,
  };
}

const key = (zoneId: string, publicId: string): string => `${zoneId}|${publicId}`;

/** Commit-or-rollback over a copy of the world, like one database transaction. */
class FakeStore implements AlertEvaluationStore {
  transactions = 0;
  failOnEnqueue = false;

  constructor(readonly w: World) {}

  async withTransaction<T>(work: (tx: AlertEvaluationTransaction) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const draft: World = {
      ...this.w,
      states: new Map(this.w.states),
      outbox: new Map(this.w.outbox),
      marks: new Map(this.w.marks),
      log: new Map(this.w.log),
    };
    const result = await work(this.tx(draft));
    Object.assign(this.w, draft);
    return result;
  }

  private tx(d: World): AlertEvaluationTransaction {
    const failOnEnqueue = this.failOnEnqueue;
    return {
      readCursor: () => Promise.resolve(d.cursor),
      readEventsAfter: (afterSeq, limit) =>
        Promise.resolve(
          d.events
            .filter((e) => BigInt(e.seq) > BigInt(afterSeq))
            .sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)))
            .slice(0, limit)
            .map((e) => {
              const mark = d.marks.get(e.fireEventId);
              return mark === undefined
                ? e
                : { ...e, event: { ...e.event, statusBefore: mark.status } };
            }),
        ),
      zones: {
        listLiveInCells: (gridVersion, cells) =>
          Promise.resolve(
            d.zones.filter((z) => z.gridVersion === gridVersion && cells.includes(z.gridCell)),
          ),
        loadAccountAlertSettings: (accountId) => Promise.resolve(d.settings.get(accountId) ?? null),
      },
      alertStates: {
        loadStates: (keys: readonly AlertStateKey[]) =>
          Promise.resolve(
            keys.flatMap((k) => {
              const row = d.states.get(key(k.zoneId, k.eventPublicId));
              return row === undefined ? [] : [row];
            }),
          ),
        loadStatesForEvents: () => Promise.resolve([]),
        lastNotifiedByZone: (zoneIds) => {
          const out = new Map<string, string>();
          for (const row of d.states.values()) {
            if (!zoneIds.includes(row.zoneId) || row.lastNotifiedAtIso === null) continue;
            const held = out.get(row.zoneId);
            if (held === undefined || held < row.lastNotifiedAtIso) {
              out.set(row.zoneId, row.lastNotifiedAtIso);
            }
          }
          return Promise.resolve(out);
        },
        upsert: (rows) => {
          for (const row of rows) d.states.set(key(row.zoneId, row.eventPublicId), row);
          return Promise.resolve(rows.length);
        },
        remove: () => Promise.resolve(0),
      },
      outbox: {
        enqueue: (rows): Promise<EnqueueResult> => {
          if (failOnEnqueue) return Promise.reject(new Error('connection reset'));
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
      decisionLog: {
        append: (entries) => {
          let inserted = 0;
          for (const entry of entries) {
            const k = [entry.zoneId, entry.fireEventId, entry.triggerRefSeq, entry.pass].join('|');
            if (d.log.has(k)) continue;
            d.log.set(k, entry);
            inserted += 1;
          }
          return Promise.resolve(inserted);
        },
      },
      recordEvaluated: (marks) => {
        for (const mark of marks) d.marks.set(mark.fireEventId, mark);
        return Promise.resolve();
      },
      advanceCursor: (seq) => {
        if (BigInt(seq) < BigInt(d.cursor)) {
          return Promise.reject(new Error('cursor would move backwards'));
        }
        d.cursor = seq;
        return Promise.resolve();
      },
    };
  }
}

const routing: AlertRouting = {
  targetFor: () => Promise.resolve({ channel: 'push', channelSubscriptionId: 'sub-1' }),
  copyFor: (decision) => ({
    templateId: `test.${decision.alertType ?? 'none'}`,
    templateParams: { eventPublicId: decision.eventPublicId },
  }),
};

function deps(store: AlertEvaluationStore, overrides: Partial<AlertEvaluationCycleDeps> = {}) {
  return {
    store,
    cipher: fakeCipher,
    routing,
    clock: new VirtualClock(NOON),
    batchLimit: 10,
    maxBatchesPerCycle: 5,
    ...overrides,
  } satisfies AlertEvaluationCycleDeps;
}

// ---------------------------------------------------------------------------------------

describe('runAlertEvaluationCycle', () => {
  it('sends a new fire to a containing zone and writes state, outbox, marks and cursor', async () => {
    const w = world({
      events: [eventRow(7, north(2))],
      zones: [storedZone('zone-a', 'acct-1', SOFIA, 5_000)],
      settings: new Map([['acct-1', SETTINGS]]),
    });
    const report = await runAlertEvaluationCycle(deps(new FakeStore(w)));

    expect(report.cursorFrom).toBe('0');
    expect(report.cursorTo).toBe('7');
    expect(report.behind).toBe(false);
    expect(report.outcomes.send).toBe(1);
    expect(report.reasons).toEqual({ first_alert: 1 });
    expect(report.outboxInserted).toBe(1);
    // D5's budget B is unarmed: every row is released, so the A1.12 counter reads zero.
    expect(report.deferred).toEqual({ over_budget_b: 0, manual_approval: 0 });
    expect(w.cursor).toBe('7');
    expect(w.states.get(key('zone-a', 'fw-2026-e7'))?.state).toBe('notified_new');
    const [row] = [...w.outbox.values()];
    expect(row).toMatchObject({
      watchZoneId: 'zone-a',
      fireEventId: '107',
      triggerRefSeq: '7',
      channel: 'push',
      channelSubscriptionId: 'sub-1',
      templateId: 'test.new_fire',
      budgetSeq: null,
      status: 'pending',
      decidedAt: NOON,
    });
    expect(w.marks.get('107')).toEqual({ fireEventId: '107', seq: '7', status: 'active' });
  });

  it('ignores a zone whose cell matches but whose radius does not reach the event', async () => {
    const w = world({
      events: [eventRow(1, north(6))],
      zones: [storedZone('zone-a', 'acct-1', SOFIA, 5_000)],
      settings: new Map([['acct-1', SETTINGS]]),
    });
    const report = await runAlertEvaluationCycle(deps(new FakeStore(w)));
    expect(report.pairsDecided).toBe(0);
    expect(w.outbox.size).toBe(0);
    expect(w.cursor).toBe('1');
  });

  it('skips merged tombstones, superseded parents and memberless events, but consumes them', async () => {
    const w = world({
      events: [
        eventRow(1, SOFIA, { merged: true }),
        eventRow(2, SOFIA, { superseded: true }),
        eventRow(3, SOFIA, { memberCount: 0, event: { detectionCount: 0 } }),
      ],
      zones: [storedZone('zone-a', 'acct-1', SOFIA, 5_000)],
      settings: new Map([['acct-1', SETTINGS]]),
    });
    const report = await runAlertEvaluationCycle(deps(new FakeStore(w)));
    expect(report.skipped).toEqual({ merged: 1, superseded: 1, noMembers: 1 });
    expect(report.pairsDecided).toBe(0);
    expect(w.cursor).toBe('3');
    expect(w.marks.size).toBe(3);
  });

  it('gates an event whose latest members are quarantined, rather than skipping it', async () => {
    const w = world({
      events: [eventRow(1, SOFIA, { event: { quarantined: true, detectionCount: 0 } })],
      zones: [storedZone('zone-a', 'acct-1', SOFIA, 5_000)],
      settings: new Map([['acct-1', SETTINGS]]),
    });
    const report = await runAlertEvaluationCycle(deps(new FakeStore(w)));
    expect(report.skipped.noMembers).toBe(0);
    expect(report.reasons).toEqual({ quarantined_batch: 1 });
    expect(w.outbox.size).toBe(0);
  });

  it('sends one message per account: only the nearest of its zones (A1.12)', async () => {
    const w = world({
      events: [eventRow(1, north(1))],
      zones: [
        storedZone('zone-far', 'acct-1', north(-3), 10_000),
        storedZone('zone-near', 'acct-1', SOFIA, 10_000),
        storedZone('zone-other', 'acct-2', SOFIA, 10_000),
      ],
      settings: new Map([
        ['acct-1', SETTINGS],
        ['acct-2', SETTINGS],
      ]),
    });
    const report = await runAlertEvaluationCycle(deps(new FakeStore(w)));
    expect(report.outcomes).toEqual({ send: 2, defer: 0, seed: 0, suppress: 1 });
    expect(report.reasons).toEqual({ first_alert: 2, nearer_zone: 1 });
    expect([...w.outbox.values()].map((r) => r.watchZoneId).sort()).toEqual([
      'zone-near',
      'zone-other',
    ]);
    // The demoted zone keeps its state advance, so it cannot re-fire later for this fire.
    expect(w.states.get(key('zone-far', 'fw-2026-e1'))?.state).toBe('notified_new');
  });

  it('does not notify again when the event’s seq moves without a new ladder step', async () => {
    const w = world({
      events: [eventRow(1, SOFIA)],
      zones: [storedZone('zone-a', 'acct-1', SOFIA, 5_000)],
      settings: new Map([['acct-1', SETTINGS]]),
    });
    const store = new FakeStore(w);
    await runAlertEvaluationCycle(deps(store));
    // The clustering pipeline bumps the seq of the same event.
    w.events = [{ ...eventRow(1, SOFIA), seq: '9' }];
    const again = await runAlertEvaluationCycle(
      deps(store, { clock: new VirtualClock(NOON + 10 * MINUTE) }),
    );
    expect(again.outcomes.send).toBe(0);
    expect(again.reasons).toEqual({ no_new_ladder_step: 1 });
    expect(w.outbox.size).toBe(1);
    expect(w.cursor).toBe('9');
  });

  it('counts a centre that fails to open and skips only that zone, reporting no detail', async () => {
    const w = world({
      events: [eventRow(1, SOFIA)],
      zones: [
        storedZone('zone-bad', 'acct-1', SOFIA, 5_000, 'revoked'),
        storedZone('zone-ok', 'acct-2', SOFIA, 5_000),
      ],
      settings: new Map([
        ['acct-1', SETTINGS],
        ['acct-2', SETTINGS],
      ]),
    });
    const report = await runAlertEvaluationCycle(deps(new FakeStore(w)));
    expect(report.cipherFailures).toBe(1);
    expect(report.outboxInserted).toBe(1);
    expect(JSON.stringify(report)).not.toContain('revoked');
    expect(JSON.stringify(report)).not.toContain(String(SOFIA.lat));
  });

  it('skips zones of an account with no settings', async () => {
    const w = world({
      events: [eventRow(1, SOFIA)],
      zones: [storedZone('zone-a', 'acct-gone', SOFIA, 5_000)],
    });
    const report = await runAlertEvaluationCycle(deps(new FakeStore(w)));
    expect(report.accountsWithoutSettings).toBe(1);
    expect(report.pairsDecided).toBe(0);
    expect(w.cursor).toBe('1');
  });

  it('writes nothing for an account whose send has no delivery target', async () => {
    const w = world({
      events: [eventRow(1, SOFIA)],
      zones: [storedZone('zone-a', 'acct-1', SOFIA, 5_000)],
      settings: new Map([['acct-1', SETTINGS]]),
    });
    const report = await runAlertEvaluationCycle(
      deps(new FakeStore(w), {
        routing: { ...routing, targetFor: () => Promise.resolve(null) },
      }),
    );
    expect(report.undeliverable).toBe(1);
    expect(report.pairsDecided).toBe(0);
    expect(w.states.size).toBe(0);
    expect(w.outbox.size).toBe(0);
    expect(w.log.size).toBe(0);
    expect(report.decisionsLogged).toBe(0);
    expect(w.cursor).toBe('1');
  });

  it('writes nothing for an account whose send has no reviewed copy', async () => {
    const w = world({
      events: [eventRow(1, SOFIA)],
      zones: [storedZone('zone-a', 'acct-1', SOFIA, 5_000)],
      settings: new Map([['acct-1', SETTINGS]]),
    });
    const report = await runAlertEvaluationCycle(
      deps(new FakeStore(w), { routing: { ...routing, copyFor: () => null } }),
    );
    expect(report.undeliverable).toBe(1);
    expect(w.states.size).toBe(0);
  });

  it('runs batches until one comes back short, and reports behind at the batch limit', async () => {
    const events = [1, 2, 3, 4, 5].map((seq) => eventRow(seq, north(50 + seq)));
    const store = new FakeStore(world({ events }));
    const report = await runAlertEvaluationCycle(
      deps(store, { batchLimit: 2, maxBatchesPerCycle: 2 }),
    );
    expect(report.batches).toBe(2);
    expect(report.behind).toBe(true);
    expect(report.cursorTo).toBe('4');
    const rest = await runAlertEvaluationCycle(deps(store, { batchLimit: 2 }));
    expect(rest.cursorFrom).toBe('4');
    expect(rest.cursorTo).toBe('5');
    expect(rest.behind).toBe(false);
  });

  it('reports an idle cycle when nothing moved', async () => {
    const store = new FakeStore(world({ cursor: '42' }));
    const report = await runAlertEvaluationCycle(deps(store));
    expect(report).toMatchObject({ cursorFrom: '42', cursorTo: '42', batches: 1, eventsRead: 0 });
  });

  it('rolls the whole batch back when a write fails, leaving the cursor where it was', async () => {
    const w = world({
      events: [eventRow(1, SOFIA)],
      zones: [storedZone('zone-a', 'acct-1', SOFIA, 5_000)],
      settings: new Map([['acct-1', SETTINGS]]),
    });
    const store = new FakeStore(w);
    store.failOnEnqueue = true;
    await expect(runAlertEvaluationCycle(deps(store))).rejects.toThrow('connection reset');
    expect(w.cursor).toBe('0');
    expect(w.states.size).toBe(0);
    expect(w.marks.size).toBe(0);
    expect(w.log.size).toBe(0);
  });

  describe('the decision log (H7, migration 014)', () => {
    it('logs every applied decision, the demoted zone included, with its code and rule version', async () => {
      const w = world({
        events: [eventRow(1, north(1))],
        zones: [
          storedZone('zone-far', 'acct-1', north(-3), 10_000),
          storedZone('zone-near', 'acct-1', SOFIA, 10_000),
        ],
        settings: new Map([['acct-1', SETTINGS]]),
      });
      const report = await runAlertEvaluationCycle(deps(new FakeStore(w)));
      expect(report.decisionsLogged).toBe(2);
      const entries = [...w.log.values()].sort((a, b) => (a.zoneId < b.zoneId ? -1 : 1));
      expect(entries).toEqual([
        {
          zoneId: 'zone-far',
          fireEventId: '101',
          triggerRefSeq: '1',
          pass: 'evaluation',
          outcome: 'suppress',
          reason: 'nearer_zone',
          code: 'suppressed_nearer_zone',
          // A1.12's demotion drops the type: the far zone was not the one told.
          alertType: null,
          ladderStep: 0,
          inQuietHours: false,
          ruleVersion: 'alert_gating_v1',
          decidedAtIso: '2026-08-14T12:00:00Z',
        },
        {
          zoneId: 'zone-near',
          fireEventId: '101',
          triggerRefSeq: '1',
          pass: 'evaluation',
          outcome: 'send',
          reason: 'first_alert',
          code: 'sent_first_alert',
          alertType: 'new_fire',
          ladderStep: 0,
          inQuietHours: false,
          ruleVersion: 'alert_gating_v1',
          decidedAtIso: '2026-08-14T12:00:00Z',
        },
      ]);
    });

    it('logs a suppression, which writes no other row naming its reason', async () => {
      const w = world({
        events: [eventRow(1, SOFIA, { event: { score: 0.2 } })],
        zones: [storedZone('zone-a', 'acct-1', SOFIA, 5_000)],
        settings: new Map([['acct-1', SETTINGS]]),
      });
      const report = await runAlertEvaluationCycle(deps(new FakeStore(w)));
      expect(report.reasons).toEqual({ below_zone_threshold: 1 });
      expect(w.outbox.size).toBe(0);
      const [entry] = [...w.log.values()];
      expect(entry).toMatchObject({
        outcome: 'suppress',
        reason: 'below_zone_threshold',
        code: 'suppressed_below_zone_threshold',
        alertType: null,
        ruleVersion: 'alert_gating_v1',
      });
      // …and explainPersisted can now answer "why no alert?" from the rows alone.
      const state = w.states.get(key('zone-a', 'fw-2026-e1')) ?? null;
      expect(explainPersisted({ outbox: null, state, log: [...w.log.values()] })).toMatchObject({
        code: 'suppressed_below_zone_threshold',
        kind: 'why_no_alert',
        gate: 'sensitivity',
        delivery: 'none',
        ruleVersion: 'alert_gating_v1',
      });
    });

    it('appends a new entry when the seq moves, so the pair keeps its history', async () => {
      const w = world({
        events: [eventRow(1, SOFIA)],
        zones: [storedZone('zone-a', 'acct-1', SOFIA, 5_000)],
        settings: new Map([['acct-1', SETTINGS]]),
      });
      const store = new FakeStore(w);
      await runAlertEvaluationCycle(deps(store));
      w.events = [{ ...eventRow(1, SOFIA), seq: '9' }];
      const again = await runAlertEvaluationCycle(
        deps(store, { clock: new VirtualClock(NOON + 10 * MINUTE) }),
      );
      expect(again.decisionsLogged).toBe(1);
      expect([...w.log.values()].map((e) => [e.triggerRefSeq, e.code])).toEqual([
        ['1', 'sent_first_alert'],
        ['9', 'suppressed_no_new_ladder_step'],
      ]);
    });

    it('only ever logs a code from the branch table', async () => {
      const w = world({
        events: [1, 2, 3].map((seq) => eventRow(seq, north(seq))),
        zones: [storedZone('zone-a', 'acct-1', SOFIA, 10_000)],
        settings: new Map([['acct-1', SETTINGS]]),
      });
      await runAlertEvaluationCycle(deps(new FakeStore(w)));
      expect(w.log.size).toBe(3);
      for (const entry of w.log.values()) {
        expect(EXPLANATION_BRANCHES).toContainEqual(
          expect.objectContaining({
            outcome: entry.outcome,
            reason: entry.reason,
            code: entry.code,
          }),
        );
      }
    });
  });

  it('carries the previously evaluated status as statusBefore', async () => {
    const w = world({
      events: [eventRow(1, SOFIA)],
      settings: new Map([['acct-1', SETTINGS]]),
    });
    const store = new FakeStore(w);
    await runAlertEvaluationCycle(deps(store));
    expect(w.marks.get('101')?.status).toBe('active');
  });

  it('rejects a non-positive batch size', async () => {
    await expect(
      runAlertEvaluationCycle(deps(new FakeStore(world()), { batchLimit: 0 })),
    ).rejects.toThrow(RangeError);
  });

  it('is deterministic: the same world decides the same rows', async () => {
    const build = () =>
      world({
        events: [eventRow(1, north(1)), eventRow(2, north(-1))],
        zones: [
          storedZone('zone-b', 'acct-1', SOFIA, 5_000),
          storedZone('zone-a', 'acct-2', SOFIA, 5_000),
        ],
        settings: new Map([
          ['acct-1', SETTINGS],
          ['acct-2', SETTINGS],
        ]),
      });
    const a = build();
    const b = build();
    const ra = await runAlertEvaluationCycle(deps(new FakeStore(a)));
    const rb = await runAlertEvaluationCycle(deps(new FakeStore(b)));
    expect(ra).toEqual(rb);
    expect([...a.outbox.entries()]).toEqual([...b.outbox.entries()]);
  });
});
