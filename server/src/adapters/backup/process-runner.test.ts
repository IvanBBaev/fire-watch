import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createProcessRunner, sanitizeStderr, type CommandSpec } from './process-runner.js';

const dir = mkdtempSync(join(tmpdir(), 'fw-process-runner-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function node(label: string, script: string): CommandSpec {
  return { command: process.execPath, args: ['-e', script], label };
}

const UPPER = node(
  'upper',
  "process.stdin.on('data', (c) => process.stdout.write(String(c).toUpperCase()))",
);
const runner = createProcessRunner();

describe('sanitizeStderr', () => {
  it('keeps error lines, drops row-quoting lines, masks key values, truncates', () => {
    const stderr = [
      'pg_restore: while PROCESSING TOC:',
      'pg_restore: error: could not execute query: ERROR:  duplicate key value violates unique constraint "accounts_email_key"',
      'DETAIL:  Key (email)=(someone@example.org) already exists.',
      'Command was: COPY public.accounts (id, email) FROM stdin;',
      `pg_restore: error: ${'x'.repeat(400)}`,
    ].join('\n');
    const clean = sanitizeStderr(stderr);
    expect(clean).not.toContain('someone@example.org');
    expect(clean).not.toContain('COPY public.accounts');
    expect(clean).toContain('accounts_email_key');
    expect(clean.split(' | ')).toHaveLength(2);
    expect(clean.length).toBeLessThan(450);
    expect(sanitizeStderr('ERROR: x Key (id)=(42) conflicts')).toBe(
      'ERROR: x Key (id)=(…) conflicts',
    );
  });

  it('falls back to the first lines when none names an error', () => {
    expect(sanitizeStderr('a\n\nb\nc\nd')).toBe('a | b | c');
  });
});

describe('run', () => {
  it('feeds stdin and collects stdout', async () => {
    await expect(runner.run(UPPER, 'abc')).resolves.toEqual({ stdout: 'ABC' });
  });

  it('throws a sanitised ProcessError on a non-zero exit, without the argv', async () => {
    const failing = node(
      'psql',
      "process.stderr.write('psql: error: FATAL: role x\\nDETAIL: Key (a)=(secret)\\n'); process.exit(3)",
    );
    const error = await runner.run(failing).then(
      () => new Error('resolved unexpectedly'),
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('psql exited 3: psql: error: FATAL: role x');
    expect(error.message).not.toContain('process.stderr');
  });

  it('reports a command that cannot start by its errno', async () => {
    const error = await runner
      .run({ command: '/nonexistent/fw-binary', args: [], label: 'age' })
      .then(
        () => new Error('resolved unexpectedly'),
        (e: unknown) => e as Error,
      );
    expect(error.message).toBe('age exited null: could not start (ENOENT)');
  });
});

describe('pipeline', () => {
  it('pipes stages, writes a 0600 file exclusively, and hashes it', async () => {
    const input = join(dir, 'in.txt');
    writeFileSync(input, 'hello pipeline');
    const output = join(dir, 'out.txt');
    const result = await runner.pipeline(
      [node('cat', 'process.stdin.pipe(process.stdout)'), UPPER],
      {
        inputFile: input,
        outputFile: output,
      },
    );
    expect(readFileSync(output, 'utf8')).toBe('HELLO PIPELINE');
    expect(result).toEqual({
      bytes: 14,
      sha256: createHash('sha256').update('HELLO PIPELINE').digest('hex'),
    });
    expect(statSync(output).mode & 0o777).toBe(0o600);

    // `wx`: an existing file is never overwritten, and never removed.
    await expect(
      runner.pipeline([node('emit', "process.stdout.write('x')")], { outputFile: output }),
    ).rejects.toThrow(/EEXIST/);
    expect(readFileSync(output, 'utf8')).toBe('HELLO PIPELINE');
  });

  it('removes the partial output and names the first failing stage', async () => {
    const output = join(dir, 'partial.txt');
    const error = await runner
      .pipeline(
        [
          node(
            'pg_dump',
            "process.stdout.write('half'); process.stderr.write('pg_dump: error: boom\\n'); process.exit(1)",
          ),
          UPPER,
        ],
        { outputFile: output },
      )
      .then(
        () => new Error('resolved unexpectedly'),
        (e: unknown) => e as Error,
      );
    expect(error.message).toBe('pg_dump exited 1: pg_dump: error: boom');
    expect(existsSync(output)).toBe(false);
  });

  it('fails when the last stage fails, with no output file', async () => {
    const input = join(dir, 'in2.txt');
    writeFileSync(input, 'data');
    await expect(
      runner.pipeline(
        [
          node('age', 'process.stdin.pipe(process.stdout)'),
          node(
            'pg_restore',
            "process.stdin.resume(); process.stdin.on('end', () => process.exit(2))",
          ),
        ],
        { inputFile: input },
      ),
    ).rejects.toThrow(/^pg_restore exited 2/);
  });

  it('succeeds without an output file', async () => {
    await expect(runner.pipeline([UPPER], {})).resolves.toMatchObject({ bytes: 0 });
  });
});

describe('interactive', () => {
  it('answers line by line and ends cleanly', async () => {
    const echo = node(
      'psql',
      "require('readline').createInterface({input: process.stdin}).on('line', (l) => { if (l === 'q') process.exit(0); console.log('got ' + l); })",
    );
    const session = runner.interactive(echo);
    session.writeLine('one');
    await expect(session.readLine()).resolves.toBe('got one');
    session.writeLine('two');
    await expect(session.readLine()).resolves.toBe('got two');
    await expect(session.end()).resolves.toBeUndefined();
  });

  it('rejects a read when the process dies, with its sanitised stderr', async () => {
    const dying = node(
      'psql',
      "process.stderr.write('psql: error: connection failed\\n'); process.exit(2)",
    );
    const session = runner.interactive(dying);
    await expect(session.readLine()).rejects.toThrow(
      'psql exited 2: psql: error: connection failed',
    );
  });

  it('times out a read and can be killed', async () => {
    const silent = node('psql', 'setInterval(() => undefined, 1000)');
    const session = runner.interactive(silent);
    await expect(session.readLine(50)).rejects.toThrow(/did not answer within 50 ms/);
    session.kill();
    await expect(session.end()).rejects.toThrow(/killed by SIGTERM/);
  });
});
