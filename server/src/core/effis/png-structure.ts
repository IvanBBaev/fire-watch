/**
 * Structural facts about a PNG body, for the EFFIS content-sanity classifier (TASKS G4;
 * ADR-001 A1.2/A2.2).
 *
 * This is the refresh job's decoder, not the proxy's: A2.2 forbids image decoding *in
 * the proxy path* (the request handler serves a file and judges nothing), and the
 * refresh cycle is where a body is judged before it may become that file. Decoding
 * here costs one inflate per layer per refresh — every six hours — and buys the two
 * facts headers and byte length cannot give: whether the raster is the size we asked
 * for, and whether it carries any picture at all.
 *
 * Pure: the one step that needs a platform library (zlib inflate) arrives as an
 * injected function, so the core stays free of node builtins (ADR-002 D7) and the
 * tests can hand in a dependency-free inflater.
 *
 * Deliberately a validator, not a general decoder: it reads the chunks it needs
 * (IHDR, PLTE, tRNS, IDAT, IEND), checks every CRC, reverses the five scanline filters
 * and reports facts. It never produces an image, and it never trusts a length field
 * before bounds-checking it.
 */

import type { Inflate } from '../ports/inflate.js';

export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type PngColorType = 0 | 2 | 3 | 4 | 6;

export interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: PngColorType;
  readonly interlaced: boolean;
}

export interface PngChunks {
  readonly header: PngHeader;
  /** RGB triples, or `null` when the file has no PLTE chunk. */
  readonly palette: Uint8Array | null;
  /** The tRNS chunk body verbatim, or `null` when absent. */
  readonly transparency: Uint8Array | null;
  /** Every IDAT body, concatenated in file order — one zlib stream. */
  readonly compressed: Uint8Array;
}

export type PngChunksResult =
  | { readonly ok: true; readonly chunks: PngChunks }
  | {
      readonly ok: false;
      readonly problem: 'signature' | 'structure';
      readonly detail: string;
    };

export interface PngPixelFacts {
  /** Every pixel carries the same value (colour and alpha alike). */
  readonly uniform: boolean;
  /**
   * Share of pixels whose alpha is zero, in [0, 1]. `0` for an image that cannot carry
   * transparency (no alpha channel and no tRNS chunk).
   */
  readonly transparentFraction: number;
}

export type PngPixelsResult =
  | { readonly ok: true; readonly facts: PngPixelFacts }
  | { readonly ok: false; readonly detail: string };

/** Bit depths the PNG spec allows per colour type (PNG §11.2.2, table 11.1). */
const ALLOWED_BIT_DEPTHS: Readonly<Record<PngColorType, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

const CHANNELS: Readonly<Record<PngColorType, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The spec's own ceiling for a width, height or chunk length. */
const PNG_INT_MAX = 0x7fffffff;

/** Adam7 passes as [x0, y0, dx, dy] (PNG §8.2). */
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/**
 * Walks the chunk list. Structural failures are values, never exceptions: a malformed
 * body is the routine input of this module, not an error in it. Bytes after IEND are
 * tolerated — they do not change the image a decoder would show.
 */
export function readPngChunks(bytes: Uint8Array): PngChunksResult {
  if (!hasPngSignature(bytes)) {
    return {
      ok: false,
      problem: 'signature',
      detail: 'body does not start with the PNG signature',
    };
  }
  const bad = (detail: string): PngChunksResult => ({ ok: false, problem: 'structure', detail });

  let offset = PNG_SIGNATURE.length;
  let header: PngHeader | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatClosed = false;
  let sawIend = false;

  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12)
      return bad(`truncated chunk header at byte ${String(offset)}`);
    const length = readUint32(bytes, offset);
    if (length > PNG_INT_MAX) return bad(`chunk length ${String(length)} exceeds 2^31-1`);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.byteLength) {
      return bad(`chunk at byte ${String(offset)} runs past the end of the body`);
    }
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const expectedCrc = readUint32(bytes, dataEnd);
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== expectedCrc) {
      return bad(`CRC mismatch in ${type} chunk at byte ${String(offset)}`);
    }
    const data = bytes.subarray(dataStart, dataEnd);

    if (header === null && type !== 'IHDR') return bad(`first chunk is ${type}, not IHDR`);
    if (type !== 'IDAT' && idat.length > 0) idatClosed = true;

    switch (type) {
      case 'IHDR': {
        if (header !== null) return bad('second IHDR chunk');
        const parsed = parseHeader(data);
        if (typeof parsed === 'string') return bad(parsed);
        header = parsed;
        break;
      }
      case 'PLTE':
        if (length === 0 || length % 3 !== 0 || length / 3 > 256) {
          return bad(`PLTE length ${String(length)} is not 1–256 RGB entries`);
        }
        palette = data;
        break;
      case 'tRNS':
        transparency = data;
        break;
      case 'IDAT':
        if (idatClosed) return bad('IDAT chunks are not consecutive');
        idat.push(data);
        break;
      case 'IEND':
        sawIend = true;
        break;
      default:
        // Ancillary chunks (tEXt, pHYs, …) carry nothing this validator judges. A critical
        // chunk we do not know (uppercase first letter) means a decoder must refuse the
        // file, so we do too.
        if (isCritical(type)) return bad(`unknown critical chunk ${type}`);
    }
    offset = dataEnd + 4;
    if (sawIend) break;
  }

  if (header === null) return bad('no IHDR chunk');
  if (!sawIend) return bad('no IEND chunk — body is truncated');
  if (idat.length === 0) return bad('no IDAT chunk');
  if (header.colorType === 3 && palette === null) return bad('palette image without PLTE');
  const trnsProblem = transparencyProblem(header, palette, transparency);
  if (trnsProblem !== null) return bad(trnsProblem);

  return {
    ok: true,
    chunks: { header, palette, transparency, compressed: concat(idat) },
  };
}

/** The exact inflated size a well-formed image stream has (filter bytes included). */
export function expectedRawBytes(header: PngHeader): number {
  let total = 0;
  for (const pass of passes(header)) {
    if (pass.width === 0 || pass.height === 0) continue;
    total += pass.height * (1 + rowBytes(header, pass.width));
  }
  return total;
}

/**
 * Inflates, un-filters and reads every pixel once. `inflate` is capped at the exact
 * expected size, so a decompression bomb costs at most one image's worth of memory.
 */
export function analysePngPixels(chunks: PngChunks, inflate: Inflate): PngPixelsResult {
  const { header } = chunks;
  const expected = expectedRawBytes(header);
  const raw = inflate(chunks.compressed, expected);
  if (raw === null) {
    return {
      ok: false,
      detail: `image data does not inflate to ${String(expected)} bytes or fewer`,
    };
  }
  if (raw.byteLength !== expected) {
    return {
      ok: false,
      detail: `image data inflates to ${String(raw.byteLength)} bytes, expected ${String(expected)}`,
    };
  }

  const bits = bitsPerPixel(header);
  const filterStride = Math.max(1, Math.ceil(bits / 8));
  const alphaOf = alphaReader(chunks);
  let first: number[] | null = null;
  let uniform = true;
  let transparent = 0;
  let offset = 0;

  for (const pass of passes(header)) {
    if (pass.width === 0 || pass.height === 0) continue;
    const stride = rowBytes(header, pass.width);
    let previous = new Uint8Array(stride);
    for (let y = 0; y < pass.height; y += 1) {
      const filter = raw[offset] ?? -1;
      const row = raw.slice(offset + 1, offset + 1 + stride);
      offset += 1 + stride;
      if (!unfilter(filter, row, previous, filterStride)) {
        return { ok: false, detail: `unknown scanline filter type ${String(filter)}` };
      }
      for (let x = 0; x < pass.width; x += 1) {
        const pixel = pixelSamples(row, x, header, bits);
        if (first === null) first = pixel;
        else if (uniform && !sameSamples(first, pixel)) uniform = false;
        if (alphaOf(pixel) === 0) transparent += 1;
      }
      previous = row;
    }
  }

  const total = header.width * header.height;
  return { ok: true, facts: { uniform, transparentFraction: transparent / total } };
}

/** CRC-32 as PNG uses it (ISO 3309 / ITU-T V.42, reflected, init and xorout 0xFFFFFFFF). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_unused, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function parseHeader(data: Uint8Array): PngHeader | string {
  if (data.byteLength !== 13) return `IHDR length ${String(data.byteLength)}, expected 13`;
  const width = readUint32(data, 0);
  const height = readUint32(data, 4);
  const bitDepth = data[8] ?? 0;
  const colorType = data[9] ?? 0;
  if (width === 0 || height === 0 || width > PNG_INT_MAX || height > PNG_INT_MAX) {
    return `IHDR size ${String(width)}×${String(height)} is out of range`;
  }
  if (!isColorType(colorType)) return `IHDR colour type ${String(colorType)} is not defined`;
  if (!ALLOWED_BIT_DEPTHS[colorType].includes(bitDepth)) {
    return `IHDR bit depth ${String(bitDepth)} is not allowed for colour type ${String(colorType)}`;
  }
  if (data[10] !== 0) return `IHDR compression method ${String(data[10])} is not 0`;
  if (data[11] !== 0) return `IHDR filter method ${String(data[11])} is not 0`;
  const interlace = data[12];
  if (interlace !== 0 && interlace !== 1) return `IHDR interlace method ${String(interlace)}`;
  return { width, height, bitDepth, colorType, interlaced: interlace === 1 };
}

function transparencyProblem(
  header: PngHeader,
  palette: Uint8Array | null,
  transparency: Uint8Array | null,
): string | null {
  if (transparency === null) return null;
  const length = transparency.byteLength;
  switch (header.colorType) {
    case 0:
      return length === 2 ? null : `tRNS length ${String(length)} for greyscale, expected 2`;
    case 2:
      return length === 6 ? null : `tRNS length ${String(length)} for truecolour, expected 6`;
    case 3:
      return palette !== null && length <= palette.byteLength / 3
        ? null
        : `tRNS has more entries than the palette`;
    default:
      return `tRNS is not allowed for colour type ${String(header.colorType)}`;
  }
}

interface Pass {
  readonly width: number;
  readonly height: number;
}

function passes(header: PngHeader): readonly Pass[] {
  if (!header.interlaced) return [{ width: header.width, height: header.height }];
  return ADAM7.map(([x0, y0, dx, dy]) => ({
    width: header.width > x0 ? Math.ceil((header.width - x0) / dx) : 0,
    height: header.height > y0 ? Math.ceil((header.height - y0) / dy) : 0,
  }));
}

function bitsPerPixel(header: PngHeader): number {
  return CHANNELS[header.colorType] * header.bitDepth;
}

function rowBytes(header: PngHeader, width: number): number {
  return Math.ceil((width * bitsPerPixel(header)) / 8);
}

/** Reverses one scanline's filter in place (PNG §9). `false` for an unknown filter type. */
function unfilter(filter: number, row: Uint8Array, previous: Uint8Array, bpp: number): boolean {
  const n = row.byteLength;
  switch (filter) {
    case 0:
      return true;
    case 1:
      for (let i = bpp; i < n; i += 1) row[i] = ((row[i] ?? 0) + (row[i - bpp] ?? 0)) & 0xff;
      return true;
    case 2:
      for (let i = 0; i < n; i += 1) row[i] = ((row[i] ?? 0) + (previous[i] ?? 0)) & 0xff;
      return true;
    case 3:
      for (let i = 0; i < n; i += 1) {
        const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
        row[i] = ((row[i] ?? 0) + ((left + (previous[i] ?? 0)) >>> 1)) & 0xff;
      }
      return true;
    case 4:
      for (let i = 0; i < n; i += 1) {
        const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
        const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
        row[i] = ((row[i] ?? 0) + paeth(left, previous[i] ?? 0, upLeft)) & 0xff;
      }
      return true;
    default:
      return false;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** One pixel as its samples, each at full bit depth (16-bit samples as one number). */
function pixelSamples(row: Uint8Array, x: number, header: PngHeader, bits: number): number[] {
  const channels = CHANNELS[header.colorType];
  if (header.bitDepth < 8) {
    // Sub-byte depths occur only with one channel: greyscale or palette index.
    const bitOffset = x * bits;
    const byte = row[bitOffset >> 3] ?? 0;
    const shift = 8 - header.bitDepth - (bitOffset & 7);
    return [(byte >> shift) & ((1 << header.bitDepth) - 1)];
  }
  const bytesPerSample = header.bitDepth / 8;
  const start = x * channels * bytesPerSample;
  const samples: number[] = [];
  for (let c = 0; c < channels; c += 1) {
    const at = start + c * bytesPerSample;
    samples.push(
      bytesPerSample === 1 ? (row[at] ?? 0) : ((row[at] ?? 0) << 8) | (row[at + 1] ?? 0),
    );
  }
  return samples;
}

function sameSamples(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Alpha per pixel, where the format has one: the alpha sample for GA/RGBA, the tRNS
 * table for palette images, the tRNS colour key for greyscale/truecolour. A value of
 * exactly 0 is the only thing the caller asks about, so non-zero values are not scaled.
 */
function alphaReader(chunks: PngChunks): (pixel: readonly number[]) => number {
  const { header, transparency } = chunks;
  switch (header.colorType) {
    case 4:
      return (pixel) => pixel[1] ?? 1;
    case 6:
      return (pixel) => pixel[3] ?? 1;
    case 3:
      return (pixel) => (transparency === null ? 1 : (transparency[pixel[0] ?? 0] ?? 0xff));
    case 0: {
      if (transparency === null) return () => 1;
      const key = readUint16(transparency, 0);
      return (pixel) => (pixel[0] === key ? 0 : 1);
    }
    case 2: {
      if (transparency === null) return () => 1;
      const key = [
        readUint16(transparency, 0),
        readUint16(transparency, 2),
        readUint16(transparency, 4),
      ];
      return (pixel) => (sameSamples(key, pixel) ? 0 : 1);
    }
  }
}

function isColorType(value: number): value is PngColorType {
  return value === 0 || value === 2 || value === 3 || value === 4 || value === 6;
}

/** Bit 5 of the first type byte clear = critical (PNG §5.4). */
function isCritical(type: string): boolean {
  return (type.charCodeAt(0) & 0x20) === 0;
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) >>> 0) +
    ((bytes[at + 1] ?? 0) << 16) +
    ((bytes[at + 2] ?? 0) << 8) +
    (bytes[at + 3] ?? 0)
  );
}

function readUint16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
