/**
 * A bounded bzip2 decompressor for the sandboxed granule decoder (TASKS C3a).
 *
 * LSA SAF ships its HDF5 granules as `.bz2`, and Node has no bzip2. This module runs
 * **inside** the child process behind the wall, so the decompressor is as contained as
 * libhdf5 is: a bug here, or a hostile stream, costs one child and one granule.
 *
 * **Why not a library.** The pure-JavaScript candidates were evaluated for C3a and none
 * was acceptable for untrusted input (the evaluation is in
 * `docs/spikes/c3a-granule-decode.md`). The deciding defect in the most-used one,
 * `seek-bzip`, is that a stream cut off after its last complete block — missing the
 * end-of-stream marker and the stream CRC — decodes "successfully"; it also reads past
 * the end of its input as zero bits and prints a `Buffer()` deprecation warning on every
 * run. This file is the same algorithm (Seward's bzip2 1.0.x, by way of Landley's
 * micro-bunzip) written against the limits the wall needs.
 *
 * **What it guarantees, beyond decoding:**
 *
 * - **Bounded output.** The caller gives an absolute byte cap and a ratio cap. Both are
 *   checked *before* each run is written, so a bomb is stopped at the cap, not after it
 *   has been materialised. The output buffer grows by doubling up to the cap; the cap is
 *   never pre-allocated.
 * - **Bounded work per block.** The block buffer is sized from the stream header
 *   (100 000 × level), every write into it is range-checked, and a run length that would
 *   overflow it is refused before the run is expanded.
 * - **Nothing silently accepted.** Every block CRC and every stream CRC is checked. Input
 *   that ends before the end-of-stream marker is `truncated`, whatever block boundary it
 *   ends on. Bytes after the last stream that are not another stream are refused.
 * - **Multistream, as `bzip2 -d` does it.** Concatenated streams (`cat a.bz2 b.bz2`, or
 *   what `pbzip2` writes) decode to the concatenation of their contents. Each stream is
 *   verified on its own CRC and all of them count against the same caps.
 * - **No obsolete modes.** Randomised blocks (written only by bzip2 < 0.9.5, before
 *   1999) are refused rather than supported.
 *
 * Self-contained: no imports at all, so the child can load it under the Node permission
 * model with read access to this one file.
 */

/** Why a stream was not decoded. `too-large` is the only one that is not the stream's fault alone. */
export type Bunzip2ErrorCode = 'not-bzip2' | 'truncated' | 'corrupt' | 'unsupported' | 'too-large';

export class Bunzip2Error extends Error {
  readonly code: Bunzip2ErrorCode;

  constructor(code: Bunzip2ErrorCode, message: string) {
    super(message);
    this.name = 'Bunzip2Error';
    this.code = code;
  }
}

export interface Bunzip2Limits {
  /** Hard ceiling on decompressed bytes, across all streams. */
  readonly maxOutputBytes: number;
  /**
   * Ceiling on decompressed ÷ compressed size. Enforced only above
   * {@link Bunzip2Limits.ratioFloorBytes}, so a tiny honest file with a high ratio (an
   * HDF5 file is mostly zero padding) is not refused for it.
   */
  readonly maxRatio: number;
  /** Output below this size is never refused on ratio. */
  readonly ratioFloorBytes: number;
}

/** The effective byte ceiling for an input of `inputBytes` under `limits`. */
export function outputCeiling(inputBytes: number, limits: Bunzip2Limits): number {
  const byRatio = Math.max(limits.ratioFloorBytes, inputBytes * limits.maxRatio);
  return Math.min(limits.maxOutputBytes, byRatio);
}

const BLOCK_MAGIC_HI = 0x314159;
const BLOCK_MAGIC_LO = 0x265359;
const END_MAGIC_HI = 0x177245;
const END_MAGIC_LO = 0x385090;

const MAX_GROUPS = 6;
const MIN_GROUPS = 2;
const GROUP_SIZE = 50;
const MAX_CODE_LEN = 20;
const MAX_ALPHA_SIZE = 258;
/**
 * bzip2 1.0.8 reads up to 32 767 selectors but keeps only this many (CVE-2019-12900 was
 * a write past a smaller array; 1.0.7's refusal of the excess then broke lbzip2 files).
 * Same here: the excess is read and dropped.
 */
const MAX_SELECTORS = 18_002;
const RUN_A = 0;
const RUN_B = 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i << 24;
    for (let k = 0; k < 8; k += 1) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** MSB-first bit reader that refuses to read past the end of its input. */
class BitReader {
  private readonly bytes: Uint8Array;
  private pos = 0;
  private buffer = 0;
  private count = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** Up to 24 bits. */
  bits(n: number): number {
    while (this.count < n) {
      if (this.pos >= this.bytes.length) {
        throw new Bunzip2Error('truncated', 'bzip2 stream ends before its end-of-stream marker');
      }
      this.buffer = ((this.buffer << 8) | (this.bytes[this.pos] ?? 0)) & 0xffffffff;
      this.pos += 1;
      this.count += 8;
    }
    this.count -= n;
    return (this.buffer >>> this.count) & ((1 << n) - 1);
  }

  bit(): number {
    return this.bits(1);
  }

  uint32(): number {
    return ((this.bits(16) << 16) | this.bits(16)) >>> 0;
  }

  /** Drop the bits left in the current byte; return the index of the next whole byte. */
  alignToByte(): number {
    this.count -= this.count % 8;
    const next = this.pos - this.count / 8;
    this.pos = next;
    this.buffer = 0;
    this.count = 0;
    return next;
  }

  get byteLength(): number {
    return this.bytes.length;
  }
}

/** A growable output that refuses to grow past its ceiling. */
class Output {
  private readonly ceiling: number;
  private readonly describeCeiling: () => string;
  private buffer: Uint8Array;
  length = 0;

  constructor(ceiling: number, describeCeiling: () => string, initial: number) {
    this.ceiling = ceiling;
    this.describeCeiling = describeCeiling;
    this.buffer = new Uint8Array(Math.max(1, Math.min(ceiling, initial)));
  }

  /** Reserve room for `n` more bytes, or refuse. */
  reserve(n: number): void {
    const needed = this.length + n;
    if (needed > this.ceiling) {
      throw new Bunzip2Error('too-large', this.describeCeiling());
    }
    if (needed <= this.buffer.length) return;
    let size = this.buffer.length;
    while (size < needed) size *= 2;
    const grown = new Uint8Array(Math.min(size, this.ceiling));
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  push(byte: number): void {
    this.buffer[this.length] = byte;
    this.length += 1;
  }

  fill(byte: number, n: number): void {
    this.buffer.fill(byte, this.length, this.length + n);
    this.length += n;
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/** True when `bytes` starts like a bzip2 stream (`BZh1`–`BZh9`). */
export function isBzip2(bytes: Uint8Array, at = 0): boolean {
  if (bytes.length < at + 4) return false;
  const level = bytes[at + 3] ?? 0;
  return (
    bytes[at] === 0x42 &&
    bytes[at + 1] === 0x5a &&
    bytes[at + 2] === 0x68 &&
    level >= 0x31 &&
    level <= 0x39
  );
}

/**
 * Decompress a whole `.bz2` buffer, every concatenated stream of it, within `limits`.
 * Throws {@link Bunzip2Error} for anything it does not decode; nothing else is expected
 * to escape (a `RangeError` from the host running out of memory would be the exception).
 */
export function bunzip2(input: Uint8Array, limits: Bunzip2Limits): Uint8Array {
  if (!isBzip2(input)) {
    throw new Bunzip2Error('not-bzip2', 'input does not start with a bzip2 stream header (BZh1-9)');
  }
  const ceiling = outputCeiling(input.length, limits);
  const out = new Output(
    ceiling,
    () =>
      ceiling === limits.maxOutputBytes
        ? `bzip2 output exceeds the ${String(limits.maxOutputBytes)}-byte cap`
        : `bzip2 output exceeds ${String(limits.maxRatio)}x the ${String(input.length)}-byte input`,
    input.length * 4,
  );

  let offset = 0;
  let streams = 0;
  while (offset < input.length) {
    if (!isBzip2(input, offset)) {
      throw new Bunzip2Error(
        'corrupt',
        `${String(input.length - offset)} trailing bytes after bzip2 stream ${String(streams)} are not another stream`,
      );
    }
    offset += decodeStream(input.subarray(offset), out);
    streams += 1;
  }
  return out.result();
}

/** One stream from its `BZh` header to its end-of-stream CRC. Returns the bytes consumed. */
function decodeStream(input: Uint8Array, out: Output): number {
  const level = (input[3] ?? 0) - 0x30;
  const blockMax = level * 100_000;
  const reader = new BitReader(input.subarray(4));
  const tt = new Uint32Array(blockMax);
  let combined = 0;

  for (;;) {
    const hi = reader.bits(24);
    const lo = reader.bits(24);
    if (hi === END_MAGIC_HI && lo === END_MAGIC_LO) {
      const stored = reader.uint32();
      if (stored !== combined) {
        throw new Bunzip2Error('corrupt', 'bzip2 stream CRC does not match its blocks');
      }
      return 4 + reader.alignToByte();
    }
    if (hi !== BLOCK_MAGIC_HI || lo !== BLOCK_MAGIC_LO) {
      throw new Bunzip2Error('corrupt', 'bzip2 block header magic is wrong');
    }
    const blockCrc = decodeBlock(reader, tt, blockMax, out);
    combined = (((combined << 1) | (combined >>> 31)) ^ blockCrc) >>> 0;
  }
}

/** One block: Huffman → MTF/RLE2 → inverse BWT → RLE1 → `out`. Returns its verified CRC. */
function decodeBlock(reader: BitReader, tt: Uint32Array, blockMax: number, out: Output): number {
  const storedCrc = reader.uint32();
  if (reader.bit() !== 0) {
    throw new Bunzip2Error('unsupported', 'randomised bzip2 blocks (pre-0.9.5) are not supported');
  }
  const origPtr = reader.bits(24);

  // The symbol map: which of the 256 byte values occur in this block.
  const seqToUnseq = new Uint8Array(256);
  let inUse = 0;
  const used16 = reader.bits(16);
  for (let i = 0; i < 16; i += 1) {
    if (used16 & (0x8000 >>> i)) {
      const bits = reader.bits(16);
      for (let j = 0; j < 16; j += 1) {
        if (bits & (0x8000 >>> j)) seqToUnseq[inUse++] = i * 16 + j;
      }
    }
  }
  if (inUse === 0) throw new Bunzip2Error('corrupt', 'bzip2 block uses no symbols');
  const alphaSize = inUse + 2;

  const groups = reader.bits(3);
  if (groups < MIN_GROUPS || groups > MAX_GROUPS) {
    throw new Bunzip2Error('corrupt', `bzip2 block has ${String(groups)} Huffman groups`);
  }
  const selectorsDeclared = reader.bits(15);
  if (selectorsDeclared < 1) throw new Bunzip2Error('corrupt', 'bzip2 block has no selectors');

  const groupMtf = [0, 1, 2, 3, 4, 5].slice(0, groups);
  const selectorCount = Math.min(selectorsDeclared, MAX_SELECTORS);
  const selectors = new Uint8Array(selectorCount);
  for (let i = 0; i < selectorsDeclared; i += 1) {
    let j = 0;
    while (reader.bit()) {
      j += 1;
      if (j >= groups) throw new Bunzip2Error('corrupt', 'bzip2 selector out of range');
    }
    const value = groupMtf[j] ?? 0;
    groupMtf.splice(j, 1);
    groupMtf.unshift(value);
    if (i < selectorCount) selectors[i] = value;
  }

  const tables: HuffmanTable[] = [];
  for (let g = 0; g < groups; g += 1) {
    const lengths = new Uint8Array(alphaSize);
    let current = reader.bits(5);
    for (let s = 0; s < alphaSize; s += 1) {
      for (;;) {
        if (current < 1 || current > MAX_CODE_LEN) {
          throw new Bunzip2Error('corrupt', 'bzip2 Huffman code length out of range');
        }
        if (!reader.bit()) break;
        current += reader.bit() ? -1 : 1;
      }
      lengths[s] = current;
    }
    tables.push(huffmanTable(lengths, alphaSize));
  }

  // Huffman + MTF + RLE2 into tt[0..nblock).
  const mtf = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) mtf[i] = i;
  const counts = new Uint32Array(256);
  const endOfBlock = inUse + 1;
  let nblock = 0;
  let selectorIndex = 0;
  let groupLeft = 0;
  let table: HuffmanTable | undefined;
  let runLength = 0;
  let runWeight = 1;

  const nextSymbol = (): number => {
    if (groupLeft === 0) {
      if (selectorIndex >= selectorCount) {
        throw new Bunzip2Error('corrupt', 'bzip2 block runs past its selectors');
      }
      table = tables[selectors[selectorIndex++] ?? 0];
      groupLeft = GROUP_SIZE;
    }
    groupLeft -= 1;
    return decodeSymbol(reader, table as HuffmanTable);
  };

  for (;;) {
    const symbol = nextSymbol();
    if (symbol === RUN_A || symbol === RUN_B) {
      // Bijective base-2 run length: RUNA adds 1×weight, RUNB 2×weight.
      if (runWeight > blockMax) throw new Bunzip2Error('corrupt', 'bzip2 run length overflows');
      runLength += (symbol + 1) * runWeight;
      runWeight *= 2;
      continue;
    }
    if (runLength > 0) {
      if (nblock + runLength > blockMax) {
        throw new Bunzip2Error('corrupt', 'bzip2 run overflows its block');
      }
      const byte = seqToUnseq[mtf[0] ?? 0] ?? 0;
      counts[byte] = (counts[byte] ?? 0) + runLength;
      tt.fill(byte, nblock, nblock + runLength);
      nblock += runLength;
      runLength = 0;
      runWeight = 1;
    }
    if (symbol === endOfBlock) break;
    if (symbol > endOfBlock) throw new Bunzip2Error('corrupt', 'bzip2 symbol out of range');
    if (nblock >= blockMax) throw new Bunzip2Error('corrupt', 'bzip2 block overflows');
    // Literal: move-to-front position symbol-1.
    const index = symbol - 1;
    const value = mtf[index] ?? 0;
    mtf.copyWithin(1, 0, index);
    mtf[0] = value;
    const byte = seqToUnseq[value] ?? 0;
    counts[byte] = (counts[byte] ?? 0) + 1;
    tt[nblock++] = byte;
  }

  if (origPtr >= nblock) {
    throw new Bunzip2Error('corrupt', 'bzip2 block origin pointer is out of range');
  }

  // Inverse BWT: link each position to its successor, packed above the byte.
  let sum = 0;
  const starts = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    starts[i] = sum;
    sum += counts[i] ?? 0;
  }
  for (let i = 0; i < nblock; i += 1) {
    const byte = (tt[i] ?? 0) & 0xff;
    const at = starts[byte] ?? 0;
    tt[at] = (tt[at] ?? 0) | (i << 8);
    starts[byte] = at + 1;
  }

  // Walk the chain, undoing RLE1 (four equal bytes, then a count of 0-255 more).
  let crc = 0xffffffff;
  let pos = (tt[origPtr] ?? 0) >>> 8;
  let last = -1;
  let same = 0;
  for (let emitted = 0; emitted < nblock; emitted += 1) {
    const entry = tt[pos] ?? 0;
    const byte = entry & 0xff;
    pos = entry >>> 8;
    if (same === 4) {
      out.reserve(byte);
      out.fill(last, byte);
      for (let k = 0; k < byte; k += 1) crc = crcByte(crc, last);
      same = 0;
      last = -1;
      continue;
    }
    if (byte === last) {
      same += 1;
    } else {
      last = byte;
      same = 1;
    }
    out.reserve(1);
    out.push(byte);
    crc = crcByte(crc, byte);
  }

  const computed = ~crc >>> 0;
  if (computed !== storedCrc) {
    throw new Bunzip2Error('corrupt', 'bzip2 block CRC does not match its contents');
  }
  return computed;
}

function crcByte(crc: number, byte: number): number {
  return ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
}

/** Canonical-Huffman decode tables in bzip2's limit/base/perm form. */
interface HuffmanTable {
  readonly minLen: number;
  readonly maxLen: number;
  readonly limit: Int32Array;
  readonly base: Int32Array;
  readonly perm: Uint16Array;
  readonly alphaSize: number;
}

function huffmanTable(lengths: Uint8Array, alphaSize: number): HuffmanTable {
  let minLen = 32;
  let maxLen = 0;
  for (let i = 0; i < alphaSize; i += 1) {
    const length = lengths[i] ?? 0;
    if (length > maxLen) maxLen = length;
    if (length < minLen) minLen = length;
  }
  const perm = new Uint16Array(MAX_ALPHA_SIZE);
  let pp = 0;
  for (let length = minLen; length <= maxLen; length += 1) {
    for (let s = 0; s < alphaSize; s += 1) if (lengths[s] === length) perm[pp++] = s;
  }
  const base = new Int32Array(MAX_CODE_LEN + 2);
  for (let s = 0; s < alphaSize; s += 1) {
    const at = (lengths[s] ?? 0) + 1;
    base[at] = (base[at] ?? 0) + 1;
  }
  for (let i = 1; i < base.length; i += 1) base[i] = (base[i] ?? 0) + (base[i - 1] ?? 0);
  const limit = new Int32Array(MAX_CODE_LEN + 1).fill(-1);
  let vec = 0;
  for (let i = minLen; i <= maxLen; i += 1) {
    vec += (base[i + 1] ?? 0) - (base[i] ?? 0);
    limit[i] = vec - 1;
    vec <<= 1;
  }
  for (let i = minLen + 1; i <= maxLen; i += 1) {
    base[i] = (((limit[i - 1] ?? 0) + 1) << 1) - (base[i] ?? 0);
  }
  return { minLen, maxLen, limit, base, perm, alphaSize };
}

function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  let length = table.minLen;
  let code = reader.bits(length);
  while (code > (table.limit[length] ?? -1)) {
    length += 1;
    if (length > table.maxLen) throw new Bunzip2Error('corrupt', 'bzip2 Huffman code is invalid');
    code = (code << 1) | reader.bit();
  }
  const index = code - (table.base[length] ?? 0);
  if (index < 0 || index >= table.alphaSize) {
    throw new Bunzip2Error('corrupt', 'bzip2 Huffman code is invalid');
  }
  return table.perm[index] ?? 0;
}
