import { afterEach, describe, expect, it } from 'vitest';

import type { GranuleRef } from '../../core/ports/granule-decoder.js';
import {
  DECODER_REASON_PREFIX,
  DECODER_REFUSED_EXIT,
  GRANULE_REF_ENV,
  childEnv,
  createChildProcessDecoder,
} from './child-process-decoder.js';

const REF: GranuleRef = {
  source: 'lsasaf:seviri:frp-pixel',
  kind: 'frp',
  slotIso: '2026-08-02T11:15:00Z',
  name: 'HDF5_LSASAF_MSG_FRP-PIXEL-ListProduct_MSG-Disk_202608021115.bz2',
};

const BYTES = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A decoder written in whatever Node this test is running under. */
function decoderRunning(script: string, options: Record<string, unknown> = {}) {
  return createChildProcessDecoder({
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: 5_000,
    killGraceMs: 200,
    ...options,
  });
}

const SENTINELS = ['DATABASE_URL', 'FIRMS_MAP_KEY', 'NODE_OPTIONS'] as const;

afterEach(() => {
  for (const name of SENTINELS) delete process.env[name];
});

describe('a decoder that behaves', () => {
  it('returns the payload as text, without parsing it', async () => {
    const decoder = decoderRunning(`process.stdout.write('{"format":"fire-watch.granule.v1"}')`);

    const result = await decoder.decode(REF, BYTES);

    expect(result.outcome).toBe('ok');
    expect(result.payload).toBe('{"format":"fire-watch.granule.v1"}');
    expect(result.error).toBeNull();
    expect(result.bytesOut).toBe(34);
  });

  it('is handed the granule on stdin, whole', async () => {
    const decoder = decoderRunning(`
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => {
        process.stdout.write(Buffer.concat(chunks).toString('hex'));
      });
    `);

    const result = await decoder.decode(REF, BYTES);

    expect(result.payload).toBe('894844460d0a1a0a');
  });

  it('is told which granule it is reading, out of band of its own arguments', async () => {
    // The filename is the provider's string. It travels in the environment precisely so
    // that a granule named `--output=/etc/passwd` cannot be read as a flag.
    const decoder = decoderRunning(`process.stdout.write(process.env.${GRANULE_REF_ENV})`);

    const result = await decoder.decode({ ...REF, name: '--output=/etc/passwd' }, BYTES);

    expect(JSON.parse(result.payload ?? 'null')).toEqual({
      source: 'lsasaf:seviri:frp-pixel',
      kind: 'frp',
      slot: '2026-08-02T11:15:00Z',
      name: '--output=/etc/passwd',
    });
  });
});

describe('a poisoned granule', () => {
  it('cannot crash us by killing the decoder', async () => {
    // SIGSEGV is what a native HDF5 library does with a malformed file, and it is the
    // failure this whole adapter exists for.
    const decoder = decoderRunning(`process.kill(process.pid, 'SIGSEGV')`);

    const result = await decoder.decode(REF, BYTES);

    expect(result.outcome).toBe('crashed');
    expect(result.error).toContain('SIGSEGV');
    expect(result.payload).toBeNull();
  });

  it('cannot crash us by aborting the decoder', async () => {
    const decoder = decoderRunning(`process.abort()`);

    expect((await decoder.decode(REF, BYTES)).outcome).toBe('crashed');
  });

  it('cannot hang us: the deadline kills the process group', async () => {
    const decoder = decoderRunning(`setInterval(() => {}, 1000)`, { timeoutMs: 300 });

    const result = await decoder.decode(REF, BYTES);

    expect(result.outcome).toBe('timed_out');
    expect(result.error).toContain('300 ms');
  });

  it('cannot outlive the deadline by ignoring SIGTERM', async () => {
    const decoder = decoderRunning(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`, {
      timeoutMs: 200,
      killGraceMs: 100,
    });

    expect((await decoder.decode(REF, BYTES)).outcome).toBe('timed_out');
  });

  it('cannot exhaust us by flooding stdout', async () => {
    // The decompression bomb does not kill the decoder — it hands the parent a gigabyte
    // and kills the parent instead. The cap is the only thing between us and that.
    const decoder = decoderRunning(
      `const b = Buffer.alloc(65536, 0x61); for (let i = 0; i < 64; i++) process.stdout.write(b)`,
      { maxOutputBytes: 4096 },
    );

    const result = await decoder.decode(REF, BYTES);

    expect(result.outcome).toBe('oversized');
    expect(result.bytesOut).toBeGreaterThan(4096);
    expect(result.payload).toBeNull();
  });

  it('cannot make us parse its output, whatever it writes', async () => {
    const decoder = decoderRunning(`process.stdout.write('{ this is not json')`);

    const result = await decoder.decode(REF, BYTES);

    // The adapter reports success on exit 0 and hands the text on. Judging it is the
    // core's job, on the far side of the wall.
    expect(result.outcome).toBe('ok');
    expect(result.payload).toBe('{ this is not json');
  });
});

describe('what the decoder is allowed to know', () => {
  it('cannot see our secrets, because it is not given an environment to filter', async () => {
    process.env['DATABASE_URL'] = 'sentinel-must-not-leak';
    process.env['FIRMS_MAP_KEY'] = 'sentinel-must-not-leak';
    const decoder = decoderRunning(`process.stdout.write(Object.keys(process.env).join(','))`);

    const result = await decoder.decode(REF, BYTES);

    expect(result.payload).not.toContain('DATABASE_URL');
    expect(result.payload).not.toContain('FIRMS_MAP_KEY');
    expect(result.payload).toContain(GRANULE_REF_ENV);
  });

  it('cannot be handed code through NODE_OPTIONS', () => {
    process.env['NODE_OPTIONS'] = '--require=/tmp/evil.js';

    expect(Object.keys(childEnv(REF))).not.toContain('NODE_OPTIONS');
  });

  it('gets the knobs it was configured with, and nothing more', () => {
    process.env['DATABASE_URL'] = 'sentinel-must-not-leak';
    const allowed = new Set([
      'PATH',
      'HOME',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'TZ',
      'FW_DECODER_MODE',
      GRANULE_REF_ENV,
    ]);

    const env = childEnv(REF, { FW_DECODER_MODE: 'strict' });

    expect(env['FW_DECODER_MODE']).toBe('strict');
    expect(Object.keys(env).filter((name) => !allowed.has(name))).toEqual([]);
  });

  it('does not receive an unbounded filename', () => {
    const env = childEnv({ ...REF, name: 'x'.repeat(5000) });

    expect(JSON.parse(env[GRANULE_REF_ENV] ?? 'null')).toMatchObject({ name: 'x'.repeat(256) });
  });
});

describe('a decoder that declines', () => {
  it('is a refusal, not a crash, when it says so with its exit code', async () => {
    const decoder = decoderRunning(
      `process.stderr.write('unsupported product version'); process.exit(${String(DECODER_REFUSED_EXIT)})`,
    );

    const result = await decoder.decode(REF, BYTES);

    expect(result.outcome).toBe('refused');
    expect(result.error).toContain('unsupported product version');
  });

  it('is a crash when it merely dies with a code of its own', async () => {
    const decoder = decoderRunning(`process.exit(1)`);

    expect((await decoder.decode(REF, BYTES)).outcome).toBe('crashed');
  });

  it('has its diagnosis flattened and capped, not stored as an error page', async () => {
    const decoder = decoderRunning(
      `process.stderr.write('x'.repeat(4000)); process.exit(${String(DECODER_REFUSED_EXIT)})`,
    );

    const result = await decoder.decode(REF, BYTES);

    expect(result.error?.length).toBeLessThan(600);
    expect(result.error).toContain('…');
  });

  it('puts its own reason first, however much its libraries said before it', async () => {
    // libhdf5 prints a diagnostic stack longer than the whole error budget; the decoder's
    // reason comes last. It must survive both the stderr window and the cap.
    // `exitCode`, not `process.exit()`: ~12 KB can outrun the pipe (Linux CI shrinks pipe
    // buffers under load), Node then queues the rest, and `process.exit()` drops that queue —
    // reason line included. A real decoder writes fd 2 synchronously and loses nothing.
    const decoder = decoderRunning(
      `for (let i = 0; i < 400; i += 1) process.stderr.write('HDF5-DIAG: #' + i + ' noise noise noise\\n');
       process.stderr.write('\\n${DECODER_REASON_PREFIX}the superblock is truncated\\n');
       process.exitCode = ${String(DECODER_REFUSED_EXIT)};`,
    );

    const result = await decoder.decode(REF, BYTES);

    expect(result.outcome).toBe('refused');
    expect(result.error).toMatch(
      /^decoder rejected the granule: the superblock is truncated \[stderr: HDF5-DIAG: #0 /,
    );
    expect(result.error?.length).toBeLessThan(600);
  });

  it('keeps the last reason when a decoder gives more than one, and the plain text when none', async () => {
    const twice = decoderRunning(
      `process.stderr.write('${DECODER_REASON_PREFIX}first\\n${DECODER_REASON_PREFIX}second\\n');
       process.exit(${String(DECODER_REFUSED_EXIT)})`,
    );
    const plain = decoderRunning(
      `process.stderr.write('just text'); process.exit(${String(DECODER_REFUSED_EXIT)})`,
    );

    expect((await twice.decode(REF, BYTES)).error).toBe('decoder rejected the granule: second');
    expect((await plain.decode(REF, BYTES)).error).toBe('decoder rejected the granule: just text');
  });

  it('carries the reason of a decoder that dies, too', async () => {
    const decoder = decoderRunning(
      `process.stderr.write('x'.repeat(20000) + '\\n${DECODER_REASON_PREFIX}wasm trap\\n'); process.exit(70)`,
    );

    const result = await decoder.decode(REF, BYTES);

    expect(result.outcome).toBe('crashed');
    expect(result.error).toMatch(/^decoder exited with code 70: wasm trap \[stderr: x+/);
  });
});

describe('a decoder that is not there', () => {
  it('is unavailable, which is our problem and not the granule’s', async () => {
    const decoder = createChildProcessDecoder({
      command: '/nonexistent/fire-watch-decoder',
      timeoutMs: 5_000,
    });

    const result = await decoder.decode(REF, BYTES);

    expect(result.outcome).toBe('unavailable');
    expect(result.error).toContain('could not be started');
  });
});

describe('every decode', () => {
  it('answers with a result, never with a rejection', async () => {
    // The whole point, stated once: no granule produces a thrown error, because a thrown
    // error is one missing catch away from a crash loop against a file the provider will
    // keep serving for the rest of the season.
    // Only the deliberate hang gets a tight timeout. The other four finish on their own,
    // and on a loaded CI runner node's startup alone can eat hundreds of milliseconds —
    // a short uniform budget would convert a genuine crash into `timed_out`.
    const scripts: readonly [script: string, timeoutMs: number][] = [
      [`process.kill(process.pid, 'SIGKILL')`, 5_000],
      [`process.abort()`, 5_000],
      [`process.exit(3)`, 5_000],
      [`process.stdout.write('ok')`, 5_000],
      [`setInterval(() => {}, 1000)`, 400],
    ];

    const outcomes = await Promise.all(
      scripts.map(([script, timeoutMs]) =>
        decoderRunning(script, { timeoutMs, killGraceMs: 100 }).decode(REF, BYTES),
      ),
    );

    expect(outcomes.map((result) => result.outcome)).toEqual([
      'crashed',
      'crashed',
      'crashed',
      'ok',
      'timed_out',
    ]);
    for (const result of outcomes) expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
