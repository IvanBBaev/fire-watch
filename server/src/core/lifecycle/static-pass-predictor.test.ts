import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { POLLING_BBOX } from '../config/polling-bbox.js';
import { CONFIG_VERSION_RE, configDigest, defineConfig } from '../config/versioned-config.js';
import { epochMsFromIso, isoFromEpochMs } from '../ports/clock.js';
import type { ExpectedPass } from '../ports/pass-predictor.js';
import {
  assuredDailyLooks,
  kmPerDegreeLon,
  MAX_WINDOW_DAYS,
  PASS_TABLE,
  retirementInstantMs,
  staticPassPredictor,
  validate,
  type PassTable,
  type PolarSourceModel,
} from './static-pass-predictor.js';

/** Bulgaria's rough centre, and the point every pinned instant below is stated for. */
const CENTRE = { lat: 42.7, lon: 25.0 };

const MODIS_RETIRED_FROM = epochMsFromIso('2026-08-02T00:00:00Z');

function at(iso: string): number {
  return epochMsFromIso(iso);
}

/** `source@HH:MM phase`, which is what a failing pass list should read like. */
function render(passes: readonly ExpectedPass[]): readonly string[] {
  return passes.map(
    (pass) => `${pass.source}@${isoFromEpochMs(pass.atMs).slice(11, 16)} ${pass.phase}`,
  );
}

/** A table with the real metric and area but a caller-chosen constellation. */
function tableOf(sources: readonly PolarSourceModel[]): PassTable {
  return validate({
    modelledArea: POLLING_BBOX.values,
    metric: PASS_TABLE.values.metric,
    sources,
  });
}

function sourceModel(overrides: Partial<PolarSourceModel>): PolarSourceModel {
  return {
    source: 'firms:viirs:snpp',
    passes: [
      { phase: 'day', localSolarHour: 12.0 },
      { phase: 'night', localSolarHour: 0.0 },
    ],
    effectiveSwathKm: 3060,
    trackSpacingDegLon: 25.35,
    deliveryLagMinutesFrom: 60,
    deliveryLagMinutesTo: 180,
    ...overrides,
  };
}

function predictorOf(sources: readonly PolarSourceModel[]) {
  return staticPassPredictor(defineConfig('pass_table', 'pass_table_v0', tableOf(sources)));
}

describe('pass_table_v0', () => {
  it('carries a version the fixture validator will accept', () => {
    expect(PASS_TABLE.version).toMatch(CONFIG_VERSION_RE);
    expect(staticPassPredictor().tableVersion).toBe('pass_table_v0');
  });

  it('pins the digest, because the version alone is on every miss-evidence row we store', () => {
    expect(PASS_TABLE.digest).toBe(configDigest(PASS_TABLE.values));
    expect(PASS_TABLE.digest).toBe('2d897327');
  });

  it('measures on the identity engine plane, and cannot drift away from it', () => {
    const metric = CLUSTERING_PARAMS.values.metric;
    expect(PASS_TABLE.values.metric).toEqual({
      referenceLatDeg: metric.referenceLatDeg,
      kmPerDegreeLonAtReference: metric.kmPerDegreeLonAtReference,
      kmPerDegreeLonPerDegreeLat: metric.kmPerDegreeLonPerDegreeLat,
    });
  });

  it('models exactly the area we poll — no more, so the linear metric stays valid', () => {
    expect(PASS_TABLE.values.modelledArea).toEqual(POLLING_BBOX.values);
  });

  it('models every polar source in the registry and no geostationary one', () => {
    expect(PASS_TABLE.values.sources.map((source) => source.source)).toEqual([
      'firms:viirs:noaa20',
      'firms:viirs:snpp',
      'firms:viirs:noaa21',
      'firms:modis',
      'eumetsat:slstr:frp',
    ]);
  });
});

describe('pass table validation', () => {
  it('refuses a geostationary source, which the accumulator would then count twice', () => {
    expect(() => tableOf([sourceModel({ source: 'lsasaf:seviri:frp-pixel' })])).toThrow(
      /geostationary/,
    );
  });

  it('refuses a source that models only one half of the day', () => {
    expect(() =>
      tableOf([sourceModel({ passes: [{ phase: 'day', localSolarHour: 12.0 }] })]),
    ).toThrow(/day and a night/);
  });

  it('refuses a duplicated source', () => {
    expect(() => tableOf([sourceModel({}), sourceModel({})])).toThrow(/twice/);
  });

  it('refuses a local solar hour outside the day', () => {
    expect(() =>
      tableOf([
        sourceModel({
          passes: [
            { phase: 'day', localSolarHour: 24.0 },
            { phase: 'night', localSolarHour: 0.0 },
          ],
        }),
      ]),
    ).toThrow(/local solar hour/);
  });

  it('refuses a delivery lag band that is empty or runs backwards', () => {
    expect(() =>
      tableOf([sourceModel({ deliveryLagMinutesFrom: 180, deliveryLagMinutesTo: 60 })]),
    ).toThrow(/delivery lag/);
  });
});

describe('expectedPasses', () => {
  const predictor = staticPassPredictor();

  it('lays out a full UTC day over Bulgaria, sorted by (atMs, source)', () => {
    const passes = predictor.expectedPasses(
      CENTRE,
      at('2026-07-01T00:00:00Z'),
      at('2026-07-02T00:00:00Z'),
    );
    expect(render(passes)).toEqual([
      'firms:viirs:snpp@00:18 night',
      'firms:modis@00:22 night',
      'firms:viirs:noaa21@01:09 night',
      'eumetsat:slstr:frp@08:52 day',
      'firms:modis@09:22 day',
      'firms:viirs:noaa20@10:22 day',
      'firms:viirs:snpp@11:13 day',
      'firms:modis@11:18 day',
      'firms:viirs:noaa21@12:03 day',
      'eumetsat:slstr:frp@19:48 night',
      'firms:modis@20:18 night',
      'firms:viirs:noaa20@23:27 night',
    ]);
  });

  it('gives every VIIRS source both a day and a night look over a full day', () => {
    const passes = predictor.expectedPasses(
      CENTRE,
      at('2026-07-01T00:00:00Z'),
      at('2026-07-02T00:00:00Z'),
    );
    for (const source of ['firms:viirs:snpp', 'firms:viirs:noaa20', 'firms:viirs:noaa21']) {
      const phases = passes.filter((pass) => pass.source === source).map((pass) => pass.phase);
      expect(phases.slice().sort()).toEqual(['day', 'night']);
    }
  });

  it('is half-open: a pass exactly at fromMs is in, one exactly at toMs is out', () => {
    const snppNight = at('2026-07-01T00:18:00Z');
    const modisNight = at('2026-07-01T00:22:00Z');

    // Both edges in one window: the pass at `fromMs` is in, the pass at `toMs` is not.
    const halfOpen = predictor.expectedPasses(CENTRE, snppNight, modisNight);
    expect(render(halfOpen)).toEqual(['firms:viirs:snpp@00:18 night']);

    const upToTheInstant = predictor.expectedPasses(CENTRE, at('2026-07-01T00:00:00Z'), snppNight);
    expect(upToTheInstant).toEqual([]);
  });

  it('returns nothing for an empty interval and refuses a reversed one', () => {
    const instant = at('2026-07-01T00:00:00Z');
    expect(predictor.expectedPasses(CENTRE, instant, instant)).toEqual([]);
    expect(() => predictor.expectedPasses(CENTRE, instant, instant - 1)).toThrow(
      /ends before it starts/,
    );
  });

  it('answers identically when asked twice — the accumulator sums floats in this order', () => {
    const first = predictor.expectedPasses(
      CENTRE,
      at('2026-07-01T00:00:00Z'),
      at('2026-07-04T00:00:00Z'),
    );
    const second = predictor.expectedPasses(
      CENTRE,
      at('2026-07-01T00:00:00Z'),
      at('2026-07-04T00:00:00Z'),
    );
    expect(second).toEqual(first);
  });

  it('breaks a tie on source id, not on the order the table happens to list them in', () => {
    // Two sources at the same nominal instant, listed noaa21-first in the table.
    const shared = [
      { phase: 'day', localSolarHour: 12.0 },
      { phase: 'night', localSolarHour: 0.0 },
    ] as const;
    const tied = predictorOf([
      sourceModel({ source: 'firms:viirs:noaa21', passes: shared }),
      sourceModel({ source: 'firms:viirs:noaa20', passes: shared }),
    ]);
    const passes = tied.expectedPasses(
      CENTRE,
      at('2026-07-01T00:00:00Z'),
      at('2026-07-02T00:00:00Z'),
    );
    expect(passes.map((pass) => `${pass.source}@${pass.atMs}`)).toEqual([
      `firms:viirs:noaa20@${at('2026-07-01T10:20:00Z')}`,
      `firms:viirs:noaa21@${at('2026-07-01T10:20:00Z')}`,
      `firms:viirs:noaa20@${at('2026-07-01T22:20:00Z')}`,
      `firms:viirs:noaa21@${at('2026-07-01T22:20:00Z')}`,
    ]);
  });

  it('shifts the overpass four minutes per degree of longitude', () => {
    const west = predictor
      .expectedPasses(
        { lat: 42.7, lon: 20.0 },
        at('2026-07-01T00:00:00Z'),
        at('2026-07-02T00:00:00Z'),
      )
      .filter((pass) => pass.source === 'firms:viirs:snpp' && pass.phase === 'day');
    const east = predictor
      .expectedPasses(
        { lat: 42.7, lon: 31.0 },
        at('2026-07-01T00:00:00Z'),
        at('2026-07-02T00:00:00Z'),
      )
      .filter((pass) => pass.source === 'firms:viirs:snpp' && pass.phase === 'day');
    expect(west).toHaveLength(1);
    expect(east).toHaveLength(1);
    // 11° of longitude is 44 minutes, and the eastern point is looked at first.
    expect((west[0]?.atMs ?? 0) - (east[0]?.atMs ?? 0)).toBe(44 * 60_000);
  });

  it('says nothing at all outside the area the table was fitted for', () => {
    const outside = predictor.expectedPasses(
      { lat: 52.0, lon: 13.4 },
      at('2026-07-01T00:00:00Z'),
      at('2026-07-02T00:00:00Z'),
    );
    expect(outside).toEqual([]);
  });

  it('refuses a non-finite instant or coordinate rather than enumerating nonsense', () => {
    expect(() => predictor.expectedPasses(CENTRE, Number.NaN, at('2026-07-02T00:00:00Z'))).toThrow(
      /finite epoch millisecond/,
    );
    expect(() =>
      predictor.expectedPasses(
        { lat: Number.POSITIVE_INFINITY, lon: 25 },
        at('2026-07-01T00:00:00Z'),
        at('2026-07-02T00:00:00Z'),
      ),
    ).toThrow(/finite coordinate/);
  });

  it('refuses a window too wide to be anything but a caller bug', () => {
    const start = at('2026-07-01T00:00:00Z');
    const dayMs = 86_400_000;
    expect(() =>
      predictor.expectedPasses(CENTRE, start, start + (MAX_WINDOW_DAYS + 2) * dayMs),
    ).toThrow(/exceeds the/);
  });

  it('drops a source whose swath cannot reach every longitude at this latitude', () => {
    // 400 km against a 25.35° track spacing is well under one assured look a day.
    const narrow = predictorOf([sourceModel({ effectiveSwathKm: 400 })]);
    expect(
      narrow.expectedPasses(CENTRE, at('2026-07-01T00:00:00Z'), at('2026-07-02T00:00:00Z')),
    ).toEqual([]);
    expect(narrow.nextWindow(CENTRE, at('2026-07-01T00:00:00Z'))).toBeNull();
  });
});

describe('A2.3(2) retirement', () => {
  const predictor = staticPassPredictor();
  const fullDay = (from: string, to: string): readonly string[] =>
    render(predictor.expectedPasses(CENTRE, at(from), at(to))).filter((entry) =>
      entry.startsWith('firms:modis@'),
    );

  it('reads the effective date off the registry, and only for retired sources', () => {
    expect(retirementInstantMs('firms:modis')).toBe(MODIS_RETIRED_FROM);
    expect(retirementInstantMs('firms:viirs:snpp')).toBeNull();
  });

  it('keeps MODIS in a window that lies entirely before the retirement', () => {
    expect(fullDay('2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')).toEqual([
      'firms:modis@00:22 night',
      'firms:modis@09:22 day',
      'firms:modis@11:18 day',
      'firms:modis@20:18 night',
    ]);
  });

  it('drops MODIS from a window that lies entirely after it', () => {
    expect(fullDay('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')).toEqual([]);
  });

  it('keeps only the earlier passes of a window that straddles the retirement', () => {
    const straddling = predictor.expectedPasses(
      CENTRE,
      at('2026-08-01T00:00:00Z'),
      at('2026-08-03T00:00:00Z'),
    );
    const modis = straddling.filter((pass) => pass.source === 'firms:modis');
    expect(modis).toHaveLength(4);
    for (const pass of modis) {
      expect(pass.atMs).toBeLessThan(MODIS_RETIRED_FROM);
    }
    // The rest of the constellation is unaffected — this is a retirement, not an outage.
    expect(straddling.filter((pass) => pass.source === 'firms:viirs:snpp')).toHaveLength(4);
  });

  it('does not read an active source effective date as a start, which would erase backfill', () => {
    const beforeTheFreeze = predictor.expectedPasses(
      CENTRE,
      at('2025-07-01T00:00:00Z'),
      at('2025-07-02T00:00:00Z'),
    );
    expect(beforeTheFreeze).toHaveLength(12);
  });
});

describe('nextWindow', () => {
  const predictor = staticPassPredictor();

  // MODIS' 09:22 day pass over the centre, plus the documented 1–3 h FIRMS delivery lag.
  const IN_FLIGHT = { fromMs: at('2026-07-01T10:22:00Z'), toMs: at('2026-07-01T12:22:00Z') };

  it('answers with a delivery in flight, not the overpass after it', () => {
    // 12:00 sits strictly inside the MODIS window: it opened at 10:22 and data may still
    // land until 12:22. GLOSSARY §3b makes that the honest answer — the chip promises when
    // the *user* may know more. The next window to *open* is S-NPP's 12:13–14:13, and
    // answering with that would tell the user to wait for data that may arrive in minutes.
    const fromMs = at('2026-07-01T12:00:00Z');
    const window = predictor.nextWindow(CENTRE, fromMs);
    expect(window).toEqual(IN_FLIGHT);
    expect(window?.fromMs ?? 0).toBeLessThan(fromMs);
    expect(window?.toMs ?? 0).toBeGreaterThan(fromMs);
  });

  it('drops a window at the instant it elapses, and not a millisecond earlier', () => {
    const lastMoment = predictor.nextWindow(CENTRE, IN_FLIGHT.toMs - 1);
    expect(lastMoment).toEqual(IN_FLIGHT);

    // Exactly at `toMs` the promise has come due; the next unelapsed one is NOAA-20's,
    // which is itself still in flight (its 10:22 pass is due 11:22–13:22).
    const elapsed = predictor.nextWindow(CENTRE, IN_FLIGHT.toMs);
    expect(elapsed).toEqual({
      fromMs: at('2026-07-01T11:22:00Z'),
      toMs: at('2026-07-01T13:22:00Z'),
    });
  });

  it('still returns a window that has not opened when nothing is in flight', () => {
    // 06:00 sits in the morning gap: the last night delivery elapsed at 04:09 and the
    // first day one is SLSTR's 08:52 pass, due 09:52–11:52. Nothing is in flight, so the
    // answer is a window that has not opened — the in-flight rule widens the candidate
    // set, it does not bias it towards the past.
    const fromMs = at('2026-07-01T06:00:00Z');
    const window = predictor.nextWindow(CENTRE, fromMs);
    expect(window).toEqual({
      fromMs: at('2026-07-01T09:52:00Z'),
      toMs: at('2026-07-01T11:52:00Z'),
    });
    expect(window?.fromMs ?? 0).toBeGreaterThan(fromMs);
  });

  it('never returns an empty or backwards window', () => {
    for (const hour of [0, 3, 7, 12, 18, 23]) {
      const stamp = `2026-07-01T${String(hour).padStart(2, '0')}:00:00Z`;
      const window = predictor.nextWindow(CENTRE, at(stamp));
      expect(window).not.toBeNull();
      expect(window?.toMs ?? 0).toBeGreaterThan(window?.fromMs ?? 0);
      expect(window?.toMs ?? 0).toBeGreaterThan(at(stamp));
    }
  });

  it('is null outside the modelled area — an unknown chip, never a guessed range', () => {
    expect(predictor.nextWindow({ lat: 52.0, lon: 13.4 }, at('2026-07-01T12:00:00Z'))).toBeNull();
  });

  it('is null once the only modelled source has retired', () => {
    const modisOnly = predictorOf([
      sourceModel({
        source: 'firms:modis',
        effectiveSwathKm: 2330,
        trackSpacingDegLon: 24.72,
      }),
    ]);
    expect(modisOnly.nextWindow(CENTRE, at('2026-07-01T12:00:00Z'))).not.toBeNull();
    expect(modisOnly.nextWindow(CENTRE, at('2026-09-01T12:00:00Z'))).toBeNull();
  });

  it('refuses a non-finite instant', () => {
    expect(() => predictor.nextWindow(CENTRE, Number.NaN)).toThrow(/finite epoch millisecond/);
  });
});

describe('coverage', () => {
  it('gives a fixed swath more assured looks the further north the point is', () => {
    const metric = PASS_TABLE.values.metric;
    const viirs = PASS_TABLE.values.sources.find((source) => source.source === 'firms:viirs:snpp');
    expect(viirs).toBeDefined();
    if (viirs === undefined) return;
    const south = assuredDailyLooks(viirs, 39.0, metric);
    const north = assuredDailyLooks(viirs, 46.0, metric);
    expect(south).toBeGreaterThan(1);
    expect(north).toBeGreaterThan(south);
    // The excess over 1 is the adjacent-orbit second look the model deliberately floors
    // away; if a refit ever pushed it past 2 the floor would be hiding a whole pass.
    expect(north).toBeLessThan(2);
  });

  it('every modelled source assuredly covers the whole polled box', () => {
    const { metric, modelledArea, sources } = PASS_TABLE.values;
    for (const source of sources) {
      for (const lat of [modelledArea.south, modelledArea.north]) {
        expect(assuredDailyLooks(source, lat, metric)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('shortens the longitudinal degree northward', () => {
    const metric = PASS_TABLE.values.metric;
    expect(kmPerDegreeLon(metric.referenceLatDeg, metric)).toBe(metric.kmPerDegreeLonAtReference);
    expect(kmPerDegreeLon(46.0, metric)).toBeLessThan(kmPerDegreeLon(39.0, metric));
  });
});
