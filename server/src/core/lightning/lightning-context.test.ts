import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import { LIGHTNING_CONTEXT } from '../config/lightning-context.js';
import { VirtualClock, isoFromEpochMs } from '../ports/clock.js';
import type {
  LightningContextCandidate,
  LightningContextRow,
  LightningContextStore,
} from '../ports/lightning-context-store.js';
import type { PayloadReader } from '../ports/payload-reader.js';
import {
  coverage,
  evaluateLightningContext,
  greatCircleKm,
  runLightningContextPass,
} from './lightning-context.js';
import {
  LIGHTNING_CURRENT_PATH,
  emptyDocument,
  type LightningDocument,
  type LightningDocumentFlash,
  type LightningProductEntry,
} from './lightning-document.js';

// Synthetic fixtures only: no real LI product is read here.
const MIN = 60_000;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const FIRE = { lat: 42.7, lon: 23.3 };

function event(firstDetectedMinutesAgo: number, id = '7'): LightningContextCandidate {
  return { eventId: id, ...FIRE, firstDetectedAt: NOW - firstDetectedMinutesAgo * MIN };
}

/** A 10-minute product ending `endMinutesAgo` before NOW. */
function product(
  endMinutesAgo: number,
  flashes: LightningDocumentFlash[] = [],
): LightningProductEntry {
  const end = NOW - endMinutesAgo * MIN;
  return {
    id: `p${String(endMinutesAgo)}`,
    start: isoFromEpochMs(end - 10 * MIN),
    end: isoFromEpochMs(end),
    published_at: isoFromEpochMs(end + MIN),
    available_at: isoFromEpochMs(end + 2 * MIN),
    kept: flashes.length,
    filtered_out: 0,
    unrated: 0,
    flashes,
  };
}

/** Products covering [NOW - fromMinutesAgo, NOW - toMinutesAgo], minus any `holes`. */
function doc(fromMinutesAgo: number, toMinutesAgo = 0, holes: number[] = []): LightningDocument {
  const products: LightningProductEntry[] = [];
  for (let end = fromMinutesAgo - 10; end >= toMinutesAgo; end -= 10) {
    if (!holes.includes(end)) products.push(product(end));
  }
  return { ...emptyDocument(NOW), products: products.reverse() };
}

function flash(minutesAgo: number, dLatDeg = 0): LightningDocumentFlash {
  return { t: isoFromEpochMs(NOW - minutesAgo * MIN), lat: FIRE.lat + dLatDeg, lon: FIRE.lon };
}

function withFlashes(
  d: LightningDocument,
  at: number,
  flashes: LightningDocumentFlash[],
): LightningDocument {
  return {
    ...d,
    products: d.products.map((p) =>
      Date.parse(p.end) === NOW - at * MIN ? { ...p, kept: flashes.length, flashes } : p,
    ),
  };
}

describe('greatCircleKm', () => {
  it('measures a degree of latitude as about 111 km', () => {
    expect(greatCircleKm({ lat: 42, lon: 23 }, { lat: 43, lon: 23 })).toBeCloseTo(111.2, 0);
    expect(greatCircleKm(FIRE, FIRE)).toBe(0);
  });
});

describe('coverage', () => {
  it('joins abutting products and splits at a missing one', () => {
    const spans = coverage(doc(60, 0, [30]), 60_000);
    expect(spans).toHaveLength(2);
  });
});

describe('evaluateLightningContext', () => {
  it('counts flashes inside the radius and the window, and keeps the nearest', () => {
    // First detection 60 min ago: window is [240, 60] minutes ago.
    let d = doc(300);
    d = withFlashes(d, 100, [flash(105, 0.05), flash(104, 0.5)]); // ~5.6 km, ~56 km
    d = withFlashes(d, 50, [flash(55)]); // after the first detection
    d = withFlashes(d, 250, [flash(255)]); // before the window
    const row = evaluateLightningContext(event(60), d, NOW);
    expect(row).toMatchObject({
      status: 'complete',
      flashCount: 1,
      nearestKm: 5.6,
      radiusKm: 10,
      paramsVersion: LIGHTNING_CONTEXT.version,
      filterVersion: d.filter_version,
      windowFrom: NOW - 240 * MIN,
      windowTo: NOW - 60 * MIN,
    });
  });

  it('says zero flashes only when the whole window is covered', () => {
    expect(evaluateLightningContext(event(60), doc(300), NOW)).toMatchObject({
      status: 'complete',
      flashCount: 0,
      nearestKm: null,
    });
  });

  it('waits on a hole while the window is still inside retention', () => {
    expect(evaluateLightningContext(event(60), doc(300, 0, [120]), NOW)).toBeNull();
    expect(evaluateLightningContext(event(60), null, NOW)).toBeNull();
  });

  it('waits when the first detection is newer than the coverage', () => {
    expect(evaluateLightningContext(event(5), doc(300, 20), NOW)).toBeNull();
  });

  it('says unavailable, never zero, once the window has left retention uncovered', () => {
    const old = event(7 * 60); // window starts 10 h ago; the document keeps 9 h
    const row = evaluateLightningContext(old, doc(300), NOW);
    expect(row).toMatchObject({ status: 'unavailable', flashCount: null, nearestKm: null });
    expect(evaluateLightningContext(old, null, NOW)).toMatchObject({
      status: 'unavailable',
      filterVersion: 'none',
    });
  });

  it('follows the versioned parameters', () => {
    const wide = defineConfig('lightning_context', 'lightning_context_v9', {
      ...LIGHTNING_CONTEXT.values,
      radiusKm: 60,
    });
    const d = withFlashes(doc(300), 100, [flash(105, 0.05), flash(104, 0.5)]);
    expect(evaluateLightningContext(event(60), d, NOW, wide)).toMatchObject({
      flashCount: 2,
      radiusKm: 60,
      paramsVersion: 'lightning_context_v9',
    });
  });
});

class MemoryStore implements LightningContextStore {
  saved: LightningContextRow[] = [];
  asked: [string, number][] = [];
  constructor(private readonly events: LightningContextCandidate[]) {}
  pendingEvents(paramsVersion: string, limit: number): Promise<LightningContextCandidate[]> {
    this.asked.push([paramsVersion, limit]);
    return Promise.resolve(this.events);
  }
  save(rows: readonly LightningContextRow[]): Promise<void> {
    this.saved.push(...rows);
    return Promise.resolve();
  }
}

function reader(text: string | null | Error): PayloadReader {
  return {
    readText: (path: string) => {
      expect(path).toBe(LIGHTNING_CURRENT_PATH);
      return text instanceof Error ? Promise.reject(text) : Promise.resolve(text);
    },
  } as PayloadReader;
}

describe('runLightningContextPass', () => {
  const clock = new VirtualClock(NOW);

  it('saves what can be answered and leaves the rest pending', async () => {
    const store = new MemoryStore([event(60, 'a'), event(5, 'b'), event(7 * 60, 'c')]);
    const report = await runLightningContextPass({
      store,
      reader: reader(JSON.stringify(doc(300, 20))),
      clock,
    });
    expect(report).toEqual({ pending: 3, complete: 1, unavailable: 1, waiting: 1, error: null });
    expect(store.saved.map((r) => [r.eventId, r.status])).toEqual([
      ['a', 'complete'],
      ['c', 'unavailable'],
    ]);
    expect(store.asked).toEqual([[LIGHTNING_CONTEXT.version, LIGHTNING_CONTEXT.values.batchSize]]);
  });

  it('does not turn an unreadable document into unavailable rows', async () => {
    const store = new MemoryStore([event(7 * 60)]);
    const report = await runLightningContextPass({
      store,
      reader: reader(new Error('EIO')),
      clock,
    });
    expect(report.error).toBe('document unreadable: EIO');
    expect(store.saved).toEqual([]);
  });

  it('reports a store failure instead of throwing', async () => {
    const store = new MemoryStore([]);
    store.pendingEvents = () => Promise.reject(new Error('db down'));
    const report = await runLightningContextPass({ store, reader: reader(null), clock });
    expect(report.error).toBe('db down');
  });
});
