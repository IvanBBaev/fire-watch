/**
 * A minimal CCSDS 121.0-B adaptive entropy decoder — exactly what GRIB2 data
 * representation template 5.42 needs, and nothing it does not (TASKS F14).
 *
 * Why this exists: ECMWF Open Data packs its IFS fields with template 5.42 (CCSDS, the
 * format libaec implements), verified on a real `10u` message from the 2026-09-30 00z
 * run — not the simple packing (5.0) older GRIB2 readers assume. There is no GRIB
 * decoder in the repo and a native libaec binding is a build-time dependency this
 * project does not want for one wind layer, so the decoder is written out here, pure
 * and synchronous, and pinned against byte-exact output of the reference encoder
 * (ecCodes 2.43 / libaec; see `grib2.test.ts`).
 *
 * The stream, as GRIB uses it: MSB-first bits; samples grouped in blocks of
 * `blockSize`, blocks grouped in reference sample intervals (RSI) of `rsi` blocks. Each
 * block starts with an option id of `idLen` bits:
 *
 *   * `0` + `0`  — zero block(s): a fundamental-sequence (FS) count of all-zero blocks,
 *                  with the "remainder of segment" (ROS) escape.
 *   * `0` + `1`  — second extension: pairs of samples coded as one FS symbol.
 *   * `1..max-1` — split sample, `k = id - 1`: every sample's high part as FS, then
 *                  every sample's `k` low bits.
 *   * `max`      — uncompressed: `blockSize` raw samples.
 *
 * With preprocessing on (GRIB always sets it), the first block of every RSI carries the
 * raw reference sample and the rest of the RSI is unit-delay prediction residuals mapped
 * to non-negative integers; {@link postprocess} undoes that mapping.
 *
 * Anything this decoder does not implement — signed samples, samples wider than 32 bits,
 * a stream that runs dry or holds an impossible symbol — is a typed {@link AecRefusal},
 * never a guess: a wind arrow drawn from mis-decoded bits is worse than no arrow.
 */

/** libaec flag bits, as GRIB section 5 octet 22 (`ccsdsFlags`) carries them. */
export const AEC_DATA_SIGNED = 1;
export const AEC_DATA_3BYTE = 2;
export const AEC_DATA_MSB = 4;
export const AEC_DATA_PREPROCESS = 8;
export const AEC_RESTRICTED = 16;
export const AEC_PAD_RSI = 32;

/** CCSDS 121.0-B: a zero-block count of 5 means "the rest of this segment". */
const ROS = 5;
/** Second-extension symbols cover β = 0..12, i.e. 91 FS values. */
const SE_TABLE_SIZE = 91;

export interface AecParams {
  readonly bitsPerSample: number;
  readonly blockSize: number;
  /** Reference sample interval, in blocks. */
  readonly rsi: number;
  readonly flags: number;
}

export type AecRefusalReason =
  | 'unsupported_flags'
  | 'unsupported_bits_per_sample'
  | 'unsupported_block_size'
  | 'invalid_rsi'
  | 'truncated_stream'
  | 'invalid_second_extension_symbol';

export class AecRefusal extends Error {
  readonly reason: AecRefusalReason;

  constructor(reason: AecRefusalReason, message: string) {
    super(message);
    this.name = 'AecRefusal';
    this.reason = reason;
  }
}

/** Per-option block counts — test instrumentation, so a fixture proves it hit each path. */
export interface AecModeCounts {
  zeroBlockRuns: number;
  secondExtension: number;
  split: number;
  uncompressed: number;
}

/**
 * Decode `sampleCount` unsigned samples from a CCSDS stream. Returns the samples as
 * integers (a `Float64Array` so 32-bit samples stay exact); `counts`, when passed, is
 * filled with how many blocks took each coding option.
 */
export function decodeAec(
  stream: Uint8Array,
  sampleCount: number,
  params: AecParams,
  counts?: AecModeCounts,
): Float64Array {
  const { bitsPerSample: bps, blockSize, rsi, flags } = params;
  if ((flags & AEC_DATA_SIGNED) !== 0) {
    throw new AecRefusal('unsupported_flags', 'signed CCSDS samples are not supported');
  }
  if (!Number.isInteger(bps) || bps < 1 || bps > 32) {
    throw new AecRefusal(
      'unsupported_bits_per_sample',
      `bits per sample must be 1..32, got ${String(bps)}`,
    );
  }
  if (![8, 16, 32, 64].includes(blockSize)) {
    throw new AecRefusal(
      'unsupported_block_size',
      `block size must be 8, 16, 32 or 64, got ${String(blockSize)}`,
    );
  }
  if (!Number.isInteger(rsi) || rsi < 1 || rsi > 4096) {
    throw new AecRefusal('invalid_rsi', `RSI must be 1..4096 blocks, got ${String(rsi)}`);
  }

  const out = new Float64Array(sampleCount);
  if (sampleCount === 0) return out;

  const reader = new BitReader(stream);
  const idLen = optionIdLength(bps, flags);
  const maxId = (1 << idLen) - 1;
  const preprocess = (flags & AEC_DATA_PREPROCESS) !== 0;
  const padRsi = (flags & AEC_PAD_RSI) !== 0;
  const rsiSamples = rsi * blockSize;
  // One RSI of raw symbols at a time; the postprocessor needs the whole interval.
  const buffer = new Float64Array(rsiSamples);

  let written = 0;
  while (written < sampleCount) {
    let used = 0; // symbols decoded into `buffer` for this RSI
    let blocksDone = 0;
    while (blocksDone < rsi && written + used < sampleCount) {
      const ref = preprocess && blocksDone === 0 ? 1 : 0;
      const id = reader.bits(idLen);
      if (id === 0) {
        const secondExtension = reader.bits(1) === 1;
        if (ref === 1) buffer[used++] = reader.bits(bps);
        if (secondExtension) {
          used = decodeSecondExtension(reader, buffer, used, ref, blockSize);
          blocksDone += 1;
          if (counts !== undefined) counts.secondExtension += 1;
        } else {
          let zeroBlocks = reader.fs() + 1;
          if (zeroBlocks === ROS) {
            const b = Math.floor(used / blockSize);
            zeroBlocks = Math.min(rsi - b, 64 - (b % 64));
          } else if (zeroBlocks > ROS) {
            zeroBlocks -= 1;
          }
          if (blocksDone + zeroBlocks > rsi) {
            throw new AecRefusal('truncated_stream', 'zero-block run overruns its RSI');
          }
          const zeros = zeroBlocks * blockSize - ref;
          buffer.fill(0, used, used + zeros);
          used += zeros;
          blocksDone += zeroBlocks;
          if (counts !== undefined) counts.zeroBlockRuns += 1;
        }
      } else if (id === maxId) {
        // Uncompressed: the reference, when present, is simply the first raw sample.
        for (let i = 0; i < blockSize; i += 1) buffer[used + i] = reader.bits(bps);
        used += blockSize;
        blocksDone += 1;
        if (counts !== undefined) counts.uncompressed += 1;
      } else {
        const k = id - 1;
        if (ref === 1) buffer[used++] = reader.bits(bps);
        const encoded = blockSize - ref;
        // All fundamental sequences first, then all k-bit remainders, as the stream lays them out.
        for (let i = 0; i < encoded; i += 1) buffer[used + i] = reader.fs() * 2 ** k;
        if (k > 0) {
          for (let i = 0; i < encoded; i += 1) {
            buffer[used + i] = (buffer[used + i] ?? 0) + reader.bits(k);
          }
        }
        used += encoded;
        blocksDone += 1;
        if (counts !== undefined) counts.split += 1;
      }
    }

    const take = Math.min(used, sampleCount - written);
    if (preprocess) {
      postprocess(buffer, take, bps, out, written);
    } else {
      out.set(buffer.subarray(0, take), written);
    }
    written += take;
    if (padRsi) reader.alignToByte();
  }
  return out;
}

/**
 * libaec's id length: 5 bits above 16 bits per sample, 4 above 8, 3 otherwise — except
 * the restricted set for very narrow samples.
 */
function optionIdLength(bps: number, flags: number): number {
  if (bps > 16) return 5;
  if (bps > 8) return 4;
  if ((flags & AEC_RESTRICTED) !== 0 && bps <= 4) return bps <= 2 ? 1 : 2;
  return 3;
}

function decodeSecondExtension(
  reader: BitReader,
  buffer: Float64Array,
  start: number,
  ref: number,
  blockSize: number,
): number {
  let used = start;
  let i = ref;
  while (i < blockSize) {
    const m = reader.fs();
    if (m >= SE_TABLE_SIZE) {
      throw new AecRefusal(
        'invalid_second_extension_symbol',
        `second-extension symbol ${String(m)} is out of range`,
      );
    }
    // m = β(β+1)/2 + d1, with β = d0 + d1.
    const beta = Math.floor((Math.sqrt(8 * m + 1) - 1) / 2);
    const d1 = m - (beta * (beta + 1)) / 2;
    if ((i & 1) === 0) {
      buffer[used++] = beta - d1;
      i += 1;
    }
    buffer[used++] = d1;
    i += 1;
  }
  return used;
}

/**
 * Undo the unit-delay predictor for one RSI: `buffer[0]` is the raw reference, every
 * later symbol a mapped residual δ against the previous reconstructed sample. Written
 * from the CCSDS 121.0-B mapping (θ = distance to the nearer bound), not transliterated.
 */
function postprocess(
  buffer: Float64Array,
  count: number,
  bps: number,
  out: Float64Array,
  offset: number,
): void {
  const xmax = 2 ** bps - 1;
  let x = buffer[0] ?? 0;
  out[offset] = x;
  for (let i = 1; i < count; i += 1) {
    const d = buffer[i] ?? 0;
    const theta = Math.min(x, xmax - x);
    if (d <= 2 * theta) {
      x += d % 2 === 0 ? d / 2 : -(d + 1) / 2;
    } else if (theta === x) {
      // Nearer the bottom: residuals past 2θ can only be positive.
      x = d;
    } else {
      x = xmax - d;
    }
    out[offset + i] = x;
  }
}

/** MSB-first bit reader; every read past the end is a typed refusal, never a zero. */
class BitReader {
  private readonly bytes: Uint8Array;
  private position = 0; // in bits
  private readonly limit: number;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.limit = bytes.byteLength * 8;
  }

  bits(n: number): number {
    if (this.position + n > this.limit) {
      throw new AecRefusal('truncated_stream', 'CCSDS stream ended mid-block');
    }
    let value = 0;
    let remaining = n;
    while (remaining > 0) {
      const byte = this.bytes[this.position >>> 3] ?? 0;
      const bitOffset = this.position & 7;
      const available = 8 - bitOffset;
      const take = Math.min(available, remaining);
      const chunk = (byte >>> (available - take)) & ((1 << take) - 1);
      value = value * 2 ** take + chunk;
      this.position += take;
      remaining -= take;
    }
    return value;
  }

  /** Fundamental sequence: the count of 0 bits before the next 1 bit. */
  fs(): number {
    let zeros = 0;
    for (;;) {
      if (this.position >= this.limit) {
        throw new AecRefusal('truncated_stream', 'CCSDS stream ended inside a sequence');
      }
      const bitOffset = this.position & 7;
      const rest = ((this.bytes[this.position >>> 3] ?? 0) << bitOffset) & 0xff;
      if (rest === 0) {
        zeros += 8 - bitOffset;
        this.position += 8 - bitOffset;
        continue;
      }
      const lead = Math.clz32(rest) - 24;
      zeros += lead;
      this.position += lead + 1;
      return zeros;
    }
  }

  alignToByte(): void {
    this.position = Math.ceil(this.position / 8) * 8;
  }
}
