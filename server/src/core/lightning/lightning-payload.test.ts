import { describe, expect, it } from 'vitest';

import {
  LIGHTNING_KIND,
  LIGHTNING_SOURCE,
  type LightningGranuleRef,
} from '../ports/lightning-decoder.js';
import {
  LIGHTNING_PAYLOAD_FORMAT,
  MAX_PAYLOAD_FLASHES,
  parseInterval,
  parseLightningPayload,
} from './lightning-payload.js';

const REF: LightningGranuleRef = {
  source: LIGHTNING_SOURCE,
  kind: LIGHTNING_KIND,
  slotIso: '2026-09-30T12:20:09Z/2026-09-30T12:30:09Z',
  name: 'body.nc',
};

function payload(overrides: Record<string, unknown> = {}, rows?: unknown[]): string {
  const flashes = rows ?? [
    {
      t: '2026-09-30T12:21:00.250Z',
      lat: 42.7,
      lon: 23.3,
      radiance: 12.5,
      durationMs: 180,
      footprint: 3,
    },
    {
      t: '2026-09-30T12:29:00Z',
      lat: 41,
      lon: 25,
      radiance: null,
      durationMs: null,
      footprint: null,
    },
  ];
  return JSON.stringify({
    format: LIGHTNING_PAYLOAD_FORMAT,
    window: { start: '2026-09-30T12:20:09.000Z', end: '2026-09-30T12:30:09.000Z' },
    flashes,
    decoder: {
      name: 'h5wasm-mtg-li-lfl',
      flashes: flashes.length + 3,
      clippedOut: 2,
      droppedWithoutPosition: 1,
      droppedWithoutTime: 0,
      droppedOutsideWindow: 0,
      bytes: 1234,
    },
    ...overrides,
  });
}

function reason(text: string, ref = REF): string {
  const read = parseLightningPayload(ref, text);
  if (read.ok) throw new Error('expected a refusal');
  return read.reason;
}

describe('parseLightningPayload', () => {
  it('reads flashes into epoch milliseconds and keeps the counts', () => {
    const read = parseLightningPayload(REF, payload());
    expect(read).toEqual({
      ok: true,
      window: { start: Date.UTC(2026, 8, 30, 12, 20, 9), end: Date.UTC(2026, 8, 30, 12, 30, 9) },
      flashes: [
        {
          at: Date.UTC(2026, 8, 30, 12, 21, 0, 250),
          lat: 42.7,
          lon: 23.3,
          radiance: 12.5,
          durationMs: 180,
          footprint: 3,
        },
        {
          at: Date.UTC(2026, 8, 30, 12, 29),
          lat: 41,
          lon: 25,
          radiance: null,
          durationMs: null,
          footprint: null,
        },
      ],
      counts: {
        flashes: 5,
        clippedOut: 2,
        droppedWithoutPosition: 1,
        droppedWithoutTime: 0,
        droppedOutsideWindow: 0,
      },
    });
  });

  it('refuses another format, and a window that is not the one fetched', () => {
    expect(reason(payload({ format: 'fire-watch.granule.v1' }))).toMatch(/format/);
    expect(
      reason(payload({ window: { start: '2026-09-30T12:10:09Z', end: '2026-09-30T12:20:09Z' } })),
    ).toMatch(/not the window/);
  });

  it('refuses the whole payload for one flash outside the window tolerance', () => {
    expect(
      reason(
        payload({}, [
          {
            t: '2026-09-30T12:40:00Z',
            lat: 42,
            lon: 23,
            radiance: null,
            durationMs: null,
            footprint: null,
          },
        ]),
      ),
    ).toMatch(/flash 0 time/);
  });

  it.each([
    [{ t: '2026-09-30T12:21:00Z', lat: 91, lon: 23 }, /position/],
    [{ t: '2026-09-30T12:21:00Z', lat: 42, lon: '23' }, /position/],
    [{ t: '2026-09-30T12:21:00+00:00', lat: 42, lon: 23 }, /time/],
    [{ t: '2026-09-30T12:21:00Z', lat: 42, lon: 23, radiance: -1 }, /optional/],
    [{ t: '2026-09-30T12:21:00Z', lat: 42, lon: 23 }, /optional/],
  ])('refuses the row %j', (row, pattern) => {
    expect(reason(payload({}, [row]))).toMatch(pattern);
  });

  it('refuses counts that do not close', () => {
    const text = payload();
    const raw = JSON.parse(text) as { decoder: { flashes: number } };
    raw.decoder.flashes += 1;
    expect(reason(JSON.stringify(raw))).toBe('payload decoder counts are malformed');
  });

  it('refuses more flashes than a clipped product can hold', () => {
    const rows = new Array<unknown>(MAX_PAYLOAD_FLASHES + 1).fill({});
    expect(reason(payload({}, rows))).toMatch(/over/);
  });

  it('refuses a malformed ref window and non-JSON', () => {
    expect(reason(payload(), { ...REF, slotIso: 'x' })).toMatch(/ref window/);
    expect(reason('not json')).toBe('payload is not JSON');
  });
});

describe('parseInterval', () => {
  it('reads ordered instants and refuses anything else', () => {
    expect(parseInterval('2026-09-30T12:20:09Z/2026-09-30T12:30:09Z')).toEqual({
      start: Date.UTC(2026, 8, 30, 12, 20, 9),
      end: Date.UTC(2026, 8, 30, 12, 30, 9),
    });
    expect(parseInterval('2026-09-30T12:30:09Z/2026-09-30T12:20:09Z')).toBeNull();
    expect(parseInterval('2026-09-30T12:30:09Z')).toBeNull();
  });
});
