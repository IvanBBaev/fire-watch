/**
 * The C4/G4 acceptance at the core level: every cache-poisoning body — the two ADR-001
 * A2.2 names (200 + ServiceException XML, 200 + blank image) and the G4 additions
 * (200 + HTML, 200 + wrong-size PNG) — must leave the served `current.*` exactly as the
 * last good refresh wrote it. The same sequence over real files and the HTTP route is
 * `adapters/http/effis-overlay-route.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { EFFIS_LAYERS, type EffisLayerSpec } from '../config/effis-layers.js';
import { VirtualClock, epochMsFromIso } from '../ports/clock.js';
import type { EffisClient, EffisLayerFetch } from '../ports/effis-client.js';
import type { FeedAttempt, FeedStatusStore } from '../ports/feed-status-store.js';
import type { PayloadStore, PayloadWriteResult } from '../ports/payload-store.js';
import {
  effisCurrentPath,
  effisRefreshFailed,
  effisSuspectLatestMetaPath,
  effisSuspectLatestPath,
  payloadStamp,
  runEffisRefresh,
  type EffisRefreshDeps,
} from './effis-refresh.js';
import { encodePng, storedInflate, type PngSpec } from './png-testkit.js';

const FWI = specOf('fwi');
const BA = specOf('ba');

function specOf(id: string): EffisLayerSpec {
  const spec = EFFIS_LAYERS.values.layers.find((layer) => layer.id === id);
  if (spec === undefined) throw new Error(`no layer ${id}`);
  return spec;
}

/**
 * A real raster at the requested 1100×700: palette, 4-bit, transparent sea on the left
 * and graded "land" on the right. Built once — the classifier decodes every pixel.
 */
const FWI_RASTER: PngSpec = {
  width: EFFIS_LAYERS.values.wmsWidth,
  height: EFFIS_LAYERS.values.wmsHeight,
  colorType: 3,
  bitDepth: 4,
  palette: Uint8Array.from([0, 0, 0, 255, 255, 0, 255, 128, 0, 200, 0, 0]),
  transparency: Uint8Array.from([0]),
  pixel: (x, y) => [x < 400 ? 0 : 1 + ((x + y) % 3)],
};
const GOOD_PNG = encodePng(FWI_RASTER);
const goodPng = (): Uint8Array => GOOD_PNG.slice();

const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** ~42 bytes: a legitimate off-season burnt-area answer, above the BA floor of 32. */
const EMPTY_FEATURE_COLLECTION = '{"type":"FeatureCollection","features":[]}';

/** What the EFFIS mapserver really sends with a 200 when a layer name is wrong. */
const SERVICE_EXCEPTION_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<ServiceExceptionReport version="1.3.0" xmlns="http://www.opengis.net/ogc">' +
  '<ServiceException code="LayerNotDefined">msWMSLoadGetMapParams(): WMS server error. ' +
  'Invalid layer(s) given in the LAYERS parameter.</ServiceException>' +
  '</ServiceExceptionReport>';

/**
 * Byte-exact equality for payloads. `toEqual` walks a typed array element by element
 * through its generic deep-equality machinery — about a second and a half per 386 KB
 * raster on a busy host, so a test doing three of them spent its whole timeout comparing
 * bytes. A plain loop is the same claim at a thousandth of the cost, and the first
 * differing offset is a better failure message than a 386 KB diff.
 */
function expectSameBytes(actual: Uint8Array | undefined, expected: Uint8Array | undefined): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  expect(expected).toBeInstanceOf(Uint8Array);
  if (actual === undefined || expected === undefined) return;
  expect(actual.byteLength).toBe(expected.byteLength);
  let firstDifference = -1;
  for (let at = 0; at < actual.byteLength; at += 1) {
    if (actual[at] !== expected[at]) {
      firstDifference = at;
      break;
    }
  }
  expect(firstDifference, 'offset of the first differing byte').toBe(-1);
}

class FakePayloadStore implements PayloadStore {
  readonly payloads = new Map<string, Uint8Array>();
  readonly texts = new Map<string, string>();
  /** Paths matching this throw on write — a full disk, a permission error. */
  failOn: RegExp | null = null;
  existsThrows = false;

  exists(relativePath: string): Promise<boolean> {
    if (this.existsThrows) return Promise.reject(new Error('stat failed'));
    return Promise.resolve(this.payloads.has(relativePath) || this.texts.has(relativePath));
  }

  writePayload(relativePath: string, bytes: Uint8Array): Promise<PayloadWriteResult> {
    if (this.failOn?.test(relativePath) === true) {
      return Promise.reject(new Error(`disk full: ${relativePath}`));
    }
    this.payloads.set(relativePath, bytes.slice());
    return Promise.resolve({ bytes: bytes.byteLength, sha256: fakeSha(bytes) });
  }

  writeText(relativePath: string, text: string): Promise<PayloadWriteResult> {
    if (this.failOn?.test(relativePath) === true) {
      return Promise.reject(new Error(`disk full: ${relativePath}`));
    }
    this.texts.set(relativePath, text);
    return Promise.resolve({ bytes: text.length, sha256: fakeSha(textBytes(text)) });
  }
}

class FakeFeedStatusStore implements FeedStatusStore {
  readonly attempts: FeedAttempt[] = [];
  throws = false;

  recordAttempt(attempt: FeedAttempt): Promise<void> {
    if (this.throws) return Promise.reject(new Error('feed status disk unwritable'));
    this.attempts.push(attempt);
    return Promise.resolve();
  }
}

/** Answers per layer name; anything unlisted is a loud test bug, not a silent success. */
const clientAnswering = (answers: Record<string, () => EffisLayerFetch>): EffisClient => ({
  fetchLayer: (request) => {
    const answer = answers[request.layer];
    if (answer === undefined) return Promise.reject(new Error(`unexpected layer ${request.layer}`));
    return Promise.resolve(answer());
  },
});

const fetched = (bytes: Uint8Array, contentType: string, availableAt: number): EffisLayerFetch => ({
  status: 200,
  bytes,
  contentType,
  availableAt,
  error: null,
});

const failure = (error: string): EffisLayerFetch => ({
  status: null,
  bytes: null,
  contentType: null,
  availableAt: null,
  error,
});

function fakeSha(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `fakesha-${hash.toString(16).padStart(8, '0')}-${String(bytes.byteLength)}`;
}

interface Harness {
  readonly clock: VirtualClock;
  readonly payloads: FakePayloadStore;
  readonly feedStatus: FakeFeedStatusStore;
  readonly deps: (client: EffisClient) => EffisRefreshDeps;
}

function harness(): Harness {
  const clock = new VirtualClock('2026-08-13T10:15:00Z');
  const payloads = new FakePayloadStore();
  const feedStatus = new FakeFeedStatusStore();
  return {
    clock,
    payloads,
    feedStatus,
    deps: (client) => ({ client, payloads, feedStatus, clock, inflate: storedInflate }),
  };
}

/** Both layers answer well — the state every poisoning test starts from. */
async function seedGoodRun(h: Harness): Promise<void> {
  const at = h.clock.now();
  const report = await runEffisRefresh(
    h.deps(
      clientAnswering({
        [FWI.layerName]: () => fetched(goodPng(), 'image/png', at),
        [BA.layerName]: () => fetched(textBytes(EMPTY_FEATURE_COLLECTION), 'application/json', at),
      }),
    ),
  );
  expect(report.layers.map((layer) => layer.outcome)).toEqual(['stored', 'stored']);
}

describe('runEffisRefresh', () => {
  it('stores good layers, replaces current and records full provenance', async () => {
    const h = harness();
    await seedGoodRun(h);

    expectSameBytes(h.payloads.payloads.get(effisCurrentPath(FWI)), goodPng());
    expectSameBytes(
      h.payloads.payloads.get(effisCurrentPath(BA)),
      textBytes(EMPTY_FEATURE_COLLECTION),
    );

    const stamp = payloadStamp(epochMsFromIso('2026-08-13T10:15:00Z'));
    const meta = h.payloads.texts.get(`overlays/effis/fwi/${stamp}/meta.json`);
    expect(meta).toBeDefined();
    const parsed = JSON.parse(meta ?? '') as Record<string, unknown>;
    expect(parsed['feed']).toBe('effis:layers');
    expect(parsed['layer_name']).toBe('ecmwf007.fwi');
    expect(parsed['sanity']).toBe('good');
    expect(parsed['sanity_rule']).toBeNull();
    expect(parsed['received_status']).toBe(200);
    expect(parsed['raster']).toMatchObject({ width: 1100, height: 700, uniform: false });
    expect(parsed['sha256']).toBe(fakeSha(goodPng()));
    expect(parsed['available_at']).toBe('2026-08-13T10:15:00Z');
    expect(parsed['effis_layers_version']).toBe('effis_layers_v1');
    expect(parsed['polling_bbox_version']).toBe('polling_bbox_v1');
    // The recorded query is the query on the wire, axis order and all.
    expect((parsed['query'] as Record<string, string>)['BBOX']).toBe('39,20,46,31');

    // Both freshness rows written: the feed strictly (all layers), the job leniently (any).
    expect(h.feedStatus.attempts).toEqual([
      expect.objectContaining({ row: 'effis:layers', succeeded: true, hadData: true }),
      expect.objectContaining({ row: 'effis-refresh', succeeded: true, hadData: true }),
    ]);
  });

  it('never lets a 200 ServiceException poison the served copy (acceptance A2.2-a)', async () => {
    const h = harness();
    await seedGoodRun(h);
    const currentBefore = h.payloads.payloads.get(effisCurrentPath(FWI));
    h.clock.advanceHours(6);

    const at = h.clock.now();
    const report = await runEffisRefresh(
      h.deps(
        clientAnswering({
          // EFFIS answers 200 OK — with XML where the raster should be.
          [FWI.layerName]: () =>
            fetched(textBytes(SERVICE_EXCEPTION_XML), 'text/xml;charset=UTF-8', at),
          [BA.layerName]: () =>
            fetched(textBytes(EMPTY_FEATURE_COLLECTION), 'application/json', at),
        }),
      ),
    );

    const fwi = report.layers.find((layer) => layer.layer === 'fwi');
    expect(fwi?.outcome).toBe('rejected');
    expect(fwi?.sanity).toBe('reject');
    expect(fwi?.sanityRule).toBe('content_type_mismatch');
    expect(fwi?.staleAvailable).toBe(true);

    // The heart of the acceptance: current.* is byte-identical to the last good refresh.
    expectSameBytes(h.payloads.payloads.get(effisCurrentPath(FWI)), currentBefore);

    // The rejected body is kept as evidence, not discarded — with its own sidecar.
    const stamp = payloadStamp(at);
    expectSameBytes(
      h.payloads.payloads.get(`overlays/effis/fwi/rejected/${stamp}/payload.bin`),
      textBytes(SERVICE_EXCEPTION_XML),
    );
    const meta = JSON.parse(
      h.payloads.texts.get(`overlays/effis/fwi/rejected/${stamp}/meta.json`) ?? '',
    ) as Record<string, unknown>;
    expect(meta['sanity']).toBe('reject');
    expect(meta['sanity_rule']).toBe('content_type_mismatch');
    expect(meta['received_content_type']).toBe('text/xml;charset=UTF-8');

    // One bad layer degrades the feed row but not the whole refresh: BA still landed.
    expect(h.feedStatus.attempts.slice(2)).toEqual([
      expect.objectContaining({ row: 'effis:layers', succeeded: false, hadData: true }),
      expect.objectContaining({ row: 'effis-refresh', succeeded: true, hadData: true }),
    ]);
    expect(effisRefreshFailed(report)).toBe(false);
    // The rule name travels to the freshness row, and a rejected body is never staged
    // for pass-through.
    expect(h.feedStatus.attempts[2]?.error).toMatch(/^fwi: content_type_mismatch: /);
    expect(h.payloads.payloads.has(effisSuspectLatestPath(FWI))).toBe(false);
  });

  it.each([
    [
      'an HTML error page served as 200',
      () => textBytes('<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>'),
      'text/html',
      'content_type_mismatch',
    ],
    [
      'a ServiceException labelled image/png',
      () => textBytes(SERVICE_EXCEPTION_XML),
      'image/png',
      'error_document_body',
    ],
    [
      'a PNG of a size we did not request',
      () => encodePng({ ...FWI_RASTER, width: 256, height: 256 }),
      'image/png',
      'png_dimensions_mismatch',
    ],
    ['a truncated PNG', () => GOOD_PNG.slice(0, 5000), 'image/png', 'png_structure_invalid'],
  ])('rejects %s and keeps serving the last good copy (G4)', async (_name, body, type, rule) => {
    const h = harness();
    await seedGoodRun(h);
    h.clock.advanceHours(6);
    const at = h.clock.now();
    const report = await runEffisRefresh(
      h.deps(
        clientAnswering({
          [FWI.layerName]: () => fetched(body(), type, at),
          [BA.layerName]: () =>
            fetched(textBytes(EMPTY_FEATURE_COLLECTION), 'application/json', at),
        }),
      ),
    );
    const fwi = report.layers.find((layer) => layer.layer === 'fwi');
    expect(fwi).toMatchObject({ outcome: 'rejected', sanity: 'reject', sanityRule: rule });
    expectSameBytes(h.payloads.payloads.get(effisCurrentPath(FWI)), GOOD_PNG);
    expect(
      h.payloads.payloads.has(`overlays/effis/fwi/rejected/${payloadStamp(at)}/payload.bin`),
    ).toBe(true);
    expect(h.feedStatus.attempts[2]?.error).toContain(`fwi: ${rule}: `);
  });

  it('never lets a 200 blank image poison the served copy (acceptance A2.2-b)', async () => {
    const h = harness();
    await seedGoodRun(h);
    const currentBefore = h.payloads.payloads.get(effisCurrentPath(FWI));
    h.clock.advanceHours(6);

    const at = h.clock.now();
    // Right type, right size, well-formed — and not one visible pixel.
    const blank = encodePng({ ...FWI_RASTER, pixel: () => [0] });
    const report = await runEffisRefresh(
      h.deps(
        clientAnswering({
          [FWI.layerName]: () => fetched(blank, 'image/png', at),
          [BA.layerName]: () =>
            fetched(textBytes(EMPTY_FEATURE_COLLECTION), 'application/json', at),
        }),
      ),
    );

    const fwi = report.layers.find((layer) => layer.layer === 'fwi');
    expect(fwi?.outcome).toBe('suspect');
    expect(fwi?.sanity).toBe('suspect');
    expect(fwi?.sanityRule).toBe('png_fully_transparent');
    expectSameBytes(h.payloads.payloads.get(effisCurrentPath(FWI)), currentBefore);

    // Suspect evidence keeps the layer's own extension: it claims to be a PNG.
    const stamp = payloadStamp(at);
    expectSameBytes(
      h.payloads.payloads.get(`overlays/effis/fwi/suspect/${stamp}/payload.png`),
      blank,
    );
    // Staged for the A2.2 pass-through, which the route uses only while no current exists.
    expectSameBytes(h.payloads.payloads.get(effisSuspectLatestPath(FWI)), blank);
    const meta = JSON.parse(h.payloads.texts.get(effisSuspectLatestMetaPath(FWI)) ?? '') as Record<
      string,
      unknown
    >;
    expect(meta['sanity_rule']).toBe('png_fully_transparent');
  });

  it('treats a right-typed body under the byte floor as suspect', async () => {
    const h = harness();
    const at = h.clock.now();
    const report = await runEffisRefresh(
      h.deps(
        clientAnswering({
          [FWI.layerName]: () => fetched(goodPng(), 'image/png', at),
          [BA.layerName]: () => fetched(textBytes('{"features":[]}'), 'application/json', at),
        }),
      ),
    );
    const ba = report.layers.find((layer) => layer.layer === 'ba');
    expect(ba).toMatchObject({
      outcome: 'suspect',
      sanity: 'suspect',
      sanityRule: 'body_below_byte_floor',
      staleAvailable: false,
    });
    expect(h.payloads.payloads.has(effisCurrentPath(BA))).toBe(false);
  });

  it('reports fetch failures per layer and records the attempt as failed', async () => {
    const h = harness();
    const report = await runEffisRefresh(
      h.deps(
        clientAnswering({
          [FWI.layerName]: () => failure('EFFIS returned 503 for ecmwf007.fwi: down'),
          [BA.layerName]: () => failure('EFFIS request failed for EFFIS:BurntAreas7Days: timeout'),
        }),
      ),
    );

    expect(report.layers.map((layer) => layer.outcome)).toEqual(['fetch_failed', 'fetch_failed']);
    expect(report.layers.map((layer) => layer.staleAvailable)).toEqual([false, false]);
    expect(h.feedStatus.attempts).toEqual([
      expect.objectContaining({ row: 'effis:layers', succeeded: false, hadData: false }),
      expect.objectContaining({ row: 'effis-refresh', succeeded: false, hadData: false }),
    ]);
    expect(effisRefreshFailed(report)).toBe(true);
    // The attempt row still carries why, for the freshness page.
    expect(h.feedStatus.attempts[0]?.error).toContain('503');
    expect(h.feedStatus.attempts[0]?.error).toContain('timeout');
  });

  it('contains a client that throws instead of returning a failure value', async () => {
    const h = harness();
    const report = await runEffisRefresh(
      h.deps({
        fetchLayer: () => Promise.reject(new Error('socket hang up')),
      }),
    );
    expect(report.layers.map((layer) => layer.outcome)).toEqual(['fetch_failed', 'fetch_failed']);
    expect(report.layers[0]?.error).toBe('socket hang up');
    // The freshness rows were still recorded — the report survived the failure it reports.
    expect(h.feedStatus.attempts).toHaveLength(2);
  });

  it('marks a good body the store could not keep as write_failed and leaves current alone', async () => {
    const h = harness();
    await seedGoodRun(h);
    const currentBefore = h.payloads.payloads.get(effisCurrentPath(FWI));
    h.clock.advanceHours(6);
    h.payloads.failOn = /^overlays\/effis\/fwi\/2026/;

    const at = h.clock.now();
    const report = await runEffisRefresh(
      h.deps(
        clientAnswering({
          [FWI.layerName]: () => fetched(goodPng(), 'image/png', at),
          [BA.layerName]: () =>
            fetched(textBytes(EMPTY_FEATURE_COLLECTION), 'application/json', at),
        }),
      ),
    );

    const fwi = report.layers.find((layer) => layer.layer === 'fwi');
    expect(fwi?.outcome).toBe('write_failed');
    expect(fwi?.error).toContain('disk full');
    expectSameBytes(h.payloads.payloads.get(effisCurrentPath(FWI)), currentBefore);
  });

  it('treats an unwritable feed status store as a failed refresh, whatever the layers did', async () => {
    const h = harness();
    h.feedStatus.throws = true;
    const at = h.clock.now();
    const report = await runEffisRefresh(
      h.deps(
        clientAnswering({
          [FWI.layerName]: () => fetched(goodPng(), 'image/png', at),
          [BA.layerName]: () =>
            fetched(textBytes(EMPTY_FEATURE_COLLECTION), 'application/json', at),
        }),
      ),
    );
    expect(report.layers.map((layer) => layer.outcome)).toEqual(['stored', 'stored']);
    expect(report.feedStatusError).toContain('unwritable');
    expect(report.jobStatusError).toContain('unwritable');
    // Layers landed, but the evidence chain broke: the heartbeat must not say "fine".
    expect(effisRefreshFailed(report)).toBe(true);
  });
});

describe('payloadStamp', () => {
  it('renders an instant that survives being a directory name', () => {
    expect(payloadStamp(epochMsFromIso('2026-08-13T10:15:00Z'))).toBe('2026-08-13T101500Z');
  });

  it('drops fractional seconds', () => {
    expect(payloadStamp(epochMsFromIso('2026-08-13T10:15:00.250Z'))).toBe('2026-08-13T101500Z');
  });
});
