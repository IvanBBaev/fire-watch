import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { POLLING_BBOX } from '../../core/config/polling-bbox.js';
import { parseGranulePayload } from '../../core/ingest/granule-payload.js';
import type { GranuleRef } from '../../core/ports/granule-decoder.js';
import { createChildProcessDecoder } from './child-process-decoder.js';
import { createH5wasmDecoder, decoderArgs } from './h5wasm-decoder.js';
import { buildListGranule } from './lsa-502-synthetic.js';

/**
 * The real child, run from its TypeScript source: Node strips the types, and the module
 * has no relative runtime imports, so the file under test is the file that ships.
 */
const ENTRY = fileURLToPath(new URL('./lsa-frp-pixel-decoder.ts', import.meta.url));

const REF: GranuleRef = {
  source: 'lsasaf:seviri:frp-pixel',
  kind: 'frp',
  slotIso: '2026-08-02T11:15:00Z',
  name: 'HDF5_LSASAF_MSG_FRP-PIXEL-ListProduct_MSG-Disk_202608021115',
};

/** Node start, h5wasm instantiation and a decode; generous for a loaded CI runner. */
const CHILD_TIMEOUT_MS = 20_000;

const decoder = createH5wasmDecoder({ entry: ENTRY, timeoutMs: CHILD_TIMEOUT_MS });

function bzip2(data: Uint8Array): Uint8Array {
  return new Uint8Array(execFileSync('bzip2', ['-c', '-9'], { input: data, maxBuffer: 1 << 26 }));
}

describe('the h5wasm decoder, across the wall', () => {
  it('turns a synthetic LSA-502 list into a payload the reader accepts', async () => {
    const bytes = await buildListGranule([
      {
        lat: 42.71,
        lon: 23.32,
        frpMw: 55.3,
        confidence: 0.91,
        btMirK: 330.5,
        btMirBackgroundK: 301.2,
      },
      { lat: -11.2, lon: 17.8, frpMw: 140.7, confidence: 0.99 },
    ]);

    const result = await decoder.decode(REF, bytes);

    expect(result.error).toBeNull();
    expect(result.outcome).toBe('ok');
    const read = parseGranulePayload(REF, result.payload ?? '');
    expect(read.ok && read.rows.map((row) => row.latCanonical)).toEqual(['42.71000', '-11.20000']);
  }, 30_000);

  it('applies the clip it was configured with', async () => {
    const clipped = createH5wasmDecoder({
      entry: ENTRY,
      timeoutMs: CHILD_TIMEOUT_MS,
      clip: POLLING_BBOX.values,
    });
    const bytes = await buildListGranule([
      { lat: 42.71, lon: 23.32, frpMw: 55.3, confidence: 0.91 },
      { lat: -11.2, lon: 17.8, frpMw: 140.7, confidence: 0.99 },
    ]);

    const result = await clipped.decode(REF, bytes);

    const read = parseGranulePayload(REF, result.payload ?? '');
    expect(read.ok && read.rows).toHaveLength(1);
  }, 30_000);

  it('unpacks a .bz2 granule inside the child and decodes it', async () => {
    const hdf5 = await buildListGranule([
      { lat: 42.71, lon: 23.32, frpMw: 55.3, confidence: 0.91 },
    ]);

    const result = await decoder.decode(REF, bzip2(hdf5));

    expect(result.error).toBeNull();
    expect(result.outcome).toBe('ok');
    const read = parseGranulePayload(REF, result.payload ?? '');
    expect(read.ok && read.rows.map((row) => row.latCanonical)).toEqual(['42.71000']);
    expect(JSON.parse(result.payload ?? '{}')).toMatchObject({
      decoder: { compression: 'bzip2', hdf5Bytes: hdf5.length },
    });
  }, 30_000);

  it('refuses a bzip2 bomb at the cap, with the cap as the reason', async () => {
    // 64 MiB of zeros packs to ~50 bytes. The child stops at 8 MiB and exits 65.
    const capped = createH5wasmDecoder({
      entry: ENTRY,
      timeoutMs: CHILD_TIMEOUT_MS,
      maxUnpackedBytes: 8 * 1024 * 1024,
    });

    const result = await capped.decode(REF, bzip2(new Uint8Array(64 * 1024 * 1024)));

    expect(result.outcome).toBe('refused');
    expect(result.error).toBe(
      'decoder rejected the granule: bzip2 output exceeds the 8388608-byte cap',
    );
  }, 30_000);

  it('refuses a bzip2 bomb on ratio under the default caps', async () => {
    // 48 MiB of zeros is under the 128 MiB absolute cap, but it packs to ~50 bytes, so
    // the 1000x ratio stops it as soon as it passes the 32 MiB floor.
    const result = await decoder.decode(REF, bzip2(new Uint8Array(48 * 1024 * 1024)));

    expect(result.outcome).toBe('refused');
    expect(result.error).toMatch(/^decoder rejected the granule: bzip2 output exceeds 1000x/);
  }, 30_000);

  it('refuses a truncated or corrupt .bz2 with a reason, not a crash', async () => {
    const packed = bzip2(
      await buildListGranule([{ lat: 42.71, lon: 23.32, frpMw: 55.3, confidence: 0.91 }]),
    );
    const corrupt = Uint8Array.from(packed);
    corrupt[20] = (corrupt[20] ?? 0) ^ 0xff;

    const truncated = await decoder.decode(REF, packed.subarray(0, packed.length - 5));
    const damaged = await decoder.decode(REF, corrupt);

    expect(truncated.outcome).toBe('refused');
    expect(truncated.error).toBe(
      'decoder rejected the granule: bzip2 stream ends before its end-of-stream marker',
    );
    expect(damaged.outcome).toBe('refused');
    expect(damaged.error).toMatch(/^decoder rejected the granule: bzip2 /);
  }, 30_000);

  it('refuses a truncated granule on libhdf5’s word, with its own reason first', async () => {
    const whole = await buildListGranule([
      { lat: 42.71, lon: 23.32, frpMw: 55.3, confidence: 0.91 },
    ]);

    const result = await decoder.decode(REF, whole.slice(0, 600));

    // libhdf5 prints an HDF5-DIAG stack longer than the whole error budget before the
    // child gets control back. The child's reason must still be what the error says.
    expect(result.outcome).toBe('refused');
    expect(result.error).toMatch(/^decoder rejected the granule: libhdf5 rejected the granule: /);
    expect(result.error).toContain('[stderr: HDF5-DIAG');
  }, 30_000);

  it('refuses a granule that disagrees with the slot it was fetched as', async () => {
    const bytes = await buildListGranule([], { acquisitionTime: '20260802113000' });

    const result = await decoder.decode(REF, bytes);

    expect(result.outcome).toBe('refused');
    expect(result.error).toContain('11:30');
  }, 30_000);

  it('refuses input over its cap before decoding any of it', async () => {
    const small = createH5wasmDecoder({
      entry: ENTRY,
      timeoutMs: CHILD_TIMEOUT_MS,
      maxInputBytes: 1024,
    });
    const bytes = await buildListGranule([
      { lat: 42.71, lon: 23.32, frpMw: 55.3, confidence: 0.91 },
    ]);

    const result = await small.decode(REF, bytes);

    expect(result.outcome).toBe('refused');
    expect(result.error).toContain('input cap');
  }, 30_000);
});

describe('the child runtime the decoder runs in', () => {
  // A stand-in for "libhdf5 has been owned": a program run with exactly the decoder's
  // flags that tries the things an attacker would try next. Each must fail.
  const dir = mkdtempSync(join(tmpdir(), 'fw-h5wasm-sandbox-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function attempt(name: string, body: string) {
    const entry = join(dir, `${name}.mjs`);
    writeFileSync(entry, body);
    return createChildProcessDecoder({
      command: process.execPath,
      args: decoderArgs(entry),
      timeoutMs: CHILD_TIMEOUT_MS,
    });
  }

  it('is launched under the permission model with memory ceilings', () => {
    const args = decoderArgs(ENTRY);

    expect(args).toContain('--permission');
    expect(args).toContain('--disallow-code-generation-from-strings');
    expect(args.some((arg) => arg.startsWith('--wasm-max-mem-pages='))).toBe(true);
    expect(args.some((arg) => arg.startsWith('--max-old-space-size='))).toBe(true);
    expect(args.filter((arg) => arg.startsWith('--allow-fs-write'))).toEqual([]);
    expect(args.filter((arg) => arg.startsWith('--allow-child-process'))).toEqual([]);
    expect(args.at(-1)).toBe(ENTRY);
  });

  it('may read its bzip2 sibling, and only when there is one', () => {
    const sibling = realpathSync(fileURLToPath(new URL('./bunzip2.ts', import.meta.url)));
    const probe = join(dir, 'probe.mjs');
    writeFileSync(probe, '');

    expect(decoderArgs(ENTRY)).toContain(`--allow-fs-read=${sibling}`);
    expect(decoderArgs(probe).some((arg) => arg.includes('bunzip2'))).toBe(false);
  });

  it('cannot read files outside what it was allowed', async () => {
    const result = await attempt(
      'read',
      `import { readFileSync } from 'node:fs';
       process.stdout.write(readFileSync(${JSON.stringify(fileURLToPath(import.meta.url))}, 'utf8'));`,
    ).decode(REF, new Uint8Array());

    expect(result.outcome).toBe('crashed');
    expect(result.error).toContain('Access to this API has been restricted');
  }, 30_000);

  it('cannot write files', async () => {
    const result = await attempt(
      'write',
      `import { writeFileSync } from 'node:fs';
       writeFileSync(${JSON.stringify(join(dir, 'planted'))}, 'x');`,
    ).decode(REF, new Uint8Array());

    expect(result.outcome).toBe('crashed');
    expect(result.error).toContain('Access to this API has been restricted');
  }, 30_000);

  it('cannot start other programs', async () => {
    const result = await attempt(
      'spawn',
      `import { execFileSync } from 'node:child_process';
       process.stdout.write(execFileSync('/bin/echo', ['escaped']));`,
    ).decode(REF, new Uint8Array());

    expect(result.outcome).toBe('crashed');
    expect(result.error).toContain('Access to this API has been restricted');
  }, 30_000);

  it('cannot turn strings into code', async () => {
    const result = await attempt('eval', `process.stdout.write(String(eval('1 + 1')));`).decode(
      REF,
      new Uint8Array(),
    );

    expect(result.outcome).toBe('crashed');
    expect(result.error).toContain('EvalError');
  }, 30_000);

  it('cannot grow WebAssembly memory past its ceiling', async () => {
    // 600 MiB of pages against the 512 MiB default: a decompression bomb inside libhdf5
    // meets this as a failed allocation, not as a host that swaps.
    const result = await attempt(
      'wasm',
      `new WebAssembly.Memory({ initial: 9600 }); process.stdout.write('grew');`,
    ).decode(REF, new Uint8Array());

    expect(result.outcome).toBe('crashed');
    expect(result.error).toContain('RangeError');
    expect(result.payload).toBeNull();
  }, 30_000);
});
