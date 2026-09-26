import { describe, expect, it } from 'vitest';

import {
  analysePngPixels,
  crc32,
  expectedRawBytes,
  hasPngSignature,
  readPngChunks,
  type PngChunks,
} from './png-structure.js';
import {
  asciiBytes,
  concatBytes,
  encodePng,
  pngChunk,
  pngImageData,
  storedInflate,
  type PngSpec,
} from './png-testkit.js';

const RGBA_SPEC: PngSpec = {
  width: 5,
  height: 3,
  colorType: 6,
  bitDepth: 8,
  pixel: (x, y) => [x * 40, y * 60, 7, x === 0 ? 0 : 255],
};

function chunksOf(bytes: Uint8Array): PngChunks {
  const result = readPngChunks(bytes);
  if (!result.ok) throw new Error(result.detail);
  return result.chunks;
}

function facts(spec: PngSpec): { uniform: boolean; transparentFraction: number } {
  const result = analysePngPixels(chunksOf(encodePng(spec)), storedInflate);
  if (!result.ok) throw new Error(result.detail);
  return result.facts;
}

/** Rewrites one byte and repairs nothing — the CRC must catch it. */
function flipByte(bytes: Uint8Array, at: number): Uint8Array {
  const copy = bytes.slice();
  copy[at] = (copy[at] ?? 0) ^ 0xff;
  return copy;
}

describe('crc32', () => {
  it('matches the reference check value for "123456789"', () => {
    expect(crc32(asciiBytes('123456789'))).toBe(0xcbf43926);
  });

  it('matches the CRC of a real IEND chunk', () => {
    expect(crc32(asciiBytes('IEND'))).toBe(0xae426082);
  });
});

describe('readPngChunks', () => {
  it('reads the header, palette and transparency of a well-formed file', () => {
    const chunks = chunksOf(
      encodePng({
        width: 4,
        height: 2,
        colorType: 3,
        bitDepth: 2,
        pixel: (x) => [x % 3],
        palette: Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 255, 0]),
        transparency: Uint8Array.from([0]),
      }),
    );
    expect(chunks.header).toEqual({
      width: 4,
      height: 2,
      bitDepth: 2,
      colorType: 3,
      interlaced: false,
    });
    expect(chunks.palette?.byteLength).toBe(9);
    expect(chunks.transparency).toEqual(Uint8Array.from([0]));
  });

  it('concatenates consecutive IDAT chunks into one stream', () => {
    const whole = chunksOf(encodePng(RGBA_SPEC));
    const split = chunksOf(encodePng({ ...RGBA_SPEC, idatChunks: 3 }));
    expect(split.compressed).toEqual(whole.compressed);
  });

  it('reports a missing signature as its own problem', () => {
    const result = readPngChunks(asciiBytes('<?xml version="1.0"?><ServiceExceptionReport/>'));
    expect(result).toMatchObject({ ok: false, problem: 'signature' });
    expect(hasPngSignature(new Uint8Array(4))).toBe(false);
  });

  it.each([
    ['a CRC mismatch', (png: Uint8Array) => flipByte(png, 20), /CRC mismatch in IHDR/],
    [
      'truncation mid-chunk',
      (png: Uint8Array) => png.subarray(0, png.byteLength - 20),
      /past the end|truncated/,
    ],
    [
      'truncation before IEND',
      (png: Uint8Array) => png.subarray(0, png.byteLength - 12),
      /no IEND/,
    ],
  ])('rejects %s as a structure problem', (_name, mutate, detail) => {
    const result = readPngChunks(mutate(encodePng(RGBA_SPEC)));
    expect(result).toMatchObject({ ok: false, problem: 'structure' });
    if (!result.ok) expect(result.detail).toMatch(detail);
  });

  it('tolerates bytes after IEND and unknown ancillary chunks', () => {
    const png = encodePng(RGBA_SPEC);
    const withText = concatBytes([
      png.subarray(0, 33),
      pngChunk('tEXt', asciiBytes('Comment\0hello')),
      png.subarray(33),
      asciiBytes('trailing garbage'),
    ]);
    expect(readPngChunks(withText).ok).toBe(true);
  });

  it('refuses an unknown critical chunk', () => {
    const png = encodePng(RGBA_SPEC);
    const withCritical = concatBytes([
      png.subarray(0, 33),
      pngChunk('ABCD', new Uint8Array(1)),
      png.subarray(33),
    ]);
    expect(readPngChunks(withCritical)).toMatchObject({ ok: false, problem: 'structure' });
  });

  it.each([
    ['a colour type that does not exist', { colorType: 5 as never }],
    ['a bit depth the colour type forbids', { colorType: 2 as const, bitDepth: 4 }],
  ])('refuses an IHDR with %s', (_name, override) => {
    const result = readPngChunks(encodePng({ ...RGBA_SPEC, ...override, pixel: () => [0] }));
    expect(result).toMatchObject({ ok: false, problem: 'structure' });
  });

  it('refuses a palette image without PLTE', () => {
    const result = readPngChunks(
      encodePng({ width: 2, height: 2, colorType: 3, bitDepth: 8, pixel: () => [0] }),
    );
    expect(result).toMatchObject({ ok: false, detail: 'palette image without PLTE' });
  });

  it('refuses tRNS on a colour type that has its own alpha', () => {
    const result = readPngChunks(
      encodePng({ ...RGBA_SPEC, transparency: Uint8Array.from([0, 0]) }),
    );
    expect(result).toMatchObject({ ok: false, problem: 'structure' });
  });
});

describe('expectedRawBytes', () => {
  it('counts one filter byte per scanline plus packed samples', () => {
    expect(expectedRawBytes(chunksOf(encodePng(RGBA_SPEC)).header)).toBe(3 * (1 + 5 * 4));
  });

  it('counts every Adam7 pass, skipping empty ones', () => {
    const spec: PngSpec = { ...RGBA_SPEC, interlaced: true };
    expect(expectedRawBytes(chunksOf(encodePng(spec)).header)).toBe(pngImageData(spec).byteLength);
  });
});

describe('analysePngPixels', () => {
  it('reports the transparent share of an RGBA image', () => {
    // Column 0 is transparent: 3 of 15 pixels.
    expect(facts(RGBA_SPEC)).toEqual({ uniform: false, transparentFraction: 0.2 });
  });

  it.each([0, 1, 2, 3, 4])('reverses scanline filter type %i', (filter) => {
    expect(facts({ ...RGBA_SPEC, height: 4, filter: () => filter })).toEqual({
      uniform: false,
      transparentFraction: 0.2,
    });
  });

  it('reads an interlaced image the same as the progressive one', () => {
    const spec: PngSpec = { ...RGBA_SPEC, width: 11, height: 9, filter: (row) => row % 5 };
    expect(facts({ ...spec, interlaced: true })).toEqual(facts(spec));
  });

  it('calls a single-colour opaque image uniform with nothing transparent', () => {
    expect(facts({ ...RGBA_SPEC, pixel: () => [255, 255, 255, 255] })).toEqual({
      uniform: true,
      transparentFraction: 0,
    });
  });

  it('calls an all-alpha-zero image fully transparent', () => {
    expect(facts({ ...RGBA_SPEC, pixel: () => [0, 0, 0, 0] }).transparentFraction).toBe(1);
  });

  it('reads palette transparency through tRNS at sub-byte depth', () => {
    const result = facts({
      width: 7,
      height: 3,
      colorType: 3,
      bitDepth: 1,
      pixel: (x) => [x < 5 ? 0 : 1],
      palette: Uint8Array.from([0, 0, 0, 255, 128, 0]),
      transparency: Uint8Array.from([0]),
    });
    expect(result.uniform).toBe(false);
    expect(result.transparentFraction).toBeCloseTo(15 / 21);
  });

  it('reads the greyscale and truecolour tRNS colour keys, 16-bit included', () => {
    const grey = facts({
      width: 4,
      height: 1,
      colorType: 0,
      bitDepth: 16,
      pixel: (x) => [x === 0 ? 0x1234 : 0xffff],
      transparency: Uint8Array.from([0x12, 0x34]),
    });
    expect(grey.transparentFraction).toBe(0.25);
    const rgb = facts({
      width: 2,
      height: 2,
      colorType: 2,
      bitDepth: 8,
      pixel: (x) => (x === 0 ? [1, 2, 3] : [9, 9, 9]),
      transparency: Uint8Array.from([0, 1, 0, 2, 0, 3]),
    });
    expect(rgb.transparentFraction).toBe(0.5);
  });

  it('reads alpha from 16-bit grey+alpha', () => {
    const result = facts({
      width: 2,
      height: 1,
      colorType: 4,
      bitDepth: 16,
      pixel: (x) => [500, x === 0 ? 0 : 1],
    });
    expect(result).toEqual({ uniform: false, transparentFraction: 0.5 });
  });

  it('treats an image with no alpha and no tRNS as never transparent', () => {
    expect(
      facts({ width: 3, height: 3, colorType: 0, bitDepth: 4, pixel: (x) => [x] })
        .transparentFraction,
    ).toBe(0);
  });

  it('fails when the image data inflates to the wrong size', () => {
    const png = encodePng(RGBA_SPEC);
    const chunks = chunksOf(png);
    const lying = { ...chunks, header: { ...chunks.header, height: 2 } };
    expect(analysePngPixels(lying, storedInflate)).toMatchObject({ ok: false });
    const taller = { ...chunks, header: { ...chunks.header, height: 4 } };
    expect(analysePngPixels(taller, storedInflate)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('inflates to 63 bytes, expected 84') as unknown,
    });
  });

  it('fails when the image data does not inflate at all', () => {
    const chunks = chunksOf(encodePng(RGBA_SPEC));
    expect(analysePngPixels(chunks, () => null)).toMatchObject({ ok: false });
  });

  it('fails on an unknown filter type', () => {
    expect(facts.bind(null, { ...RGBA_SPEC, filter: () => 5 })).toThrow(
      /unknown scanline filter type 5/,
    );
  });
});
