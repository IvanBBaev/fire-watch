import type { ClientImageryBlock } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../ports/clock.js';
import type { ImageryMeterReading, ImageryMeterStore } from '../ports/imagery-meter-store.js';

import {
  ARCGIS_FREE_TIER_TILES_PER_PERIOD,
  type ImageryMeterConfig,
  createImageryMeter,
  decideImagery,
  isQuotaPeriod,
  quotaPeriodOf,
} from './imagery-meter.js';

const HANDLES: ClientImageryBlock = {
  tile_url_template: 'https://tiles.example.test/imagery/tile/{z}/{y}/{x}',
  api_key: 'AAPK-test',
};
const ARMED: ImageryMeterConfig = { handles: HANDLES, ceilingTiles: 1_500_000 };
const PERIOD = '2026-09';
const SEPT = '2026-09-23T10:00:00Z';

const reading = (overrides: Partial<ImageryMeterReading> = {}): ImageryMeterReading => ({
  killSwitch: false,
  override: false,
  tripped: false,
  usage: { period: PERIOD, tiles: 10 },
  ...overrides,
});

/** An in-memory store with the same latch semantics as the fs adapter. */
class MemoryStore implements ImageryMeterStore {
  killSwitch = false;
  overrides = new Set<string>();
  latches = new Map<string, { at: number; detail: string }>();
  usage: { period: string; tiles: number } | null = null;
  failWith: Error | null = null;
  reads = 0;

  read(period: string): Promise<ImageryMeterReading> {
    this.reads += 1;
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({
      killSwitch: this.killSwitch,
      override: this.overrides.has(period),
      tripped: this.latches.has(period),
      usage: this.usage,
    });
  }

  latchTrip(period: string, at: number, detail: string): Promise<void> {
    if (!this.latches.has(period)) this.latches.set(period, { at, detail });
    return Promise.resolve();
  }
}

describe('quotaPeriodOf', () => {
  it('names the UTC calendar month, rolling over at UTC midnight', () => {
    expect(quotaPeriodOf(Date.parse('2026-09-30T23:59:59.999Z'))).toBe('2026-09');
    expect(quotaPeriodOf(Date.parse('2026-10-01T00:00:00Z'))).toBe('2026-10');
    expect(quotaPeriodOf(Date.parse('2026-12-31T23:00:00Z'))).toBe('2026-12');
    expect(() => quotaPeriodOf(Number.NaN)).toThrow(RangeError);
  });

  it('produces exactly what isQuotaPeriod accepts', () => {
    expect(isQuotaPeriod(quotaPeriodOf(Date.parse(SEPT)))).toBe(true);
    expect(isQuotaPeriod('2026-13')).toBe(false);
    expect(isQuotaPeriod('2026-9')).toBe(false);
    expect(isQuotaPeriod(202609)).toBe(false);
  });
});

describe('decideImagery', () => {
  it('is on only with a key, an armed ceiling and a current reading under it', () => {
    expect(decideImagery(reading(), PERIOD, ARMED)).toEqual({
      state: 'enabled',
      period: PERIOD,
      trip: false,
      tiles: 10,
    });
  });

  it('is off without a key, and off while the ceiling is an open decision', () => {
    expect(decideImagery(reading(), PERIOD, { handles: null, ceilingTiles: 1 }).state).toBe(
      'no_key',
    );
    expect(decideImagery(reading(), PERIOD, { handles: HANDLES, ceilingTiles: null }).state).toBe(
      'unarmed',
    );
  });

  it('trips at the ceiling, not one tile later', () => {
    const at = decideImagery(
      reading({ usage: { period: PERIOD, tiles: 1_500_000 } }),
      PERIOD,
      ARMED,
    );
    expect(at).toMatchObject({ state: 'tripped', trip: true, tiles: 1_500_000 });
    const under = decideImagery(
      reading({ usage: { period: PERIOD, tiles: 1_499_999 } }),
      PERIOD,
      ARMED,
    );
    expect(under).toMatchObject({ state: 'enabled', trip: false });
  });

  it('stays off after a trip even when usage dips back under the ceiling (A2.3 hysteresis)', () => {
    const dipped = decideImagery(reading({ tripped: true }), PERIOD, ARMED);
    expect(dipped).toMatchObject({ state: 'tripped', trip: false });
  });

  it('treats a reading for another period as no reading, so it fails closed', () => {
    const stale = reading({ usage: { period: '2026-08', tiles: 10 } });
    expect(decideImagery(stale, PERIOD, ARMED)).toMatchObject({
      state: 'no_reading',
      tiles: null,
    });
    expect(decideImagery(reading({ usage: null }), PERIOD, ARMED).state).toBe('no_reading');
  });

  it('lets an ops override outrank the latch and a missing reading, but not the kill switch', () => {
    expect(decideImagery(reading({ override: true, tripped: true }), PERIOD, ARMED).state).toBe(
      'override',
    );
    expect(decideImagery(reading({ override: true, usage: null }), PERIOD, ARMED).state).toBe(
      'override',
    );
    expect(decideImagery(reading({ override: true, killSwitch: true }), PERIOD, ARMED).state).toBe(
      'kill_switch',
    );
  });
});

describe('createImageryMeter', () => {
  it('refuses a ceiling at or over the free tier, or not an integer', () => {
    const store = new MemoryStore();
    const clock = new VirtualClock(SEPT);
    for (const ceilingTiles of [0, 1.5, ARCGIS_FREE_TIER_TILES_PER_PERIOD]) {
      expect(() =>
        createImageryMeter({ clock, store, config: { handles: HANDLES, ceilingTiles } }),
      ).toThrow(RangeError);
    }
  });

  it('serves no block before the first evaluation', () => {
    const meter = createImageryMeter({
      clock: new VirtualClock(SEPT),
      store: new MemoryStore(),
      config: ARMED,
    });
    expect(meter.block()).toBeUndefined();
    expect(meter.state()).toBe('no_reading');
  });

  it('never touches the store while unconfigured or unarmed', async () => {
    const store = new MemoryStore();
    const clock = new VirtualClock(SEPT);
    const unarmed = createImageryMeter({
      clock,
      store,
      config: { handles: HANDLES, ceilingTiles: null },
    });
    expect(await unarmed.evaluate()).toMatchObject({ from: 'no_reading', to: 'unarmed' });
    const keyless = createImageryMeter({
      clock,
      store,
      config: { handles: null, ceilingTiles: null },
    });
    expect(await keyless.evaluate()).toBeNull();
    expect(keyless.block()).toBeUndefined();
    expect(store.reads).toBe(0);
  });

  it('removes the block on simulated quota exhaustion and latches it (the G6 done-when)', async () => {
    const store = new MemoryStore();
    const clock = new VirtualClock(SEPT);
    const meter = createImageryMeter({ clock, store, config: ARMED });

    store.usage = { period: PERIOD, tiles: 1_000 };
    expect(await meter.evaluate()).toMatchObject({ from: 'no_reading', to: 'enabled' });
    expect(meter.block()).toEqual(HANDLES);
    expect(await meter.evaluate()).toBeNull();

    store.usage = { period: PERIOD, tiles: 1_600_000 };
    const trip = await meter.evaluate();
    expect(trip).toMatchObject({ from: 'enabled', to: 'tripped', tripped: true, tiles: 1_600_000 });
    expect(meter.block()).toBeUndefined();
    expect(store.latches.get(PERIOD)).toEqual({
      at: clock.now(),
      detail: 'usage 1600000 >= ceiling 1500000',
    });

    // The meter corrects itself downwards: still off, and no second alarm.
    store.usage = { period: PERIOD, tiles: 5 };
    expect(await meter.evaluate()).toBeNull();
    expect(meter.block()).toBeUndefined();
  });

  it('re-enables at the next quota period once that period has a reading', async () => {
    const store = new MemoryStore();
    const clock = new VirtualClock('2026-09-30T23:30:00Z');
    const meter = createImageryMeter({ clock, store, config: ARMED });
    store.usage = { period: '2026-09', tiles: 1_999_999 };
    await meter.evaluate();
    expect(meter.state()).toBe('tripped');

    clock.advanceMs(60 * 60_000);
    // October with September's reading still on disk: blind, so still off.
    expect(await meter.evaluate()).toMatchObject({ from: 'tripped', to: 'no_reading' });
    expect(meter.block()).toBeUndefined();

    store.usage = { period: '2026-10', tiles: 0 };
    expect(await meter.evaluate()).toMatchObject({ to: 'enabled', period: '2026-10' });
    expect(meter.block()).toEqual(HANDLES);
  });

  it('re-enables within the period only by ops override', async () => {
    const store = new MemoryStore();
    const meter = createImageryMeter({ clock: new VirtualClock(SEPT), store, config: ARMED });
    store.usage = { period: PERIOD, tiles: 1_500_000 };
    await meter.evaluate();
    expect(meter.block()).toBeUndefined();

    store.overrides.add(PERIOD);
    expect(await meter.evaluate()).toMatchObject({ from: 'tripped', to: 'override' });
    expect(meter.block()).toEqual(HANDLES);
  });

  it('fails closed on a store error and says why', async () => {
    const store = new MemoryStore();
    const meter = createImageryMeter({ clock: new VirtualClock(SEPT), store, config: ARMED });
    store.usage = { period: PERIOD, tiles: 1 };
    await meter.evaluate();
    expect(meter.block()).toEqual(HANDLES);

    store.failWith = new Error('EACCES: permission denied');
    const failed = await meter.evaluate();
    expect(failed).toMatchObject({
      from: 'enabled',
      to: 'store_error',
      detail: 'EACCES: permission denied',
    });
    expect(meter.block()).toBeUndefined();
  });

  it('runs one evaluation at a time', async () => {
    const store = new MemoryStore();
    store.usage = { period: PERIOD, tiles: 1 };
    const meter = createImageryMeter({ clock: new VirtualClock(SEPT), store, config: ARMED });
    const [a, b] = await Promise.all([meter.evaluate(), meter.evaluate()]);
    expect(a).toBe(b);
    expect(store.reads).toBe(1);
  });
});
