/**
 * The wall. A granule decoder that runs in someone else's process, so that a file which
 * kills the decoder does not kill us.
 *
 * Review 05 §5.6.2 (E3) asks for exactly five properties of the netCDF/HDF5 leg, and this
 * adapter is where four of them are enforced:
 *
 * - **An isolated process.** `spawn` with `shell: false` — no shell, so no argv of ours is
 *   ever a command of theirs — and `detached: true`, which puts the child in its own
 *   process group. That group is what gets killed: a decoder that forked before it hung
 *   would otherwise leave its children holding the pipe open forever.
 * - **No credentials.** The environment is built from nothing, not filtered from ours.
 *   `DATABASE_URL` and `FIRMS_MAP_KEY` are not excluded by name — they are simply never
 *   added, which is the only form of exclusion that survives a new secret being introduced
 *   next month. `NODE_OPTIONS` is withheld for the same reason it is a CVE: it is code.
 * - **Limits.** A wall-clock deadline and a cap on how many bytes the child may write. The
 *   second is not decoration: the classic decompression bomb does not crash the decoder,
 *   it makes the decoder hand the *parent* a gigabyte, and the parent dies instead.
 * - **A crash is a skipped granule, never a crash loop.** Every failure — spawn failure,
 *   signal, non-zero exit, flood, timeout — becomes a `DecodeResult`. This module has no
 *   rejection path.
 *
 * The fifth property, "output is validated JSON only", is deliberately *not* here: the
 * adapter returns text and `parseGranulePayload` in the core reads it. Parsing at the
 * adapter would put the first `JSON.parse` of attacker-influenced output on the wrong side
 * of the wall.
 *
 * What this cannot do, and does not claim: a Node parent cannot bound a child's memory or
 * CPU. Those are the container's job (`docker run --memory`, `--cpus`) and belong to the
 * deployment, not to this file. What is enforced here is time, output size and reach.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type {
  DecodeOutcome,
  DecodeResult,
  GranuleDecoder,
  GranuleRef,
} from '../../core/ports/granule-decoder.js';

/**
 * The exit code by which a decoder says "I read this file and it is not a granule", as
 * distinct from dying. `EX_DATAERR` from sysexits(3) — an old convention, but a shared one,
 * and the alternative is guessing from stderr.
 */
export const DECODER_REFUSED_EXIT = 65;

/** Variables the child may see, over and above the ones it is given explicitly. */
const INHERITED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'] as const;

/** The ref, as JSON, in the one variable this adapter adds. */
export const GRANULE_REF_ENV = 'FW_GRANULE_REF';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;

/** How long to wait for the pipes after the child is gone before giving up on them. */
const REAP_GRACE_MS = 1_000;

const MAX_STDERR_BYTES = 8 * 1024;
const MAX_ERROR_CHARS = 500;
const MAX_NAME_CHARS = 256;

export interface ChildProcessDecoderOptions {
  /** The executable. Resolved through PATH by the OS, never by a shell. */
  readonly command: string;
  readonly args?: readonly string[];
  /** Wall-clock budget for the whole decode, including process start. */
  readonly timeoutMs?: number;
  /** How much the child may write on stdout before it is treated as a flood. */
  readonly maxOutputBytes?: number;
  /** Grace between SIGTERM and SIGKILL. A decoder that ignores both is still killed. */
  readonly killGraceMs?: number;
  /** Extra environment for the decoder — its own knobs, never our secrets. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/**
 * Builds a decoder that hands each granule to a fresh child process.
 *
 * The contract with that process: the bytes arrive on stdin, the ref arrives as JSON in
 * `FW_GRANULE_REF`, the payload leaves on stdout, diagnostics leave on stderr, and the
 * exit code is 0 for a payload, {@link DECODER_REFUSED_EXIT} for a refusal, anything else
 * for a death.
 */
export function createChildProcessDecoder(options: ChildProcessDecoderOptions): GranuleDecoder {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return {
    decode(ref: GranuleRef, bytes: Uint8Array): Promise<DecodeResult> {
      return new Promise<DecodeResult>((resolve) => {
        const startedAt = performance.now();
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytesOut = 0;
        let stderrBytes = 0;
        let settled = false;
        let flooded = false;
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;
        let reapTimer: NodeJS.Timeout | undefined;

        /**
         * Every timer this decode arms, so that settling clears all of them. Kept as a
         * list rather than as named handles because `finish` can run before some of them
         * exist — a decoder that fails to spawn settles from the `catch` below.
         */
        const timers: NodeJS.Timeout[] = [];
        const track = (timer: NodeJS.Timeout): NodeJS.Timeout => {
          timers.push(timer);
          // Unref'd throughout: a pending decode must never be the reason the process
          // stays alive past a shutdown.
          return timer.unref();
        };

        const finish = (outcome: DecodeOutcome, error: string | null): void => {
          if (settled) return;
          settled = true;
          for (const timer of timers) clearTimeout(timer);
          resolve({
            outcome,
            payload: outcome === 'ok' || outcome === 'refused' ? text(stdout) : null,
            error: error === null ? null : cap(error),
            durationMs: Math.round(performance.now() - startedAt),
            bytesOut,
          });
        };

        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawn(options.command, [...(options.args ?? [])], {
            shell: false,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: childEnv(ref, options.env),
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          });
        } catch (error) {
          // Invalid arguments throw synchronously; a missing binary does not. Both are the
          // same operational fact — there is no decoder — and neither is the granule's fault.
          finish('unavailable', `decoder could not be started: ${describe(error)}`);
          return;
        }

        /** SIGTERM the whole group, then SIGKILL it. Negative pid is the group. */
        const kill = (): void => {
          signal('SIGTERM');
          killTimer ??= track(
            setTimeout(() => {
              signal('SIGKILL');
            }, killGraceMs),
          );
        };

        const signal = (name: NodeJS.Signals): void => {
          const { pid } = child;
          if (pid === undefined) return;
          try {
            process.kill(-pid, name);
          } catch {
            // ESRCH: already gone, which is the outcome we wanted. Any other failure means
            // the group cannot be signalled, and a throw here would defeat the whole point.
            try {
              child.kill(name);
            } catch {
              /* the child is unreachable; the deadline has already decided the result */
            }
          }
        };

        track(
          setTimeout(() => {
            timedOut = true;
            kill();
          }, timeoutMs),
        );

        child.stdout.on('data', (chunk: Buffer) => {
          if (flooded) return;
          bytesOut += chunk.length;
          if (bytesOut > maxOutputBytes) {
            // Drop the chunk that broke the cap rather than keeping a partial payload: a
            // truncated JSON document is not evidence of anything except the flood itself.
            flooded = true;
            kill();
            return;
          }
          stdout.push(chunk);
        });

        child.stderr.on('data', (chunk: Buffer) => {
          if (stderrBytes >= MAX_STDERR_BYTES) return;
          stderrBytes += chunk.length;
          stderr.push(chunk);
        });

        // A decoder that exits before reading its input leaves us writing into a closed
        // pipe. That is an ordinary way for a refusal to look, not an error of ours.
        child.stdin.on('error', () => undefined);
        child.stdout.on('error', () => undefined);
        child.stderr.on('error', () => undefined);
        child.stdin.end(bytes);

        child.on('error', (error) => {
          finish('unavailable', `decoder could not be started: ${describe(error)}`);
        });

        child.on('exit', () => {
          // `close` waits for the pipes, which is what we want — except when a grandchild
          // inherited them and is still holding them open. Then the pipes never close and
          // this timer is the only way out.
          reapTimer ??= track(
            setTimeout(() => {
              finish('crashed', 'decoder exited but left its output pipe open');
            }, REAP_GRACE_MS),
          );
        });

        child.on('close', (code, killedBy) => {
          if (flooded) {
            finish(
              'oversized',
              `decoder wrote more than ${String(maxOutputBytes)} bytes and was killed`,
            );
            return;
          }
          if (timedOut) {
            finish('timed_out', `decoder exceeded ${String(timeoutMs)} ms and was killed`);
            return;
          }
          if (killedBy !== null) {
            finish('crashed', `decoder was terminated by ${killedBy}${diagnostics(stderr)}`);
            return;
          }
          if (code === 0) {
            finish('ok', null);
            return;
          }
          if (code === DECODER_REFUSED_EXIT) {
            finish('refused', `decoder rejected the granule${diagnostics(stderr)}`);
            return;
          }
          finish('crashed', `decoder exited with code ${String(code)}${diagnostics(stderr)}`);
        });
      });
    },
  };
}

/**
 * The child's whole world, built up rather than filtered down. Anything not named here is
 * absent — which is what makes this safe against a secret nobody has invented yet.
 */
export function childEnv(
  ref: GranuleRef,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) env[name] = value;
  // The ref travels as an environment variable, not as argv: the filename is the provider's
  // string, and a granule called `--output=/etc/passwd` must never be able to look like a
  // flag to whatever argument parser the decoder happens to use.
  env[GRANULE_REF_ENV] = JSON.stringify({
    source: ref.source,
    kind: ref.kind,
    slot: ref.slotIso,
    name: ref.name.slice(0, MAX_NAME_CHARS),
  });
  return env;
}

function text(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

/** Whatever the decoder said about itself, on one line and bounded. */
function diagnostics(stderr: readonly Buffer[]): string {
  const said = text(stderr).replace(/\s+/g, ' ').trim();
  return said === '' ? '' : `: ${said}`;
}

function cap(message: string): string {
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
