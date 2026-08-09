import { describe, expect, it } from 'vitest';

import type { GranuleRef } from '../ports/granule-decoder.js';
import {
  GRANULE_PAYLOAD_FORMAT,
  MAX_PAYLOAD_CHARS,
  MAX_PAYLOAD_ROWS,
  parseGranulePayload,
} from './granule-payload.js';

const REF: GranuleRef = {
  source: 'lsasaf:seviri:frp-pixel',
  kind: 'frp',
  slotIso: '2026-08-02T11:15:00Z',
  name: 'HDF5_LSASAF_MSG_FRP-PIXEL-ListProduct_MSG-Disk_202608021115',
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lat: 41.85012,
    lon: 26.14003,
    acq: '2026-08-02T11:15:00Z',
    confidence: 'nominal',
    confidenceRaw: '2',
    frpMw: 12.5,
    scanKm: 4.8,
    trackKm: 5.6,
    brightnessK: 330.5,
    brightnessBgK: 295.1,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: GRANULE_PAYLOAD_FORMAT,
    source: REF.source,
    kind: REF.kind,
    slot: REF.slotIso,
    detections: [row()],
    ...overrides,
  });
}

function reasonFor(text: string, ref: GranuleRef = REF): string {
  const result = parseGranulePayload(ref, text);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.reason;
}

describe('a payload we can use', () => {
  it('reads every field the archive stores', () => {
    const result = parseGranulePayload(REF, payload());

    expect(result).toEqual({
      ok: true,
      rows: [
        {
          latCanonical: '41.85012',
          lonCanonical: '26.14003',
          acqTsIso: '2026-08-02T11:15:00Z',
          confidence: 'nominal',
          confidenceRaw: '2',
          frpMw: 12.5,
          scanKm: 4.8,
          trackKm: 5.6,
          brightnessK: 330.5,
          brightnessBgK: 295.1,
        },
      ],
    });
  });

  it('mints the coordinate text here, because the uid is hashed from text', () => {
    // The decoder reports a double; five fixed decimals with their trailing zeros is the
    // only form that survives a round trip through the database and back into a hash.
    const result = parseGranulePayload(REF, payload({ detections: [row({ lat: 42, lon: -0.1 })] }));

    expect(result.ok && result.rows[0]?.latCanonical).toBe('42.00000');
    expect(result.ok && result.rows[0]?.lonCanonical).toBe('-0.10000');
  });

  it('keeps an unreported measurement null and a reported zero zero', () => {
    const result = parseGranulePayload(
      REF,
      payload({ detections: [row({ frpMw: 0, brightnessK: null, scanKm: undefined })] }),
    );

    expect(result.ok && result.rows[0]?.frpMw).toBe(0);
    expect(result.ok && result.rows[0]?.brightnessK).toBeNull();
    expect(result.ok && result.rows[0]?.scanKm).toBeNull();
  });

  it('accepts an empty granule, which is what most slots are', () => {
    const result = parseGranulePayload(REF, payload({ detections: [] }));

    expect(result).toEqual({ ok: true, rows: [] });
  });
});

describe('a payload we cannot trust', () => {
  it('is refused, never thrown', () => {
    // Total by construction: the caller has a quarantine reason, not a stack trace.
    for (const text of ['', 'null', '[]', '{', '"a string"', '{"format":1e999}']) {
      expect(parseGranulePayload(REF, text).ok).toBe(false);
    }
  });

  it('cannot poison a prototype on its way in', () => {
    const hostile = payload({
      detections: [{ ...row(), __proto__: { polluted: 'yes' } }],
    });

    const result = parseGranulePayload(REF, hostile);

    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('cannot smuggle an infinity past a schema check', () => {
    // `1e999` is valid JSON and parses to Infinity. Left alone it becomes a NaN several
    // functions downstream, in a mean nobody is watching. It has to be spliced into the
    // text: `JSON.stringify` cannot produce it, which is exactly why it gets overlooked.
    expect(reasonFor(payload().replace('"frpMw":12.5', '"frpMw":1e999'))).toMatch(
      /frpMw is Infinity/,
    );
    expect(reasonFor(payload().replace('"lat":41.85012', '"lat":-1e999'))).toMatch(/coordinates/);
  });

  it('cannot be a hundred megabytes, and is measured before it is parsed', () => {
    const flood = `{"pad":"${'x'.repeat(MAX_PAYLOAD_CHARS)}"}`;

    expect(reasonFor(flood)).toMatch(/over the 1000000 cap/);
  });

  it('cannot claim more rows than a slot can hold', () => {
    const many = JSON.stringify({
      format: GRANULE_PAYLOAD_FORMAT,
      source: REF.source,
      kind: REF.kind,
      slot: REF.slotIso,
      detections: Array.from({ length: MAX_PAYLOAD_ROWS + 1 }, () => 0),
    });

    expect(reasonFor(many)).toMatch(/over the 20000 cap/);
  });

  it('cannot answer about a granule other than the one it was given', () => {
    // A compromised decoder choosing its own attribution would write rows into any
    // source's history it liked, and attribution is what the archive is keyed on.
    expect(reasonFor(payload({ source: 'firms:viirs:snpp' }))).toMatch(/payload source is/);
    expect(reasonFor(payload({ kind: 'cloud-mask' }))).toMatch(/payload kind is/);
    expect(reasonFor(payload({ slot: '2026-08-02T11:00:00Z' }))).toMatch(/payload slot is/);
  });

  it('cannot speak a format we have not agreed on', () => {
    expect(reasonFor(payload({ format: 'fire-watch.granule.v2' }))).toMatch(/payload format is/);
  });

  it('cannot leave a pixel without a position', () => {
    expect(reasonFor(payload({ detections: [row({ lat: null })] }))).toMatch(/coordinates/);
    expect(reasonFor(payload({ detections: [row({ lon: '26.14003' })] }))).toMatch(/coordinates/);
  });

  it('cannot invent a confidence class', () => {
    expect(reasonFor(payload({ detections: [row({ confidence: 'certain' })] }))).toMatch(
      /confidence is "certain"/,
    );
  });

  it('cannot report an acquisition time in a shape the uid cannot be hashed from', () => {
    expect(reasonFor(payload({ detections: [row({ acq: '2026-08-02 11:15' })] }))).toMatch(/acq/);
    expect(reasonFor(payload({ detections: [row({ acq: '2026-08-02T11:15:30Z' })] }))).toMatch(
      /acq/,
    );
  });

  it('says which row it gave up on, so the granule can be looked at', () => {
    const reason = reasonFor(payload({ detections: [row(), row(), row({ confidence: 42 })] }));

    expect(reason).toMatch(/^row 3: /);
  });

  it('has its reason bounded, because the reason is stored', () => {
    const reason = reasonFor(payload({ detections: [row({ confidence: 'x'.repeat(5000) })] }));

    expect(reason.length).toBeLessThan(400);
    expect(reason).toContain('…');
  });
});
