import { describe, expect, it } from 'vitest';

import type { AlertableEvent } from '../alerts/alert-decision.js';
import type { Coordinate } from '../clustering/geometry.js';
import { epochMsFromIso } from '../ports/clock.js';
import type {
  AccountAlertSettings,
  NewWatchZone,
  StoredWatchZone,
  WatchZoneStore,
} from '../ports/watch-zone-store.js';
import type { SealedCentre, ZoneCentreCipher } from '../ports/zone-centre-cipher.js';
import type { DecisionLogEntry } from '../ports/alert-decision-log.js';
import type {
  ZoneSeedCandidateReader,
  ZoneSeedCandidateRow,
} from '../ports/zone-seed-candidate-reader.js';
import type { AlertStateRow } from '../registry/alert-state.js';
import {
  createWatchZone,
  listOwnedWatchZones,
  ZoneRequestError,
  type CreateWatchZoneDeps,
  type CreateWatchZoneRequest,
} from './create-watch-zone.js';
import { coarsenCentre } from './zone-geometry.js';

const ACCOUNT = '33333333-0000-4000-8000-000000000001';
const ZONE = '33333333-0000-4000-8000-0000000000aa';
/** 08:20 in Sofia on 20 Aug 2026: outside quiet hours, so nothing but A1.8 is in play. */
const AT = epochMsFromIso('2026-08-20T05:20:00Z');
const HOUR = 3_600_000;
const CLICK: Coordinate = { lat: 42.69751, lon: 23.32415 };

const SETTINGS: AccountAlertSettings = {
  timezone: 'Europe/Sofia',
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  newFireOverridesQuietHours: true,
};

/**
 * A transparent stand-in for the cipher: it records what it was asked to seal, which is
 * exactly the value this suite is about. The real cipher's no-plaintext property is proven
 * in `adapters/crypto` and, end to end, in `adapters/db/pg-zone-creation.test.ts`.
 */
function recordingCipher(): ZoneCentreCipher & { readonly sealedCentres: Coordinate[] } {
  const sealedCentres: Coordinate[] = [];
  const byZone = new Map<string, Coordinate>();
  return {
    sealedCentres,
    seal(zoneId, centre): SealedCentre {
      sealedCentres.push(centre);
      byZone.set(zoneId, centre);
      return { ciphertext: new Uint8Array(44), keyId: 'test' };
    },
    open(zoneId): Coordinate {
      const centre = byZone.get(zoneId);
      if (centre === undefined) throw new Error('not sealed');
      return centre;
    },
  };
}

interface Harness {
  readonly deps: CreateWatchZoneDeps;
  readonly cipher: ReturnType<typeof recordingCipher>;
  readonly inserted: NewWatchZone[];
  readonly upserts: AlertStateRow[][];
  readonly candidateCalls: { centre: Coordinate; radiusM: number }[];
  readonly logged: DecisionLogEntry[][];
  readonly log: string[];
}

function harness(
  options: {
    readonly settings?: AccountAlertSettings | null;
    readonly candidates?: readonly ZoneSeedCandidateRow[];
  } = {},
): Harness {
  const cipher = recordingCipher();
  const inserted: NewWatchZone[] = [];
  const upserts: AlertStateRow[][] = [];
  const candidateCalls: { centre: Coordinate; radiusM: number }[] = [];
  const logged: DecisionLogEntry[][] = [];
  const log: string[] = [];
  const zones: WatchZoneStore = {
    loadAccountAlertSettings() {
      log.push('settings');
      return Promise.resolve(options.settings === undefined ? SETTINGS : options.settings);
    },
    insert(zone) {
      log.push('insert');
      inserted.push(zone);
      return Promise.resolve();
    },
    listForAccount() {
      return Promise.resolve(inserted.map(storedFrom));
    },
    listLiveInCells() {
      return Promise.resolve([]);
    },
  };
  const candidates: ZoneSeedCandidateReader = {
    candidatesWithin(centre, radiusM) {
      log.push('candidates');
      candidateCalls.push({ centre, radiusM });
      return Promise.resolve(options.candidates ?? []);
    },
  };
  return {
    cipher,
    inserted,
    upserts,
    candidateCalls,
    logged,
    log,
    deps: {
      cipher,
      zones,
      candidates,
      alertStates: {
        upsert(rows) {
          log.push('upsert');
          upserts.push([...rows]);
          return Promise.resolve(rows.length);
        },
      },
      decisionLog: {
        append(entries) {
          log.push('decision_log');
          logged.push([...entries]);
          return Promise.resolve(entries.length);
        },
      },
      newZoneId: () => ZONE,
    },
  };
}

function storedFrom(zone: NewWatchZone): StoredWatchZone {
  return {
    id: zone.id,
    accountId: zone.accountId,
    name: zone.name,
    radiusM: zone.radiusM,
    minScore: zone.minScore,
    sealed: zone.sealed,
    coarsened: zone.coarsened,
    gridVersion: zone.gridVersion,
    gridCell: zone.gridCell,
    createdAtIso: zone.createdAtIso,
  };
}

function request(overrides: Partial<CreateWatchZoneRequest> = {}): CreateWatchZoneRequest {
  return { accountId: ACCOUNT, name: 'Home', centre: CLICK, ...overrides };
}

function burningEvent(publicId: string, score = 0.8): AlertableEvent {
  return {
    publicId,
    score,
    detectionCount: 3,
    nightHighConfidenceCount: 0,
    geoOnly: false,
    invalidated: false,
    quarantined: false,
    status: 'active',
    statusBefore: null,
    relationKind: null,
    burnedAreaHa: null,
    startedAt: AT - 48 * HOUR,
    lastDetectionAt: AT - HOUR,
  };
}

describe('what is sealed and stored', () => {
  it('seals the ~1 km coarsened centre by default, never the click', async () => {
    const h = harness();
    const created = await createWatchZone(request(), AT, h.deps);
    expect(h.cipher.sealedCentres).toEqual([coarsenCentre(CLICK)]);
    expect(h.cipher.sealedCentres[0]).not.toEqual(CLICK);
    expect(created.storedCentre).toEqual({ lat: 42.695, lon: 23.325 });
    expect(h.inserted[0]?.coarsened).toBe(true);
  });

  it('seals the click itself only when the user turned coarsening off', async () => {
    const h = harness();
    await createWatchZone(request({ coarsen: false }), AT, h.deps);
    expect(h.cipher.sealedCentres).toEqual([CLICK]);
    expect(h.inserted[0]?.coarsened).toBe(false);
  });

  it('writes the index cell of the stored centre, under the grid version', async () => {
    const h = harness();
    await createWatchZone(request(), AT, h.deps);
    expect(h.inserted[0]).toMatchObject({
      id: ZONE,
      gridVersion: 'zone_grid_v1',
      gridCell: '853:466',
      createdAtIso: '2026-08-20T05:20:00Z',
    });
  });

  it('defaults to a 10 km radius and the Likely floor', async () => {
    const h = harness();
    await createWatchZone(request(), AT, h.deps);
    expect(h.inserted[0]).toMatchObject({ radiusM: 10_000, minScore: 0.45 });
  });

  it('accepts exactly the three published floors', async () => {
    for (const minScore of [0.75, 0.45, 0.3]) {
      const h = harness();
      await createWatchZone(request({ minScore }), AT, h.deps);
      expect(h.inserted[0]?.minScore).toBe(minScore);
    }
  });
});

describe('A1.8 seeding, in the same unit of work', () => {
  it('asks for candidates around the stored centre, with the stored radius', async () => {
    const h = harness();
    await createWatchZone(request({ radiusM: 5000 }), AT, h.deps);
    expect(h.candidateCalls).toEqual([{ centre: coarsenCentre(CLICK), radiusM: 5000 }]);
  });

  it('seeds a pre-existing alertable fire at notified_new, silently, after the zone row', async () => {
    const h = harness({ candidates: [row(burningEvent('fw-2026-a1b2c'), 3)] });
    const created = await createWatchZone(request(), AT, h.deps);
    expect(h.log).toEqual(['settings', 'insert', 'candidates', 'upsert', 'decision_log']);
    expect(h.upserts).toEqual([
      [
        {
          zoneId: ZONE,
          eventPublicId: 'fw-2026-a1b2c',
          state: 'notified_new',
          escalationWatermark: 0,
          seededAtIso: '2026-08-20T05:20:00Z',
          lastNotifiedAtIso: null,
        },
      ],
    ]);
    expect(created.seed.onboarding).toEqual([
      { zoneId: ZONE, eventPublicId: 'fw-2026-a1b2c', distanceKm: 3 },
    ]);
  });

  it('seeds against the zone floor it just stored, and reports what it skipped', async () => {
    const h = harness({
      candidates: [row(burningEvent('fw-2026-lowsc', 0.5), 2)],
    });
    const created = await createWatchZone(request({ minScore: 0.75 }), AT, h.deps);
    expect(h.upserts).toEqual([]);
    expect(h.log).toEqual(['settings', 'insert', 'candidates', 'decision_log']);
    expect(created.seed.skipped).toEqual([
      { eventPublicId: 'fw-2026-lowsc', reason: 'below_zone_threshold' },
    ]);
  });

  it('writes no alert states at all when nothing intersects', async () => {
    const h = harness();
    await createWatchZone(request(), AT, h.deps);
    expect(h.upserts).toEqual([]);
    expect(h.logged).toEqual([]);
    expect(h.log).toEqual(['settings', 'insert', 'candidates']);
  });
});

describe('H7 — the seed pass is logged with pass zone_creation', () => {
  it('logs every candidate, seeded or skipped, keyed on the event id and the seq read', async () => {
    const h = harness({
      candidates: [
        row(burningEvent('fw-2026-lowsc', 0.5), 2, '11', '4'),
        row(burningEvent('fw-2026-a1b2c'), 3, '10', '9'),
      ],
    });
    await createWatchZone(request({ minScore: 0.75 }), AT, h.deps);
    expect(h.logged).toEqual([
      [
        {
          zoneId: ZONE,
          fireEventId: '10',
          triggerRefSeq: '9',
          pass: 'zone_creation',
          outcome: 'seed',
          reason: 'pre_existing_event',
          code: expect.any(String) as string,
          alertType: null,
          ladderStep: 0,
          inQuietHours: false,
          ruleVersion: 'alert_gating_v1',
          decidedAtIso: '2026-08-20T05:20:00Z',
        },
        {
          zoneId: ZONE,
          fireEventId: '11',
          triggerRefSeq: '4',
          pass: 'zone_creation',
          outcome: 'suppress',
          reason: 'below_zone_threshold',
          code: expect.any(String) as string,
          alertType: null,
          ladderStep: 0,
          inQuietHours: false,
          ruleVersion: 'alert_gating_v1',
          decidedAtIso: '2026-08-20T05:20:00Z',
        },
      ],
    ]);
  });

  it('puts no coordinate or distance into the log entries', async () => {
    const h = harness({ candidates: [row(burningEvent('fw-2026-a1b2c'), 3.14159)] });
    await createWatchZone(request(), AT, h.deps);
    const text = JSON.stringify(h.logged);
    const stored = coarsenCentre(CLICK);
    for (const value of [CLICK.lat, CLICK.lon, stored.lat, stored.lon, 3.14159]) {
      expect(text).not.toContain(String(value));
    }
    for (const entry of h.logged.flat()) {
      expect(Object.values(entry).every((v) => typeof v !== 'number' || Number.isInteger(v))).toBe(
        true,
      );
    }
  });

  it('rolls nothing into the log when the seed cannot be written', async () => {
    const h = harness({ candidates: [row(burningEvent('fw-2026-a1b2c'), 3)] });
    const failing: CreateWatchZoneDeps = {
      ...h.deps,
      alertStates: { upsert: () => Promise.reject(new Error('boom')) },
    };
    await expect(createWatchZone(request(), AT, failing)).rejects.toThrow('boom');
    expect(h.logged).toEqual([]);
  });
});

function row(
  event: AlertableEvent,
  distanceKm: number,
  fireEventId = '1',
  seq = '1',
): ZoneSeedCandidateRow {
  return { event, distanceKm, fireEventId, seq };
}

describe('refusals', () => {
  const cases: readonly [string, Partial<CreateWatchZoneRequest>, string][] = [
    ['an empty name', { name: '   ' }, 'invalid_name'],
    ['an over-long name', { name: 'x'.repeat(101) }, 'invalid_name'],
    ['a radius under A1.10’s 2 km', { radiusM: 1999 }, 'invalid_radius'],
    ['a radius over 30 km', { radiusM: 30_001 }, 'invalid_radius'],
    ['a floor below Early signals', { minScore: 0.2 }, 'invalid_min_score'],
    ['a floor that is not published', { minScore: 0.5 }, 'invalid_min_score'],
    ['a non-finite centre', { centre: { lat: Number.NaN, lon: 23 } }, 'invalid_centre'],
    ['a centre off the globe', { centre: { lat: 91, lon: 23 } }, 'invalid_centre'],
    ['a centre outside the alertable area', { centre: { lat: 51.5, lon: -0.12 } }, 'outside_area'],
  ];

  for (const [label, overrides, code] of cases) {
    it(`refuses ${label} before touching any store`, async () => {
      const h = harness();
      const failure = await createWatchZone(request(overrides), AT, h.deps).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ZoneRequestError);
      expect((failure as ZoneRequestError).code).toBe(code);
      expect(h.log).toEqual([]);
      expect(h.cipher.sealedCentres).toEqual([]);
    });
  }

  it('refuses a deleted or missing account before sealing or writing anything', async () => {
    const h = harness({ settings: null });
    await expect(createWatchZone(request(), AT, h.deps)).rejects.toMatchObject({
      code: 'account_unavailable',
    });
    expect(h.inserted).toEqual([]);
    expect(h.cipher.sealedCentres).toEqual([]);
  });

  it('never echoes the coordinate it refused', async () => {
    const h = harness();
    const failure = await createWatchZone(
      request({ centre: { lat: 51.50735, lon: -0.12776 } }),
      AT,
      h.deps,
    ).catch((error: unknown) => error);
    expect(String(failure)).not.toMatch(/51\.5|0\.127/);
  });
});

describe('listing for the owner', () => {
  it('opens each zone to the stored centre, not the click', async () => {
    const h = harness();
    await createWatchZone(request(), AT, h.deps);
    const zones = await listOwnedWatchZones(ACCOUNT, h.deps);
    expect(zones).toEqual([
      {
        zoneId: ZONE,
        name: 'Home',
        radiusM: 10_000,
        minScore: 0.45,
        coarsened: true,
        storedCentre: { lat: 42.695, lon: 23.325 },
        createdAtIso: '2026-08-20T05:20:00Z',
      },
    ]);
  });
});
