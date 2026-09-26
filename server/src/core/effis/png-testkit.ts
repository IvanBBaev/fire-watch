/**
 * Test support for the PNG structural check (TASKS G4) — not imported by shipped code.
 *
 * Core tests may not import node:zlib (ADR-002 D7, enforced by dependency-cruiser), yet
 * they need real PNG files. zlib's *stored* block type (RFC 1951 §3.2.4, BTYPE 00) is a
 * valid deflate stream that needs no compression, so a few dozen lines give both an
 * encoder that any decoder accepts and an `Inflate` that the core tests can inject. The
 * adapter test proves node:zlib and this kit agree on the same bytes.
 */

import type { Inflate } from '../ports/inflate.js';
import { PNG_SIGNATURE, crc32, type PngColorType } from './png-structure.js';

const STORED_BLOCK_MAX = 0xffff;

/** A zlib stream of stored blocks, Adler-32 trailer included. */
export function zlibStored(raw: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(raw.byteLength / STORED_BLOCK_MAX));
  const out = new Uint8Array(2 + raw.byteLength + blockCount * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let block = 0; block < blockCount; block += 1) {
    const start = block * STORED_BLOCK_MAX;
    const part = raw.subarray(start, Math.min(raw.byteLength, start + STORED_BLOCK_MAX));
    const len = part.byteLength;
    out[at] = block === blockCount - 1 ? 1 : 0;
    out[at + 1] = len & 0xff;
    out[at + 2] = len >>> 8;
    out[at + 3] = ~len & 0xff;
    out[at + 4] = (~len >>> 8) & 0xff;
    out.set(part, at + 5);
    at += 5 + len;
  }
  writeUint32(out, at, adler32(raw));
  return out;
}

/** An `Inflate` that understands stored blocks only — which is all `zlibStored` makes. */
export const storedInflate: Inflate = (compressed, maxOutputBytes) => {
  if (compressed.byteLength < 6 || compressed[0] !== 0x78) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  let at = 2;
  for (;;) {
    const flags = compressed[at];
    if (flags === undefined || (flags & 0b110) !== 0) return null;
    const len = (compressed[at + 1] ?? 0) | ((compressed[at + 2] ?? 0) << 8);
    const nlen = (compressed[at + 3] ?? 0) | ((compressed[at + 4] ?? 0) << 8);
    if ((len ^ 0xffff) !== nlen || at + 5 + len > compressed.byteLength) return null;
    total += len;
    if (total > maxOutputBytes) return null;
    parts.push(compressed.subarray(at + 5, at + 5 + len));
    at += 5 + len;
    if ((flags & 1) === 1) break;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  if (at + 4 > compressed.byteLength || readUint32(compressed, at) !== adler32(out)) return null;
  return out;
};

export interface PngSpec {
  readonly width: number;
  readonly height: number;
  readonly colorType: PngColorType;
  readonly bitDepth: number;
  /** Samples per pixel, at full bit depth (palette index for colour type 3). */
  readonly pixel: (x: number, y: number) => readonly number[];
  readonly palette?: Uint8Array;
  readonly transparency?: Uint8Array;
  readonly interlaced?: boolean;
  /** Filter type per scanline (0–4); default 0. */
  readonly filter?: (row: number) => number;
  /** Split the image data over this many IDAT chunks; default 1. */
  readonly idatChunks?: number;
}

const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

const CHANNELS: Readonly<Record<PngColorType, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The raw (filtered, uncompressed) image stream for `spec`. */
export function pngImageData(spec: PngSpec): Uint8Array {
  const bits = CHANNELS[spec.colorType] * spec.bitDepth;
  const bpp = Math.max(1, Math.ceil(bits / 8));
  const passes = spec.interlaced === true ? ADAM7 : [[0, 0, 1, 1] as const];
  const rows: number[] = [];
  let rowIndex = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const width = spec.width > x0 ? Math.ceil((spec.width - x0) / dx) : 0;
    const height = spec.height > y0 ? Math.ceil((spec.height - y0) / dy) : 0;
    if (width === 0 || height === 0) continue;
    const stride = Math.ceil((width * bits) / 8);
    let previous = new Uint8Array(stride);
    for (let py = 0; py < height; py += 1) {
      const raw = new Uint8Array(stride);
      for (let px = 0; px < width; px += 1) {
        packPixel(raw, px, spec.pixel(x0 + px * dx, y0 + py * dy), spec.bitDepth, bits);
      }
      const filter = spec.filter?.(rowIndex) ?? 0;
      rows.push(filter, ...forwardFilter(filter, raw, previous, bpp));
      previous = raw;
      rowIndex += 1;
    }
  }
  return Uint8Array.from(rows);
}

export function encodePng(spec: PngSpec): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, spec.width);
  writeUint32(ihdr, 4, spec.height);
  ihdr[8] = spec.bitDepth;
  ihdr[9] = spec.colorType;
  ihdr[12] = spec.interlaced === true ? 1 : 0;
  const compressed = zlibStored(pngImageData(spec));
  const pieces = spec.idatChunks ?? 1;
  const size = Math.ceil(compressed.byteLength / pieces);
  const chunks: Uint8Array[] = [pngChunk('IHDR', ihdr)];
  if (spec.palette !== undefined) chunks.push(pngChunk('PLTE', spec.palette));
  if (spec.transparency !== undefined) chunks.push(pngChunk('tRNS', spec.transparency));
  for (let i = 0; i < pieces; i += 1) {
    chunks.push(pngChunk('IDAT', compressed.subarray(i * size, (i + 1) * size)));
  }
  chunks.push(pngChunk('IEND', new Uint8Array(0)));
  return concatBytes([Uint8Array.from(PNG_SIGNATURE), ...chunks]);
}

/** One chunk: length, type, data, CRC over type + data. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  writeUint32(out, 0, data.byteLength);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeUint32(out, 8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

export function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
}

function packPixel(
  row: Uint8Array,
  x: number,
  samples: readonly number[],
  bitDepth: number,
  bits: number,
): void {
  if (bitDepth < 8) {
    const bitOffset = x * bits;
    const shift = 8 - bitDepth - (bitOffset & 7);
    const index = bitOffset >> 3;
    row[index] = (row[index] ?? 0) | (((samples[0] ?? 0) & ((1 << bitDepth) - 1)) << shift);
    return;
  }
  const bytesPerSample = bitDepth / 8;
  const start = (x * bits) / 8;
  samples.forEach((sample, c) => {
    const at = start + c * bytesPerSample;
    if (bytesPerSample === 1) row[at] = sample & 0xff;
    else {
      row[at] = (sample >>> 8) & 0xff;
      row[at + 1] = sample & 0xff;
    }
  });
}

function forwardFilter(
  filter: number,
  raw: Uint8Array,
  previous: Uint8Array,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(raw.byteLength);
  for (let i = 0; i < raw.byteLength; i += 1) {
    const value = raw[i] ?? 0;
    const left = i >= bpp ? (raw[i - bpp] ?? 0) : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
    let predictor = 0;
    if (filter === 1) predictor = left;
    else if (filter === 2) predictor = up;
    else if (filter === 3) predictor = (left + up) >>> 1;
    else if (filter === 4) predictor = paeth(left, up, upLeft);
    out[i] = (value - predictor) & 0xff;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUint32(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) >>> 0) +
    ((bytes[at + 1] ?? 0) << 16) +
    ((bytes[at + 2] ?? 0) << 8) +
    (bytes[at + 3] ?? 0)
  );
}
