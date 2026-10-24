/**
 * V2-B1 per-point FWI forecast: the GWIS answer parser over real recorded bodies, the
 * class mapping, the query, and the cache/single-flight/budget service.
 */

import { describe, expect, it } from 'vitest';

import { POLLING_BBOX } from '../config/polling-bbox.js';
import { VirtualClock } from '../ports/clock.js';
import type { FwiPointClient, FwiPointRequest } from '../ports/fwi-point-client.js';
import { GFI_BEYOND_HORIZON, GFI_BLACK_SEA, GFI_SOFIA } from './__fixtures__/gwis-gfi.js';
import {
  createFwiForecastService,
  fwiDangerClass,
  gwisPointQuery,
  lookupFwiForecast,
  parseGwisFeatureInfo,
  parseSnappedPoint,
  pointInBox,
} from './fwi-point.js';

const SOFIA = { latTenths: 427, lonTenths: 233 };

describe('parseGwisFeatureInfo (recorded GWIS answers)', () => {
  it('reads the FWI row of a land point', () => {
    expect(parseGwisFeatureInfo(GFI_SOFIA)).toEqual({
      kind: 'value',
      fwi: 1.4407467,
    });
  });

  it('reads a sea point too — GWIS answers over water', () => {
    expect(parseGwisFeatureInfo(GFI_BLACK_SEA)).toEqual({
      kind: 'value',
      fwi: 0.43938288,
    });
  });

  it('reads the empty 200 past the horizon as no data', () => {
    expect(parseGwisFeatureInfo(GFI_BEYOND_HORIZON)).toEqual({ kind: 'no-data' });
  });

  it('refuses a changed page, a negative and an absurd value', () => {
    expect(parseGwisFeatureInfo('<html>Service unavailable</html>').kind).toBe('unparseable');
    expect(parseGwisFeatureInfo('<td>Fire Weather Index (FWI)</td><td>-3</td>').kind).toBe(
      'unparseable',
    );
    expect(parseGwisFeatureInfo('<td>Fire Weather Index (FWI)</td><td>9999</td>').kind).toBe(
      'unparseable',
    );
  });
});

describe('fwiDangerClass', () => {
  it('uses the EFFIS legend bounds, a bound belonging to the class above', () => {
    expect(fwiDangerClass(0)).toBe('very-low');
    expect(fwiDangerClass(11.19)).toBe('very-low');
    expect(fwiDangerClass(11.2)).toBe('low');
    expect(fwiDangerClass(21.3)).toBe('moderate');
    expect(fwiDangerClass(38)).toBe('high');
    expect(fwiDangerClass(50)).toBe('very-high');
    expect(fwiDangerClass(70)).toBe('extreme');
    expect(fwiDangerClass(140)).toBe('extreme');
  });
});

describe('parseSnappedPoint and pointInBox', () => {
  it('accepts only the one-decimal form', () => {
    expect(parseSnappedPoint('42.7', '23.3')).toEqual(SOFIA);
    expect(parseSnappedPoint('42.71', '23.3')).toBeNull();
    expect(parseSnappedPoint('42', '23.3')).toBeNull();
    expect(parseSnappedPoint('4e1', '23.3')).toBeNull();
    expect(parseSnappedPoint('95.0', '23.3')).toBeNull();
  });

  it('answers only inside the served box', () => {
    expect(pointInBox(SOFIA, POLLING_BBOX.values)).toBe(true);
    expect(pointInBox({ latTenths: 485, lonTenths: 23 }, POLLING_BBOX.values)).toBe(false);
  });
});

describe('gwisPointQuery', () => {
  it('asks for the centre pixel of a 0.2° latitude-first box, on the given day', () => {
    expect(gwisPointQuery(SOFIA, '2026-10-25')).toEqual({
      SERVICE: 'WMS',
      VERSION: '1.3.0',
      REQUEST: 'GetFeatureInfo',
      LAYERS: 'ecmwf.query',
      QUERY_LAYERS: 'ecmwf.query',
      STYLES: '',
      CRS: 'EPSG:4326',
      BBOX: '42.6,23.2,42.8,23.4',
      WIDTH: '101',
      HEIGHT: '101',
      I: '50',
      J: '50',
      INFO_FORMAT: 'text/html',
      TIME: '2026-10-25',
    });
  });
});

/** Answers the Sofia fixture for days up to `horizon` and the empty body after. */
function fakeClient(options: { horizon?: string; fail?: boolean } = {}): FwiPointClient & {
  readonly calls: FwiPointRequest[];
} {
  const calls: FwiPointRequest[] = [];
  return {
    calls,
    fetchPoint(request) {
      calls.push(request);
      if (options.fail === true) return Promise.resolve({ body: null, error: 'down' });
      const time = request.query['TIME'] ?? '';
      const body = options.horizon !== undefined && time > options.horizon ? '' : GFI_SOFIA;
      return Promise.resolve({ body, error: null });
    },
  };
}

describe('lookupFwiForecast', () => {
  it('asks for D0 … D9 by UTC date and relays each value with its class', async () => {
    const client = fakeClient({ horizon: '2026-11-01' });
    const clock = new VirtualClock('2026-10-24T23:30:00Z');
    const lookup = await lookupFwiForecast(client, clock, SOFIA);
    expect(client.calls.map((call) => call.query['TIME'])).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.body.lat).toBe(42.7);
    expect(lookup.body.lon).toBe(23.3);
    expect(lookup.body.base_date).toBe('2026-10-24');
    expect(lookup.body.days[0]).toEqual({
      date: '2026-10-24',
      lead_days: 0,
      fwi: 1.4,
      danger_class: 'very-low',
    });
    expect(lookup.body.days[9]).toEqual({
      date: '2026-11-02',
      lead_days: 9,
      fwi: null,
      danger_class: null,
    });
  });

  it('is a failure, never an empty forecast, when GWIS does not answer', async () => {
    const lookup = await lookupFwiForecast(
      fakeClient({ fail: true }),
      new VirtualClock('2026-10-24T10:00:00Z'),
      SOFIA,
    );
    expect(lookup).toEqual({ ok: false, reason: 'upstream_failed' });
  });
});

describe('createFwiForecastService', () => {
  it('caches a point, shares an in-flight lookup and spends the budget once per miss', async () => {
    const client = fakeClient();
    const clock = new VirtualClock('2026-10-24T10:00:00Z');
    const service = createFwiForecastService({ client, clock, upstreamBudget: 2 });
    const [a, b] = await Promise.all([service.lookup(SOFIA), service.lookup(SOFIA)]);
    expect(a).toBe(b);
    expect(client.calls).toHaveLength(10);
    await service.lookup(SOFIA);
    expect(client.calls).toHaveLength(10);

    await service.lookup({ latTenths: 420, lonTenths: 250 });
    expect(client.calls).toHaveLength(20);
    expect(await service.lookup({ latTenths: 430, lonTenths: 260 })).toEqual({
      ok: false,
      reason: 'budget_exhausted',
    });
  });

  it('never carries an answer past its UTC day', async () => {
    const client = fakeClient();
    const clock = new VirtualClock('2026-10-24T23:50:00Z');
    const service = createFwiForecastService({ client, clock });
    await service.lookup(SOFIA);
    clock.advanceMs(20 * 60_000);
    const next = await service.lookup(SOFIA);
    expect(client.calls).toHaveLength(20);
    expect(next.ok && next.body.base_date).toBe('2026-10-25');
  });
});
