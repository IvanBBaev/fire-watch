import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { POLLING_BBOX } from '../../core/config/polling-bbox.js';
import { GRANULE_PAYLOAD_FORMAT, parseGranulePayload } from '../../core/ingest/granule-payload.js';
import type { GranuleRef } from '../../core/ports/granule-decoder.js';
import {
  DECODER_REASON_PREFIX,
  DECODER_REFUSED_EXIT,
  GRANULE_REF_ENV,
} from './child-process-decoder.js';
import { buildListGranule, type SyntheticPixel } from './lsa-502-synthetic.js';
import {
  EXIT_REFUSED,
  MAX_LIST_PIXELS,
  PAYLOAD_FORMAT,
  REASON_PREFIX,
  REF_ENV,
  confidenceClass,
  decodeGranule,
  isWasmTrap,
  sniff,
  type DecodeAttempt,
  type Payload,
} from './lsa-frp-pixel-decoder.js';

const REF: GranuleRef = {
  source: 'lsasaf:seviri:frp-pixel',
  kind: 'frp',
  slotIso: '2026-08-02T11:15:00Z',
  name: 'HDF5_LSASAF_MSG_FRP-PIXEL-ListProduct_MSG-Disk_202608021115',
};

/** Two fires in Bulgaria, one in Greece, and one in Angola — a full-disk list is Africa-heavy. */
const PIXELS: readonly SyntheticPixel[] = [
  { lat: 42.71, lon: 23.32, frpMw: 55.3, confidence: 0.91, btMirK: 330.5, btMirBackgroundK: 301.2 },
  { lat: 41.95, lon: 25.61, frpMw: 12.0, confidence: 0.62, btMirK: 318.0, btMirBackgroundK: null },
  { lat: 40.1, lon: 22.4, frpMw: null, confidence: 0.3 },
  { lat: -11.2, lon: 17.8, frpMw: 140.7, confidence: 0.99, btMirK: 345.1, btMirBackgroundK: 303.3 },
];

function payloadOf(attempt: DecodeAttempt): Payload {
  if (!attempt.ok) throw new Error(`expected a payload, got a refusal: ${attempt.reason}`);
  return attempt.payload;
}

/** The reference `bzip2`, as LSA SAF would have run it. */
function bzip2(data: Uint8Array): Uint8Array {
  return new Uint8Array(execFileSync('bzip2', ['-c', '-9'], { input: data }));
}

function reasonOf(attempt: DecodeAttempt): string {
  if (attempt.ok) throw new Error('expected a refusal, got a payload');
  return attempt.reason;
}

describe('the decoder and the rest of the server agree on', () => {
  it('the refusal exit code, the payload format, the ref variable and the reason prefix', () => {
    // The decoder is self-contained so it can run as a bare child; these are the four
    // constants it duplicates instead of importing, held together here.
    expect(EXIT_REFUSED).toBe(DECODER_REFUSED_EXIT);
    expect(PAYLOAD_FORMAT).toBe(GRANULE_PAYLOAD_FORMAT);
    expect(REF_ENV).toBe(GRANULE_REF_ENV);
    expect(REASON_PREFIX).toBe(DECODER_REASON_PREFIX);
  });
});

describe('a synthetic LSA-502 list granule', () => {
  it('decodes to a payload the untrusted-payload reader accepts', async () => {
    const payload = payloadOf(await decodeGranule(REF, await buildListGranule(PIXELS)));

    const read = parseGranulePayload(REF, JSON.stringify(payload));

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.rows).toEqual([
      {
        latCanonical: '42.71000',
        lonCanonical: '23.32000',
        acqTsIso: '2026-08-02T11:15:00Z',
        frpMw: 55.3,
        confidence: 'high',
        confidenceRaw: '0.91',
        scanKm: null,
        trackKm: null,
        brightnessK: 330.5,
        brightnessBgK: 301.2,
      },
      {
        latCanonical: '41.95000',
        lonCanonical: '25.61000',
        acqTsIso: '2026-08-02T11:15:00Z',
        frpMw: 12,
        confidence: 'nominal',
        confidenceRaw: '0.62',
        scanKm: null,
        trackKm: null,
        brightnessK: 318,
        brightnessBgK: null,
      },
      {
        latCanonical: '40.10000',
        lonCanonical: '22.40000',
        acqTsIso: '2026-08-02T11:15:00Z',
        frpMw: null,
        confidence: 'low',
        confidenceRaw: '0.3',
        scanKm: null,
        trackKm: null,
        brightnessK: null,
        brightnessBgK: null,
      },
      {
        latCanonical: '-11.20000',
        lonCanonical: '17.80000',
        acqTsIso: '2026-08-02T11:15:00Z',
        frpMw: 140.7,
        confidence: 'high',
        confidenceRaw: '0.99',
        scanKm: null,
        trackKm: null,
        brightnessK: 345.1,
        brightnessBgK: 303.3,
      },
    ]);
  });

  it('decodes gzip-chunked datasets the same as contiguous ones', async () => {
    const plain = payloadOf(await decodeGranule(REF, await buildListGranule(PIXELS)));
    const gzipped = payloadOf(
      await decodeGranule(REF, await buildListGranule(PIXELS, { gzip: 6 })),
    );

    expect(gzipped.detections).toEqual(plain.detections);
  });

  it('decodes a slot with no fires to an empty list, not a refusal', async () => {
    // "Empty" and "missing" are different facts about a slot (TASKS C2); an honest empty
    // list has to come through as one.
    const payload = payloadOf(await decodeGranule(REF, await buildListGranule([])));

    expect(parseGranulePayload(REF, JSON.stringify(payload))).toEqual({ ok: true, rows: [] });
  });

  it('drops pixels without a position or a confidence, and counts them', async () => {
    const payload = payloadOf(
      await decodeGranule(
        REF,
        await buildListGranule([
          ...PIXELS,
          { lat: null, lon: 23, frpMw: 5, confidence: 0.9 },
          { lat: 42, lon: 23, frpMw: 5, confidence: null },
        ]),
      ),
    );

    expect(payload.detections).toHaveLength(4);
    expect(payload.decoder).toMatchObject({
      pixels: 6,
      droppedWithoutPosition: 1,
      droppedWithoutConfidence: 1,
    });
  });

  it('clips to a window when asked, and says how many it clipped', async () => {
    const payload = payloadOf(
      await decodeGranule(REF, await buildListGranule(PIXELS), { clip: POLLING_BBOX.values }),
    );

    expect(payload.detections.map((row) => row.lat)).toEqual([42.71, 41.95, 40.1]);
    expect(payload.decoder.clippedOut).toBe(1);
  });

  it('keeps a busy full-disk list under the payload cap once clipped', async () => {
    // 6,000 fire pixels scattered over the disk is a very bad day in Africa. Unclipped, a
    // list that size is ~1 MB of JSON — the reader's cap. The clip is what makes a busy
    // day elsewhere on the disk not cost us the Balkan slot.
    const pixels: SyntheticPixel[] = Array.from({ length: 6_000 }, (_, i) => ({
      lat: -35 + ((i * 37) % 7000) / 100,
      lon: -20 + ((i * 53) % 7000) / 100,
      frpMw: (i % 900) / 10,
      confidence: (i % 100) / 100,
      btMirK: 320,
      btMirBackgroundK: 300,
    }));
    const bytes = await buildListGranule(pixels, { gzip: 4 });

    const clipped = payloadOf(await decodeGranule(REF, bytes, { clip: POLLING_BBOX.values }));
    const text = JSON.stringify(clipped);

    expect(parseGranulePayload(REF, text).ok).toBe(true);
    expect(clipped.decoder.pixels).toBe(6_000);
    expect(clipped.detections.length).toBeLessThan(600);
  });
});

describe('a bzip2 granule, as LSA SAF ships it', () => {
  it('decodes to the same rows as the HDF5 inside it, and says it was unpacked', async () => {
    const hdf5 = await buildListGranule(PIXELS);
    const packed = bzip2(hdf5);

    const plain = payloadOf(await decodeGranule(REF, hdf5));
    const unpacked = payloadOf(await decodeGranule(REF, packed));

    expect(sniff(packed)).toBe('bzip2');
    expect(unpacked.detections).toEqual(plain.detections);
    expect(plain.decoder).toMatchObject({
      compression: 'none',
      packedBytes: hdf5.length,
      hdf5Bytes: hdf5.length,
    });
    expect(unpacked.decoder).toMatchObject({
      compression: 'bzip2',
      packedBytes: packed.length,
      hdf5Bytes: hdf5.length,
    });
  });

  it('decodes concatenated streams as one file, as bzip2 -d does', async () => {
    const hdf5 = await buildListGranule(PIXELS);
    const cut = Math.floor(hdf5.length / 3);
    const packed = new Uint8Array(
      Buffer.concat([bzip2(hdf5.subarray(0, cut)), bzip2(hdf5.subarray(cut))]),
    );

    expect(payloadOf(await decodeGranule(REF, packed)).detections).toHaveLength(4);
  });

  it('is refused when the download was cut short', async () => {
    const packed = bzip2(await buildListGranule(PIXELS));

    expect(reasonOf(await decodeGranule(REF, packed.subarray(0, packed.length - 20)))).toMatch(
      /^bzip2 stream ends before its end-of-stream marker/,
    );
  });

  it('is refused when a byte of it is corrupt', async () => {
    const packed = bzip2(await buildListGranule(PIXELS));
    packed[Math.floor(packed.length / 2)] = (packed[Math.floor(packed.length / 2)] ?? 0) ^ 0x55;

    expect(reasonOf(await decodeGranule(REF, packed))).toMatch(/^bzip2 /);
  });

  it('is refused at the cap when it unpacks to more than any granule', async () => {
    const bomb = bzip2(new Uint8Array(16 * 1024 * 1024));

    expect(reasonOf(await decodeGranule(REF, bomb, { maxUnpackedBytes: 4 * 1024 * 1024 }))).toBe(
      'bzip2 output exceeds the 4194304-byte cap',
    );
  });

  it('is refused when what it unpacks to is not HDF5', async () => {
    const html = new TextEncoder().encode('<html>maintenance</html>');

    expect(reasonOf(await decodeGranule(REF, bzip2(html)))).toContain('does not unpack to an HDF5');
    expect(reasonOf(await decodeGranule(REF, bzip2(bzip2(html))))).toContain(
      'unpacks to another bzip2 stream',
    );
  });
});

describe('the confidence classes', () => {
  it('split the probability at the provisional thresholds', () => {
    expect([0, 0.49, 0.5, 0.79, 0.8, 1].map(confidenceClass)).toEqual([
      'low',
      'low',
      'nominal',
      'nominal',
      'high',
      'high',
    ]);
  });
});

describe('a granule the decoder refuses', () => {
  it('is only the start of a bzip2 header', async () => {
    const bz2 = new Uint8Array([0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26]);

    expect(sniff(bz2)).toBe('bzip2');
    expect(reasonOf(await decodeGranule(REF, bz2))).toContain('bzip2');
  });

  it('does not start with the HDF5 signature', async () => {
    const html = new TextEncoder().encode('<html>503 Service Unavailable</html>');

    expect(reasonOf(await decodeGranule(REF, html))).toContain('HDF5 signature');
  });

  it('is a cloud mask, which this season archives but does not parse', async () => {
    const bytes = await buildListGranule(PIXELS);

    expect(reasonOf(await decodeGranule({ ...REF, kind: 'cloud-mask' }, bytes))).toContain(
      'cloud-mask',
    );
  });

  it('is LSA-509, whose netCDF variable names are not pinned yet', async () => {
    const bytes = await buildListGranule(PIXELS);

    expect(
      reasonOf(await decodeGranule({ ...REF, source: 'lsasaf:fci:frp-pixel' }, bytes)),
    ).toContain('no layout');
  });

  it('says it is a different slot from the one it was fetched as', async () => {
    const bytes = await buildListGranule(PIXELS, { acquisitionTime: '20260802113000' });

    expect(reasonOf(await decodeGranule(REF, bytes))).toContain('2026-08-02T11:30:00Z');
  });

  it('does not say which slot it is', async () => {
    const bytes = await buildListGranule(PIXELS, { acquisitionTime: null });

    expect(reasonOf(await decodeGranule(REF, bytes))).toContain('IMAGE_ACQUISITION_TIME');
  });

  it('lacks a required dataset', async () => {
    const bytes = await buildListGranule(PIXELS, { omit: ['FIRE_CONFIDENCE'] });

    expect(reasonOf(await decodeGranule(REF, bytes))).toContain('FIRE_CONFIDENCE is absent');
  });

  it('still decodes without an optional one', async () => {
    const bytes = await buildListGranule(PIXELS, { omit: ['BT_MIR', 'BW_BT_MIR'] });

    const payload = payloadOf(await decodeGranule(REF, bytes));

    expect(payload.detections.every((row) => row.brightnessK === null)).toBe(true);
  });

  it('carries a non-zero OFFSET, whose convention is unverified', async () => {
    const bytes = await buildListGranule(PIXELS, { attributes: { FRP: { OFFSET: 5 } } });

    expect(reasonOf(await decodeGranule(REF, bytes))).toContain('OFFSET');
  });

  it('carries a zero SCALING_FACTOR', async () => {
    const bytes = await buildListGranule(PIXELS, {
      attributes: { LATITUDE: { SCALING_FACTOR: 0 } },
    });

    expect(reasonOf(await decodeGranule(REF, bytes))).toContain('SCALING_FACTOR 0');
  });

  it('has columns of different lengths', async () => {
    const bytes = await buildListGranule(PIXELS, {
      omit: ['BW_BT_MIR'],
      extra: [{ name: 'BW_BT_MIR', data: new Int16Array(3), shape: [3], dtype: '<h' }],
    });

    expect(reasonOf(await decodeGranule(REF, bytes))).toContain('BW_BT_MIR has 3 elements');
  });

  it('has a column that is a grid, not a list', async () => {
    const bytes = await buildListGranule([], {
      omit: ['LATITUDE'],
      extra: [{ name: 'LATITUDE', data: new Int16Array(4), shape: [2, 2], dtype: '<h' }],
    });

    expect(reasonOf(await decodeGranule(REF, bytes))).toContain('one dimension');
  });

  it('declares more pixels than any real list, and is refused before it is read', async () => {
    const declared = MAX_LIST_PIXELS + 1;
    const bytes = await buildListGranule([], {
      omit: ['LATITUDE'],
      extra: [{ name: 'LATITUDE', data: new Int16Array(declared), shape: [declared], dtype: '<h' }],
    });

    expect(reasonOf(await decodeGranule(REF, bytes))).toContain('over the');
  });

  it('uses 64-bit integers, which no list field needs', async () => {
    const bytes = await buildListGranule(PIXELS.slice(0, 1), {
      omit: ['FRP'],
      extra: [{ name: 'FRP', data: [553], shape: [1], dtype: '<q' }],
    });

    expect(reasonOf(await decodeGranule(REF, bytes))).toContain('64-bit');
  });

  it('is truncated, which libhdf5 reports and the child maps to a refusal', async () => {
    const whole = await buildListGranule(PIXELS);

    // In-process the error surfaces as a throw; `main()` turns a non-trap throw into exit
    // 65. What matters here is that it is an ordinary Error, not a WebAssembly trap.
    const thrown: unknown = await decodeGranule(REF, whole.slice(0, 600)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(isWasmTrap(thrown)).toBe(false);
  });
});
