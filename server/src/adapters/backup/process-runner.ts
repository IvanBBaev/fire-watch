/**
 * Child processes for the backup and restore adapters (TASKS C6): `psql`, `pg_dump`,
 * `pg_restore` and `age`, run directly or through a command prefix such as
 * `docker compose exec -T postgres` (the production Postgres publishes no port).
 *
 * Three shapes, one port ({@link ProcessRunner}) so the Postgres adapters test against a fake:
 *
 *   * `run` — one command, optional stdin text, stdout collected (bounded);
 *   * `pipeline` — `a | b | …`, optionally reading a file into the first stage and writing
 *     the last stage's stdout to a new file (`wx`, 0600) while hashing it. The artifact is
 *     created, written and hashed in one pass, and removed when any stage fails: a partial
 *     dump is never left on disk looking like a finished one;
 *   * `interactive` — a long-lived session fed line by line: the psql that holds the
 *     exported snapshot open while both dumps run.
 *
 * **Error text is sanitised, not echoed.** pg_restore prints the offending row in its
 * `DETAIL:` lines (`Key (email)=(…) already exists`) and `Command was:` lines quote SQL;
 * both can carry personal data into the journal. {@link sanitizeStderr} keeps only a few
 * error lines, drops those, and truncates the rest. Arguments are never echoed either:
 * an `age -r` recipient is harmless, but a prefix could one day carry a password.
 *
 * No shell is ever involved: every argument goes to `spawn` as an argv element.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** A short name for messages (`pg_dump`, `age`), never the full argv. */
  readonly label: string;
}

export interface RunResult {
  readonly stdout: string;
}

export interface PipelineIo {
  /** Fed to the first stage's stdin; absent → stdin is empty. */
  readonly inputFile?: string;
  /** The last stage's stdout, created exclusively with mode 0600; absent → discarded. */
  readonly outputFile?: string;
}

export interface PipelineResult {
  /** Bytes written to `outputFile` (0 without one). */
  readonly bytes: number;
  /** Hex SHA-256 of what was written (of nothing, without an output file). */
  readonly sha256: string;
}

export interface InteractiveSession {
  /** Writes one line (a newline is appended). */
  writeLine(line: string): void;
  /** The next non-empty stdout line; rejects on exit or after `timeoutMs`. */
  readLine(timeoutMs?: number): Promise<string>;
  /** Closes stdin and waits for a zero exit. */
  end(): Promise<void>;
  /** Kills the process; idempotent. */
  kill(): void;
}

export interface ProcessRunner {
  run(spec: CommandSpec, input?: string): Promise<RunResult>;
  pipeline(stages: readonly CommandSpec[], io: PipelineIo): Promise<PipelineResult>;
  interactive(spec: CommandSpec): InteractiveSession;
}

export const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const READ_LINE_TIMEOUT_MS = 60_000;
const MAX_ERROR_LINES = 3;
const MAX_ERROR_LINE_CHARS = 200;

export class ProcessError extends Error {
  constructor(
    readonly label: string,
    readonly exitCode: number | null,
    readonly signal: string | null,
    detail: string,
  ) {
    const how = signal === null ? `exited ${String(exitCode)}` : `was killed by ${signal}`;
    super(detail === '' ? `${label} ${how}` : `${label} ${how}: ${detail}`);
    this.name = 'ProcessError';
  }
}

/**
 * A few lines of stderr fit for a journal. Lines that name an error are preferred; lines
 * that can quote row data or SQL (`DETAIL:`, `Command was:`, `CONTEXT:`, `LINE n:`) are
 * dropped; a `Key (…)=(…)` fragment inside a kept line is masked; every line is truncated.
 */
export function sanitizeStderr(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !/^(?:\S+:\s+)?(?:DETAIL|CONTEXT|HINT|QUERY|STATEMENT|LINE \d+):/i.test(line))
    .filter((line) => !/Command was:/i.test(line))
    .map((line) => line.replace(/\(([^()]*)\)=\((.*)\)/g, '($1)=(…)'));
  const errors = lines.filter((line) => /error|fatal|failed|denied|no such|not found/i.test(line));
  const chosen = (errors.length > 0 ? errors : lines).slice(0, MAX_ERROR_LINES);
  return chosen
    .map((line) =>
      line.length > MAX_ERROR_LINE_CHARS ? `${line.slice(0, MAX_ERROR_LINE_CHARS)}…` : line,
    )
    .join(' | ');
}

export function createProcessRunner(): ProcessRunner {
  return {
    run: runCommand,
    pipeline: runPipeline,
    interactive: startInteractive,
  };
}

function spawnSpec(spec: CommandSpec, stdin: 'pipe' | 'ignore'): ChildProcess {
  return spawn(spec.command, [...spec.args], {
    stdio: [stdin, 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
}

interface Exit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly spawnError: Error | null;
}

function waitExit(child: ChildProcess): Promise<Exit> {
  return new Promise((resolve) => {
    let spawnError: Error | null = null;
    child.once('error', (error) => {
      spawnError = error;
      // A failed spawn emits no 'close' on some platforms.
      if (child.pid === undefined) resolve({ code: null, signal: null, spawnError });
    });
    child.once('close', (code, signal) => {
      resolve({ code, signal, spawnError });
    });
  });
}

function collect(stream: Readable | null, limit: number): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  stream?.on('data', (chunk: Buffer) => {
    if (size >= limit) return;
    const room = limit - size;
    const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
    chunks.push(piece);
    size += piece.length;
  });
  return () => Buffer.concat(chunks).toString('utf8');
}

function failure(label: string, exit: Exit, stderr: string): ProcessError | null {
  if (exit.spawnError !== null) {
    const code = (exit.spawnError as NodeJS.ErrnoException).code ?? exit.spawnError.name;
    return new ProcessError(label, null, null, `could not start (${code})`);
  }
  if (exit.code === 0 && exit.signal === null) return null;
  return new ProcessError(label, exit.code, exit.signal, sanitizeStderr(stderr));
}

async function runCommand(spec: CommandSpec, input?: string): Promise<RunResult> {
  const child = spawnSpec(spec, 'pipe');
  const exited = waitExit(child);
  const stdout = collect(child.stdout, MAX_STDOUT_BYTES);
  const stderr = collect(child.stderr, MAX_STDERR_BYTES);
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(input ?? '');
  const exit = await exited;
  const error = failure(spec.label, exit, stderr());
  if (error !== null) throw error;
  return { stdout: stdout() };
}

async function runPipeline(
  stages: readonly CommandSpec[],
  io: PipelineIo,
): Promise<PipelineResult> {
  if (stages.length === 0) throw new RangeError('a pipeline needs at least one stage');
  const children = stages.map((spec) => spawnSpec(spec, 'pipe'));
  const exits = children.map((child) => waitExit(child));
  const stderrs = children.map((child) => collect(child.stderr, MAX_STDERR_BYTES));
  const killAll = (): void => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
  };

  // A stage that exits early closes its stdin; the writer upstream then sees EPIPE. That
  // is reported through the stage's exit status, not as an unhandled stream error.
  for (const child of children) {
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('error', () => undefined);
  }
  for (let i = 0; i + 1 < children.length; i += 1) {
    const from = children[i]?.stdout;
    const to = children[i + 1]?.stdin;
    if (from && to) from.pipe(to);
  }

  const first = children[0];
  const last = children[children.length - 1];
  const feeding: Promise<void> =
    io.inputFile === undefined
      ? Promise.resolve(first?.stdin?.end()).then(() => undefined)
      : streamPipeline(createReadStream(io.inputFile), first?.stdin as Writable);

  const hash = createHash('sha256');
  let bytes = 0;
  const draining: Promise<void> =
    io.outputFile === undefined
      ? new Promise((resolve) => {
          last?.stdout?.on('end', resolve).on('close', resolve).resume();
        })
      : streamPipeline(
          last?.stdout as Readable,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              bytes += chunk.length;
              callback(null, chunk);
            },
          }),
          createWriteStream(io.outputFile, { flags: 'wx', mode: 0o600 }),
        );

  // When the file side fails first, the stages die of our SIGTERM: the file error is the cause.
  let ioFailed = false;
  const [feed, drain, ...exited] = await Promise.allSettled([
    feeding.catch((error: unknown) => {
      ioFailed = true;
      killAll();
      throw error;
    }),
    draining.catch((error: unknown) => {
      ioFailed = true;
      killAll();
      throw error;
    }),
    ...exits.map((exit) =>
      exit.then((result) => {
        if (result.code !== 0 || result.signal !== null || result.spawnError !== null) killAll();
        return result;
      }),
    ),
  ]);

  const ioError = (): Error | null => {
    if (drain?.status === 'rejected') {
      return new Error(`writing the output failed: ${describeFsError(drain.reason)}`);
    }
    if (feed?.status === 'rejected') {
      return new Error(`reading the input failed: ${describeFsError(feed.reason)}`);
    }
    return null;
  };
  let error: Error | null = ioFailed ? ioError() : null;
  // The first failing stage is the cause; later stages usually fail because of it.
  for (let i = 0; i < stages.length && error === null; i += 1) {
    const settled = exited[i];
    if (settled?.status !== 'fulfilled') continue;
    error = failure(stages[i]?.label ?? 'stage', settled.value, stderrs[i]?.() ?? '');
  }
  error ??= ioError();
  if (error !== null) {
    // Only remove a file this run created: `wx` refused an existing one, which stays.
    if (io.outputFile !== undefined && !isExistError(drain)) {
      await unlink(io.outputFile).catch(() => undefined);
    }
    throw error;
  }
  return { bytes, sha256: hash.digest('hex') };
}

function isExistError(settled: PromiseSettledResult<unknown> | undefined): boolean {
  return (
    settled?.status === 'rejected' &&
    (settled.reason as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
  );
}

function describeFsError(reason: unknown): string {
  const code = (reason as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string') return code;
  return reason instanceof Error ? reason.name : 'unknown error';
}

function startInteractive(spec: CommandSpec): InteractiveSession {
  const child = spawnSpec(spec, 'pipe');
  const exited = waitExit(child);
  const stderr = collect(child.stderr, MAX_STDERR_BYTES);
  child.stdin?.on('error', () => undefined);

  const lines: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  let buffered = '';
  let closed = false;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    let at = buffered.indexOf('\n');
    while (at >= 0) {
      const line = buffered.slice(0, at).replace(/\r$/, '');
      buffered = buffered.slice(at + 1);
      if (line.trim() !== '') {
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else lines.push(line);
      }
      at = buffered.indexOf('\n');
    }
  });
  void exited.then(() => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });

  const exitError = async (): Promise<Error> => {
    const exit = await exited;
    return failure(spec.label, exit, stderr()) ?? new Error(`${spec.label} ended before answering`);
  };

  return {
    writeLine(line: string) {
      child.stdin?.write(`${line}\n`);
    },
    async readLine(timeoutMs = READ_LINE_TIMEOUT_MS) {
      const ready = lines.shift();
      if (ready !== undefined) return ready;
      if (closed) throw await exitError();
      const line = await new Promise<string | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(settle);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`${spec.label} did not answer within ${String(timeoutMs)} ms`));
        }, timeoutMs);
        const settle = (value: string | null): void => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.push(settle);
      });
      if (line === null) throw await exitError();
      return line;
    },
    async end() {
      child.stdin?.end();
      const exit = await exited;
      const error = failure(spec.label, exit, stderr());
      if (error !== null) throw error;
    },
    kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
  };
}
