import { describe, expect, it } from 'vitest';

import { LIGHTNING_CONTEXT, LIGHTNING_CONTEXT_DRIFT } from '../config/lightning-context.js';
import { MemoryPayloads } from '../passes/__fixtures__/memory-payloads.js';
import { VirtualClock, isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type {
  LightningContextCandidate,
  LightningContextPrevious,
  LightningContextRow,
  LightningContextStore,
} from '../ports/lightning-context-store.js';
import type { LightningProduct, LightningSearch } from '../ports/lightning-client.js';
import { FakeClient, FakeDecoder } from './__fixtures__/fake-lightning.js';
import {
  backfillCutoff,
  backfillReason,
  runLightningContextBackfill,
} from './lightning-context-backfill.js';
import { recordPath } from './lightning-document.js';

// Synthetic fixtures only: the fake decoder puts one flash at 42.5, 23.5 in the middle of
// every product window; no real LI product is read here.
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const FIRST = NOW - 20 * HOUR;
const AT_THE_FLASHES = { lat: 42.5, lon: 23.5 };
const V = LIGHTNING_CONTEXT.version;

function event(
  id: string,
  firstDetectedAt: EpochMs = FIRST,
  previous: LightningContextPrevious | null = null,
): LightningContextCandidate {
  return { eventId: id, ...AT_THE_FLASHES, firstDetectedAt, previous };
}

function product(end: EpochMs): LightningProduct {
  return {
    id: `LFL-${isoFromEpochMs(end)}`,
    window: { startIso: isoFromEpochMs(end - 10 * MIN), endIso: isoFromEpochMs(end) },
    publishedAtIso: isoFromEpochMs(end + MIN),
    md5: null,
    bodyName: `LFL-${isoFromEpochMs(end)}-BODY.nc`,
  };
}

/** The archive: every 10-minute product overlapping the asked window, minus `holes` (ends). */
function archive(holes: readonly EpochMs[] = []) {
  return (window: { startIso: string; endIso: string }): LightningSearch => {
    const from = Date.parse(window.startIso);
    const to = Date.parse(window.endIso);
    const products: LightningProduct[] = [];
    for (let end = Math.ceil(from / (10 * MIN)) * 10 * MIN + 10 * MIN; end - 10 * MIN < to;) {
      if (!holes.includes(end)) products.push(product(end));
      end += 10 * MIN;
    }
    return { ok: true, products };
  };
}

class MemoryStore implements LightningContextStore {
  saved: LightningContextRow[] = [];
  asked: unknown[][] = [];
  failSave = false;
  constructor(public events: LightningContextCandidate[]) {}
  pendingEvents(): Promise<LightningContextCandidate[]> {
    return Promise.reject(new Error('the backfill never asks for the loop list'));
  }
  incompleteEvents(...args: unknown[]): Promise<LightningContextCandidate[]> {
    this.asked.push(args);
    return Promise.resolve(this.events);
  }
  save(rows: readonly LightningContextRow[]): Promise<void> {
    if (this.failSave) return Promise.reject(new Error('db down'));
    this.saved.push(...rows);
    return Promise.resolve();
  }
}

function harness(events: LightningContextCandidate[]) {
  const clock = new VirtualClock(NOW);
  const client = new FakeClient(clock);
  client.searchBy = archive();
  const decoder = new FakeDecoder();
  const payloads = new MemoryPayloads();
  const store = new MemoryStore(events);
  const deps = { store, client, decoder, payloads, reader: payloads, clock };
  return { clock, client, decoder, payloads, store, deps };
}

const LIMITS = { maxEvents: 10, maxProducts: 100 };

describe('backfillReason', () => {
  const settled = {
    status: 'complete' as const,
    paramsVersion: V,
    windowTo: FIRST,
    ...AT_THE_FLASHES,
  };

  it('takes what the loop would recompute, plus an unavailable row', () => {
    expect(backfillReason(event('a'), V)).toBe('missing');
    expect(backfillReason(event('a', FIRST, { ...settled, paramsVersion: 'old' }), V)).toBe(
      'params',
    );
    expect(backfillReason(event('a', FIRST, { ...settled, lat: 42.6 }), V)).toBe('moved');
    expect(backfillReason(event('a', FIRST, { ...settled, status: 'unavailable' }), V)).toBe(
      'unavailable',
    );
  });

  it('leaves a complete row that still holds alone', () => {
    expect(backfillReason(event('a', FIRST, settled), V)).toBeNull();
  });
});

describe('backfillCutoff', () => {
  it('hands the backfill only events whose window the nine-hour document cannot hold', () => {
    expect(backfillCutoff(NOW)).toBe(NOW - 6 * HOUR);
  });
});

describe('runLightningContextBackfill', () => {
  it('fetches the archived window, counts it, and writes a complete row', async () => {
    const { client, payloads, store, deps } = harness([event('a')]);
    const report = await runLightningContextBackfill(deps, LIMITS);

    expect(store.asked).toEqual([[V, NOW - 6 * HOUR, 10, LIGHTNING_CONTEXT_DRIFT]]);
    expect(client.searches).toEqual([
      {
        startIso: isoFromEpochMs(FIRST - 3 * HOUR - 10 * MIN),
        endIso: isoFromEpochMs(FIRST + 10 * MIN),
      },
    ]);
    // 18 ten-minute products cover three hours; the edge products outside it are not fetched.
    expect(client.downloads).toHaveLength(18);
    expect(payloads.text(recordPath(FIRST, product(FIRST).id))).toBeDefined();
    expect(report).toMatchObject({ listed: 1, downloads: 18, stopped: null, error: null });
    expect(report.events).toEqual([
      {
        eventId: 'a',
        reason: 'missing',
        windowFrom: isoFromEpochMs(FIRST - 3 * HOUR),
        windowTo: isoFromEpochMs(FIRST),
        outcome: 'complete',
        found: 18,
        reused: 0,
        downloaded: 18,
        notAttempted: 0,
        missing: [],
        flashCount: 18,
        nearestKm: 0,
        errors: [],
      },
    ]);
    expect(store.saved).toEqual([
      {
        eventId: 'a',
        status: 'complete',
        windowFrom: FIRST - 3 * HOUR,
        windowTo: FIRST,
        radiusKm: 10,
        ...AT_THE_FLASHES,
        flashCount: 18,
        nearestKm: 0,
        paramsVersion: V,
        filterVersion: 'lightning_filter_v1',
        computedAt: NOW,
      },
    ]);
  });

  it('is idempotent: a second run reuses the records and downloads nothing', async () => {
    const { client, store, deps } = harness([event('a')]);
    await runLightningContextBackfill(deps, LIMITS);
    client.downloads = [];
    const second = await runLightningContextBackfill(deps, LIMITS);
    expect(client.downloads).toEqual([]);
    expect(second.events[0]).toMatchObject({ outcome: 'complete', reused: 18, downloaded: 0 });
    expect(store.saved[1]).toEqual(store.saved[0]);
  });

  it('skips a listed event whose complete row still holds', async () => {
    const settled = {
      status: 'complete' as const,
      paramsVersion: V,
      windowTo: FIRST,
      ...AT_THE_FLASHES,
    };
    const { client, store, deps } = harness([event('a', FIRST, settled)]);
    const report = await runLightningContextBackfill(deps, LIMITS);
    expect(report).toMatchObject({ listed: 1, events: [] });
    expect(client.searches).toEqual([]);
    expect(store.saved).toEqual([]);
  });

  it('writes nothing for a window the archive covers only in part, and says which part', async () => {
    const hole = FIRST - HOUR;
    const { client, store, deps } = harness([event('a')]);
    client.searchBy = archive([hole]);
    const report = await runLightningContextBackfill(deps, LIMITS);
    expect(report.events[0]).toMatchObject({
      outcome: 'partial',
      found: 17,
      flashCount: null,
      missing: [`${isoFromEpochMs(hole - 10 * MIN)}/${isoFromEpochMs(hole)}`],
    });
    expect(store.saved).toEqual([]);
  });

  it('says not covered when the archive lists nothing for the window', async () => {
    const { client, store, deps } = harness([event('a')]);
    client.searchBy = () => ({ ok: true, products: [] });
    const report = await runLightningContextBackfill(deps, LIMITS);
    expect(report.events[0]).toMatchObject({
      outcome: 'not_covered',
      missing: [`${isoFromEpochMs(FIRST - 3 * HOUR)}/${isoFromEpochMs(FIRST)}`],
    });
    expect(store.saved).toEqual([]);
  });

  it('stops at the product budget and finishes the window on a later run', async () => {
    const { client, store, deps } = harness([event('a'), event('b', FIRST - 24 * HOUR)]);
    const first = await runLightningContextBackfill(deps, { maxEvents: 10, maxProducts: 5 });
    expect(client.downloads).toHaveLength(5);
    expect(first.events.map((e) => [e.eventId, e.outcome, e.downloaded, e.notAttempted])).toEqual([
      ['a', 'budget_exhausted', 5, 13],
      ['b', 'budget_exhausted', 0, 18],
    ]);
    expect(store.saved).toEqual([]);

    store.events = [event('a')];
    const second = await runLightningContextBackfill(deps, LIMITS);
    expect(second.events[0]).toMatchObject({ outcome: 'complete', reused: 5, downloaded: 13 });
  });

  it('stops downloading after an authentication refusal and writes nothing it lacks', async () => {
    const { client, store, deps } = harness([event('a'), event('b', FIRST - 24 * HOUR)]);
    client.failDownload.set(product(FIRST - 170 * MIN).id, {
      ok: false,
      status: 401,
      error: 'invalid token',
    });
    const report = await runLightningContextBackfill(deps, LIMITS);
    expect(client.downloads).toHaveLength(1);
    expect(report.stopped).toBe('stopped after an authentication refusal');
    expect(report.events.map((e) => e.outcome)).toEqual(['failed', 'budget_exhausted']);
    expect(report.events[0]?.errors[0]).toContain('invalid token');
    expect(store.saved).toEqual([]);
  });

  it('treats a product the decoder refuses as a hole, not as zero flashes', async () => {
    const { decoder, store, deps } = harness([event('a')]);
    decoder.answers.set(product(FIRST).bodyName, {
      outcome: 'refused',
      payload: null,
      error: 'not netCDF-4',
    });
    const report = await runLightningContextBackfill(deps, LIMITS);
    expect(report.events[0]).toMatchObject({
      outcome: 'partial',
      missing: [`${isoFromEpochMs(FIRST - 10 * MIN)}/${isoFromEpochMs(FIRST)}`],
    });
    expect(report.events[0]?.errors[0]).toContain('refused');
    expect(store.saved).toEqual([]);
  });

  it('reports a failed search per event and goes on', async () => {
    const { client, deps } = harness([event('a')]);
    client.searchBy = () => ({ ok: false, status: 503, error: 'unavailable' });
    const report = await runLightningContextBackfill(deps, LIMITS);
    expect(report.events[0]).toMatchObject({
      outcome: 'search_failed',
      errors: ['search: HTTP 503: unavailable'],
    });
    expect(report.error).toBeNull();
  });

  it('reports a store failure instead of throwing', async () => {
    const { store, deps } = harness([event('a')]);
    store.failSave = true;
    const report = await runLightningContextBackfill(deps, LIMITS);
    expect(report.error).toBe('store: db down');
    expect(report.events[0]?.outcome).toBe('failed');
    store.incompleteEvents = () => Promise.reject(new Error('gone'));
    expect((await runLightningContextBackfill(deps, LIMITS)).error).toBe('store: gone');
  });

  it('refuses nonsensical limits', async () => {
    const { deps } = harness([]);
    await expect(
      runLightningContextBackfill(deps, { maxEvents: 0, maxProducts: 1 }),
    ).rejects.toThrow(RangeError);
    await expect(
      runLightningContextBackfill(deps, { maxEvents: 1, maxProducts: -1 }),
    ).rejects.toThrow(RangeError);
  });
});
