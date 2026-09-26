import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Bunzip2Error, bunzip2, isBzip2, outputCeiling, type Bunzip2Limits } from './bunzip2.js';
import { buildFullDiskGrid, buildListGranule } from './lsa-502-synthetic.js';

/** Limits wide enough that only the stream itself can fail. */
const OPEN: Bunzip2Limits = { maxOutputBytes: 1 << 30, maxRatio: 1e9, ratioFloorBytes: 0 };

/** The reference implementation: `bzip2` 1.0.8 on macOS and on the Ubuntu CI runner. */
function bzip2(data: Uint8Array, level = 9): Uint8Array {
  return new Uint8Array(
    execFileSync('bzip2', ['-c', `-${String(level)}`], { input: data, maxBuffer: 1 << 28 }),
  );
}

function referenceDecode(data: Uint8Array): Buffer {
  return execFileSync('bzip2', ['-dc'], { input: data, maxBuffer: 1 << 28 });
}

/** Deterministic noise, so a failure reproduces. */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Bunzip2Error) return error.code;
    throw error;
  }
  return 'decoded';
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const concat = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts));

describe('bunzip2 against the reference bzip2', () => {
  const inputs: Record<string, () => Promise<Uint8Array> | Uint8Array> = {
    empty: () => new Uint8Array(),
    'one byte': () => new Uint8Array([0x61]),
    noise: () => noise(120_000),
    zeros: () => new Uint8Array(1_500_000),
    text: () => new TextEncoder().encode('fire pixel, confidence 0.91\n'.repeat(4_000)),
    // Runs of every length around bzip2's RLE1 threshold of four.
    'short runs': () =>
      concat(...Array.from({ length: 2_000 }, (_, i) => new Uint8Array((i % 9) + 1).fill(i % 256))),
    // A run of 255+4 and longer: the RLE1 count byte at its limits.
    'long runs': () =>
      concat(
        new Uint8Array(259).fill(7),
        new Uint8Array(260).fill(8),
        new Uint8Array(1000).fill(9),
      ),
    'all byte values': () => new Uint8Array(Array.from({ length: 256 * 40 }, (_, i) => i % 256)),
    'LSA-502 list granule': () =>
      buildListGranule([
        { lat: 42.71, lon: 23.32, frpMw: 55.3, confidence: 0.91 },
        { lat: -11.2, lon: 17.8, frpMw: 140.7, confidence: 0.99 },
      ]),
    'LSA-502 full-disk grid': () => buildFullDiskGrid(300, 0),
  };

  for (const [name, build] of Object.entries(inputs)) {
    it(`round-trips ${name} at levels 1, 5 and 9`, async () => {
      const data = await build();
      for (const level of [1, 5, 9]) {
        const out = bunzip2(bzip2(data, level), OPEN);
        expect(out.length).toBe(data.length);
        expect(sha(out)).toBe(sha(data));
      }
    }, 30_000);
  }

  it('round-trips data spanning several blocks, block size by block size', () => {
    // 330 kB is four blocks at level 1, two at level 2 and one at level 4.
    const data = concat(noise(180_000, 7), new Uint8Array(100_000), noise(50_000, 9));
    for (const level of [1, 2, 4]) {
      expect(sha(bunzip2(bzip2(data, level), OPEN))).toBe(sha(data));
    }
  }, 60_000);

  it('decodes an inline stream without needing the bzip2 binary', () => {
    const fixture = Buffer.from(
      'QlpoOTFBWSZTWdcWpwgAAAVZgAAQQAIQADtgVtAgACIgANPJqFNMjExMTO706cANqroMYmVyLL4u5IpwoSGuLU4Q',
      'base64',
    );
    expect(new TextDecoder().decode(bunzip2(fixture, OPEN))).toBe('fire-watch bzip2 fixture\n');
  });
});

describe('bunzip2 with several streams', () => {
  it('decodes concatenated streams to the concatenation, as bzip2 -d does', () => {
    const a = new TextEncoder().encode('first stream\n');
    const b = noise(120_000, 3);
    const joined = concat(bzip2(a, 1), bzip2(b, 9), bzip2(new Uint8Array(), 5));

    const out = bunzip2(joined, OPEN);

    expect(sha(out)).toBe(sha(concat(a, b)));
    expect(sha(out)).toBe(sha(referenceDecode(joined)));
  });

  it('refuses bytes after the last stream that are not another stream', () => {
    const stream = bzip2(new TextEncoder().encode('payload'));

    expect(codeOf(() => bunzip2(concat(stream, new Uint8Array([0])), OPEN))).toBe('corrupt');
    expect(codeOf(() => bunzip2(concat(stream, new TextEncoder().encode('BZh')), OPEN))).toBe(
      'corrupt',
    );
  });

  it('refuses a second stream that is cut short', () => {
    const second = bzip2(noise(5_000));
    const joined = concat(bzip2(noise(5_000, 2)), second.subarray(0, second.length - 3));

    expect(codeOf(() => bunzip2(joined, OPEN))).toBe('truncated');
  });
});

describe('bunzip2 on damaged input', () => {
  it('refuses input that is not bzip2', () => {
    expect(codeOf(() => bunzip2(new Uint8Array(), OPEN))).toBe('not-bzip2');
    expect(codeOf(() => bunzip2(new TextEncoder().encode('BZh0'), OPEN))).toBe('not-bzip2');
    expect(codeOf(() => bunzip2(new Uint8Array([0x89, 0x48, 0x44, 0x46]), OPEN))).toBe('not-bzip2');
    expect(isBzip2(new TextEncoder().encode('BZh9'))).toBe(true);
  });

  it('refuses every truncation, including one that keeps every complete block', () => {
    // Two blocks at level 1: cutting the last 10 bytes removes only the end-of-stream
    // marker and stream CRC. seek-bzip decodes that as success; this must not.
    const data = concat(noise(150_000, 5), new Uint8Array(20_000));
    const stream = bzip2(data, 1);

    const codes = new Set<string>();
    for (const cut of [4, 5, 10, 14, 100, 1_000, stream.length / 2, stream.length - 10]) {
      codes.add(codeOf(() => bunzip2(stream.subarray(0, Math.floor(cut)), OPEN)));
    }
    for (let back = 1; back <= 12; back += 1) {
      codes.add(codeOf(() => bunzip2(stream.subarray(0, stream.length - back), OPEN)));
    }

    expect([...codes].sort()).toEqual(['truncated']);
  });

  it('refuses a stream whose stored CRCs do not match', () => {
    const stream = bzip2(new TextEncoder().encode('fire-watch '.repeat(100)));
    const blockCrc = Uint8Array.from(stream);
    blockCrc[10] = (blockCrc[10] ?? 0) ^ 0x01; // inside the first block's CRC
    const streamCrc = Uint8Array.from(stream);
    streamCrc[streamCrc.length - 2] = (streamCrc[streamCrc.length - 2] ?? 0) ^ 0x10;

    expect(codeOf(() => bunzip2(blockCrc, OPEN))).toBe('corrupt');
    expect(codeOf(() => bunzip2(streamCrc, OPEN))).toBe('corrupt');
  });

  it('refuses a stream with a damaged block header', () => {
    const stream = Uint8Array.from(bzip2(new TextEncoder().encode('x')));
    stream[4] = 0x00; // first byte of the block magic

    expect(codeOf(() => bunzip2(stream, OPEN))).toBe('corrupt');
  });

  it('never decodes a bit-flipped stream as anything but what bzip2 itself says', () => {
    // Every single-bit flip across a small stream: the decoder either refuses with its
    // own error, or agrees byte-for-byte with the reference (a flip bzip2 also accepts).
    const data = new TextEncoder().encode('lat 42.71 lon 23.32 frp 55.3 conf 0.91\n'.repeat(30));
    const stream = bzip2(data);
    let refused = 0;
    for (let byte = 4; byte < stream.length; byte += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        const flipped = Uint8Array.from(stream);
        flipped[byte] = (flipped[byte] ?? 0) ^ (1 << bit);
        const code = codeOf(() => bunzip2(flipped, OPEN));
        if (code === 'decoded') {
          expect(sha(bunzip2(flipped, OPEN))).toBe(sha(referenceDecode(flipped)));
        } else {
          refused += 1;
          expect(['corrupt', 'truncated', 'unsupported']).toContain(code);
        }
      }
    }
    expect(refused).toBeGreaterThan((stream.length - 4) * 8 * 0.9);
  }, 60_000);

  it('only ever fails with its own error on random garbage after a valid header', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const garbage = concat(new TextEncoder().encode('BZh9'), noise(64 + (seed % 200), seed));
      expect(['corrupt', 'truncated', 'unsupported']).toContain(
        codeOf(() => bunzip2(garbage, OPEN)),
      );
    }
  });
});

describe('bunzip2 caps', () => {
  // 64 MiB of zeros packs to about 50 bytes at level 9: a ratio over a million.
  const bomb = bzip2(new Uint8Array(64 * 1024 * 1024));

  it('stops a bomb at the absolute cap', () => {
    let error: unknown;
    try {
      bunzip2(bomb, { maxOutputBytes: 8 * 1024 * 1024, maxRatio: 1e9, ratioFloorBytes: 0 });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Bunzip2Error);
    expect((error as Bunzip2Error).code).toBe('too-large');
    expect((error as Bunzip2Error).message).toContain('8388608-byte cap');
  }, 30_000);

  it('stops a bomb at the ratio cap', () => {
    let error: unknown;
    try {
      bunzip2(bomb, { maxOutputBytes: 1 << 30, maxRatio: 1000, ratioFloorBytes: 1024 * 1024 });
    } catch (caught) {
      error = caught;
    }

    expect((error as Bunzip2Error).code).toBe('too-large');
    expect((error as Bunzip2Error).message).toContain('1000x');
  });

  it('counts every stream of a multistream input against the same cap', () => {
    const part = bzip2(new Uint8Array(600_000));
    const limits = { maxOutputBytes: 1_000_000, maxRatio: 1e9, ratioFloorBytes: 0 };

    expect(bunzip2(part, limits)).toHaveLength(600_000);
    expect(codeOf(() => bunzip2(concat(part, part), limits))).toBe('too-large');
  });

  it('lets a small honest file through below the ratio floor', () => {
    // 1 MiB of zeros is far past 1000x, but under the floor it is not a bomb worth refusing.
    const limits = { maxOutputBytes: 1 << 30, maxRatio: 1000, ratioFloorBytes: 2 * 1024 * 1024 };

    expect(bunzip2(bzip2(new Uint8Array(1024 * 1024)), limits)).toHaveLength(1024 * 1024);
  });

  it('computes its ceiling as the smaller of the two caps, never below the floor', () => {
    const limits = { maxOutputBytes: 100, maxRatio: 10, ratioFloorBytes: 30 };

    expect(outputCeiling(1, limits)).toBe(30);
    expect(outputCeiling(5, limits)).toBe(50);
    expect(outputCeiling(50, limits)).toBe(100);
  });
});
