import { describe, expect, it } from 'vitest';

import { MemoryFeedStatus } from '../passes/__fixtures__/memory-feed-status.js';
import { MemoryPayloads } from '../passes/__fixtures__/memory-payloads.js';
import { VirtualClock, isoFromEpochMs } from '../ports/clock.js';
import type { DecodeResult } from '../ports/granule-decoder.js';
import type {
  LightningClient,
  LightningDownload,
  LightningProduct,
  LightningSearch,
} from '../ports/lightning-client.js';
import type { LightningDecoder, LightningGranuleRef } from '../ports/lightning-decoder.js';
import {
  LIGHTNING_CURRENT_META_PATH,
  LIGHTNING_CURRENT_PATH,
  documentFlashes,
  parseLightningDocument,
  recordMetaPath,
  recordPath,
} from './lightning-document.js';
import { LIGHTNING_PAYLOAD_FORMAT } from './lightning-payload.js';
import {
  MAX_DOWNLOADS_PER_CYCLE,
  lightningRefreshFailed,
  runLightningRefresh,
} from './lightning-refresh.js';

const NOW = Date.UTC(2026, 8, 30, 12, 40);
const MIN = 60_000;

/** A product whose window ends `endMinutesAgo` before NOW (on the real :09 offset). */
function product(id: string, endMinutesAgo: number, publishedLagMs = 40_000): LightningProduct {
  const end = NOW - endMinutesAgo * MIN + 9_000;
  return {
    id,
    window: { startIso: isoFromEpochMs(end - 10 * MIN), endIso: isoFromEpochMs(end) },
    publishedAtIso: isoFromEpochMs(end + publishedLagMs),
    md5: '041c99be56e84090dfd04b9ade629e3a',
    bodyName: `${id}-BODY.nc`,
  };
}

class FakeClient implements LightningClient {
  searches: { startIso: string; endIso: string }[] = [];
  downloads: string[] = [];
  searchAnswer: LightningSearch = { ok: true, products: [] };
  failDownload: Map<string, LightningDownload> = new Map();

  constructor(private readonly clock: VirtualClock) {}

  search(window: { startIso: string; endIso: string }): Promise<LightningSearch> {
    this.searches.push(window);
    return Promise.resolve(this.searchAnswer);
  }

  downloadBody(p: LightningProduct): Promise<LightningDownload> {
    this.downloads.push(p.id);
    const failure = this.failDownload.get(p.id);
    if (failure !== undefined) return Promise.resolve(failure);
    return Promise.resolve({
      ok: true,
      bytes: new TextEncoder().encode(p.id),
      sha256: 'a'.repeat(64),
      availableAt: this.clock.now(),
    });
  }
}

/** Emits one flash in the middle of the window, or what `answer` says for a body name. */
class FakeDecoder implements LightningDecoder {
  refs: LightningGranuleRef[] = [];
  answers = new Map<string, Partial<DecodeResult>>();

  decode(ref: LightningGranuleRef): Promise<DecodeResult> {
    this.refs.push(ref);
    const override = this.answers.get(ref.name);
    const [startIso, endIso] = ref.slotIso.split('/') as [string, string];
    const mid = (Date.parse(startIso) + Date.parse(endIso)) / 2;
    const payload = JSON.stringify({
      format: LIGHTNING_PAYLOAD_FORMAT,
      window: { start: startIso, end: endIso },
      flashes: [
        {
          t: new Date(mid).toISOString(),
          lat: 42.5,
          lon: 23.5,
          radiance: 1,
          durationMs: 2,
          footprint: 3,
          falseLikelihood: 0.02,
        },
      ],
      decoder: {
        flashes: 2,
        clippedOut: 1,
        droppedWithoutPosition: 0,
        droppedWithoutTime: 0,
        droppedOutsideWindow: 0,
      },
    });
    return Promise.resolve({
      outcome: 'ok',
      payload,
      error: null,
      durationMs: 5,
      ...override,
    } as DecodeResult);
  }
}

function harness() {
  const clock = new VirtualClock(NOW);
  const client = new FakeClient(clock);
  const decoder = new FakeDecoder();
  const payloads = new MemoryPayloads();
  const feedStatus = new MemoryFeedStatus();
  const deps = { client, decoder, payloads, reader: payloads, clock, feedStatus };
  return { clock, client, decoder, payloads, feedStatus, deps };
}

function documentOf(payloads: MemoryPayloads) {
  const text = payloads.text(LIGHTNING_CURRENT_PATH);
  return text === undefined ? null : parseLightningDocument(text);
}

describe('runLightningRefresh', () => {
  it('searches nine hours plus a margin, records each product, and writes the merged document', async () => {
    const { client, decoder, payloads, deps } = harness();
    const a = product('a', 20);
    const b = product('b', 10);
    client.searchAnswer = { ok: true, products: [a, b] };

    const report = await runLightningRefresh(deps);

    expect(client.searches).toEqual([
      { startIso: '2026-09-30T03:30:00Z', endIso: '2026-09-30T12:40:00Z' },
    ]);
    expect(client.downloads).toEqual(['b', 'a']);
    expect(decoder.refs[0]).toMatchObject({
      source: 'eumetsat:mtg-li:lfl',
      kind: 'lightning-flashes',
      slotIso: '2026-09-30T12:20:09.000Z/2026-09-30T12:30:09.000Z',
      name: 'b-BODY.nc',
    });
    expect(report.products.map((p) => [p.id, p.outcome, p.flashes])).toEqual([
      ['b', 'recorded', 1],
      ['a', 'recorded', 1],
    ]);
    expect(report.documentWritten).toBe(true);
    expect(report.coveredThrough).toBe(b.window.endIso);
    expect(lightningRefreshFailed(report)).toBe(false);

    const doc = documentOf(payloads);
    expect(doc?.products.map((p) => p.id)).toEqual(['a', 'b']);
    expect(doc === null ? [] : documentFlashes(doc)).toHaveLength(2);
    const meta = JSON.parse(payloads.text(LIGHTNING_CURRENT_META_PATH) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(meta).toMatchObject({ products: 2, flashes: 2, covered_through: b.window.endIso });
    expect(meta['sha256']).toMatch(/^[0-9a-f]{64}$/);

    const sidecar = JSON.parse(
      payloads.text(recordMetaPath(Date.parse(b.window.endIso), 'b')) ?? '{}',
    ) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      product_id: 'b',
      body_name: 'b-BODY.nc',
      md5_published: '041c99be56e84090dfd04b9ade629e3a',
      raw_sha256: 'a'.repeat(64),
      raw_bytes: 1,
      outcome: 'recorded',
      flashes_in_box: 1,
      counts: { flashes: 2, clippedOut: 1 },
    });
  });

  it('downloads nothing on a second cycle and leaves the document alone', async () => {
    const { client, payloads, deps, clock } = harness();
    client.searchAnswer = { ok: true, products: [product('a', 20), product('b', 10)] };
    await runLightningRefresh(deps);
    const writes = payloads.writes.length;
    clock.advanceMinutes(1);

    const report = await runLightningRefresh(deps);

    expect(client.downloads).toEqual(['b', 'a']);
    expect(report.alreadyRecorded).toBe(2);
    expect(report.documentWritten).toBe(false);
    expect(payloads.writes).toHaveLength(writes);
  });

  it('re-merges a record on disk that the document lost, without refetching it', async () => {
    const { client, payloads, deps } = harness();
    client.searchAnswer = { ok: true, products: [product('a', 20)] };
    await runLightningRefresh(deps);
    payloads.files.delete(LIGHTNING_CURRENT_PATH);

    const report = await runLightningRefresh(deps);

    expect(client.downloads).toEqual(['a']);
    expect(report.alreadyRecorded).toBe(1);
    expect(documentOf(payloads)?.products.map((p) => p.id)).toEqual(['a']);
  });

  it('records a refused product in its sidecar only and never fetches it again', async () => {
    const { client, decoder, payloads, deps } = harness();
    const p = product('bad', 10);
    client.searchAnswer = { ok: true, products: [p] };
    decoder.answers.set('bad-BODY.nc', {
      outcome: 'refused',
      payload: null,
      error: 'required variable latitude is absent',
    });

    const first = await runLightningRefresh(deps);
    expect(first.products[0]).toMatchObject({
      outcome: 'refused',
      error: 'required variable latitude is absent',
    });
    expect(lightningRefreshFailed(first)).toBe(false);
    expect(payloads.text(recordPath(Date.parse(p.window.endIso), 'bad'))).toBeUndefined();
    const meta = JSON.parse(
      payloads.text(recordMetaPath(Date.parse(p.window.endIso), 'bad')) ?? '{}',
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({
      outcome: 'refused',
      reason: 'required variable latitude is absent',
    });

    await runLightningRefresh(deps);
    expect(client.downloads).toEqual(['bad']);
  });

  it('leaves a crashed decode unrecorded, so the next cycle tries again', async () => {
    const { client, decoder, deps } = harness();
    client.searchAnswer = { ok: true, products: [product('a', 10)] };
    decoder.answers.set('a-BODY.nc', { outcome: 'timed_out', payload: null, error: 'timed out' });

    const report = await runLightningRefresh(deps);
    expect(report.products[0]?.outcome).toBe('decode_failed');
    expect(lightningRefreshFailed(report)).toBe(true);

    decoder.answers.clear();
    const retry = await runLightningRefresh(deps);
    expect(retry.products[0]?.outcome).toBe('recorded');
    expect(client.downloads).toEqual(['a', 'a']);
  });

  it('refuses a payload the core parser does not believe', async () => {
    const { client, decoder, deps } = harness();
    client.searchAnswer = { ok: true, products: [product('a', 10)] };
    decoder.answers.set('a-BODY.nc', { payload: '{"format":"other"}' });
    const report = await runLightningRefresh(deps);
    expect(report.products[0]).toMatchObject({ outcome: 'decode_failed' });
    expect(report.products[0]?.error).toMatch(/^payload: /);
  });

  it('downloads at most the cap per cycle, newest first', async () => {
    const { client, deps } = harness();
    const products = Array.from({ length: MAX_DOWNLOADS_PER_CYCLE + 3 }, (_, i) =>
      product(`p${String(i).padStart(2, '0')}`, 10 + i * 10),
    );
    client.searchAnswer = { ok: true, products: [...products].reverse() };

    const report = await runLightningRefresh(deps);

    expect(client.downloads).toEqual(products.slice(0, MAX_DOWNLOADS_PER_CYCLE).map((p) => p.id));
    expect(report.products.filter((p) => p.outcome === 'not_attempted')).toHaveLength(3);
  });

  it('stops the cycle after an authentication refusal', async () => {
    const { client, deps } = harness();
    client.searchAnswer = { ok: true, products: [product('a', 10), product('b', 20)] };
    client.failDownload.set('a', { ok: false, status: 401, error: 'token endpoint returned 401' });

    const report = await runLightningRefresh(deps);

    expect(client.downloads).toEqual(['a']);
    expect(report.products.map((p) => p.outcome)).toEqual(['download_failed', 'not_attempted']);
    expect(report.products[1]?.error).toMatch(/authentication/);
  });

  it('ignores products older than the retention window and duplicates in the search', async () => {
    const { client, deps } = harness();
    const a = product('a', 10);
    client.searchAnswer = { ok: true, products: [a, a, product('old', 9 * 60 + 5)] };
    const report = await runLightningRefresh(deps);
    expect(report.found).toBe(1);
    expect(client.downloads).toEqual(['a']);
  });

  it('reports a failed search and writes nothing', async () => {
    const { client, payloads, deps } = harness();
    client.searchAnswer = { ok: false, status: 503, error: 'search returned 503: busy' };
    const report = await runLightningRefresh(deps);
    expect(report.searchError).toBe('HTTP 503: search returned 503: busy');
    expect(lightningRefreshFailed(report)).toBe(true);
    expect(payloads.writes).toEqual([]);
  });

  it('never throws: a search that throws and a store that fails are both reported', async () => {
    const { client, payloads, deps } = harness();
    client.search = () => Promise.reject(new Error('socket hang up'));
    expect((await runLightningRefresh(deps)).searchError).toBe('socket hang up');

    const second = harness();
    second.client.searchAnswer = { ok: true, products: [product('a', 10)] };
    second.payloads.failWritesOn = /^lightning\//;
    const report = await runLightningRefresh(second.deps);
    expect(report.products[0]?.outcome).toBe('write_failed');
    expect(payloads.writes).toEqual([]);
  });

  it('does not overwrite a document it could not read', async () => {
    const { client, payloads, deps } = harness();
    client.searchAnswer = { ok: true, products: [product('a', 10)] };
    payloads.failReadsOn = /^overlays\/lightning\/current\.json$/;
    const report = await runLightningRefresh(deps);
    expect(report.documentError).toMatch(/document unreadable/);
    expect(report.documentWritten).toBe(false);
    expect(payloads.text(LIGHTNING_CURRENT_PATH)).toBeUndefined();
  });

  it('fetches only the latest product of a window, and replaces an older one already held', async () => {
    const { client, payloads, deps, clock } = harness();
    client.searchAnswer = { ok: true, products: [product('orig', 10), product('n', 20)] };
    await runLightningRefresh(deps);
    clock.advanceMinutes(10);

    const reprocess = product('rep', 10, 30 * MIN);
    const stale = product('rep-old', 10, 20 * MIN);
    client.searchAnswer = {
      ok: true,
      products: [product('orig', 10), product('n', 20), stale, reprocess],
    };
    const report = await runLightningRefresh(deps);

    expect(client.downloads).toEqual(['orig', 'n', 'rep']);
    // `orig` (held) and `rep-old` both lose their window to `rep`.
    expect(report.superseded).toBe(2);
    expect(documentOf(payloads)?.products.map((p) => p.id)).toEqual(['n', 'rep']);

    clock.advanceMinutes(1);
    client.searchAnswer = { ok: true, products: [product('orig', 10)] };
    const again = await runLightningRefresh(deps);
    expect(again.superseded).toBe(1);
    expect(client.downloads).toHaveLength(3);
  });
});

describe('the eumetsat:lightning feed row', () => {
  it('records a successful attempt with data, then a quiet success', async () => {
    const { client, feedStatus, deps, clock } = harness();
    client.searchAnswer = { ok: true, products: [product('a', 10)] };
    await runLightningRefresh(deps);
    clock.advanceMinutes(1);
    await runLightningRefresh(deps);
    expect(feedStatus.attempts).toEqual([
      { row: 'eumetsat:lightning', attemptAt: NOW, succeeded: true, hadData: true, error: null },
      {
        row: 'eumetsat:lightning',
        attemptAt: NOW + MIN,
        succeeded: true,
        hadData: false,
        error: null,
      },
    ]);
  });

  it('fails on a search error, a failed product, or coverage the route would refuse', async () => {
    const { client, decoder, feedStatus, deps, clock } = harness();
    client.searchAnswer = { ok: false, status: 503, error: 'busy' };
    await runLightningRefresh(deps);
    expect(feedStatus.attempts.at(-1)).toMatchObject({ succeeded: false, hadData: false });
    expect(feedStatus.attempts.at(-1)?.error).toMatch(/^search: HTTP 503/);

    client.searchAnswer = { ok: true, products: [product('a', 10)] };
    decoder.answers.set('a-BODY.nc', { outcome: 'crashed', payload: null, error: 'boom' });
    await runLightningRefresh(deps);
    expect(feedStatus.attempts.at(-1)?.error).toMatch(/^a: /);

    decoder.answers.clear();
    await runLightningRefresh(deps);
    expect(feedStatus.attempts.at(-1)?.succeeded).toBe(true);

    clock.advanceMinutes(60);
    client.searchAnswer = { ok: true, products: [] };
    await runLightningRefresh(deps);
    expect(feedStatus.attempts.at(-1)).toMatchObject({ succeeded: false });
    expect(feedStatus.attempts.at(-1)?.error).toMatch(/covered only through/);
  });

  it('counts a refused product as the feed working', async () => {
    const { client, decoder, feedStatus, deps } = harness();
    client.searchAnswer = { ok: true, products: [product('ok', 10), product('bad', 20)] };
    decoder.answers.set('bad-BODY.nc', { outcome: 'refused', payload: null, error: 'no lat' });
    await runLightningRefresh(deps);
    expect(feedStatus.attempts.at(-1)).toMatchObject({ succeeded: true, hadData: true });
  });

  it('reports a store failure without throwing, and degrades the cycle', async () => {
    const { client, feedStatus, deps } = harness();
    client.searchAnswer = { ok: true, products: [product('a', 10)] };
    feedStatus.throws = true;
    const report = await runLightningRefresh(deps);
    expect(report.feedStatusError).toBe('feed status disk unwritable');
    expect(lightningRefreshFailed(report)).toBe(true);
  });
});
