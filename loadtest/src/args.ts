/**
 * The CLI's argument grammar, pure so every flag is unit-tested without a process.
 *
 *   run   --base-url <url> [--t2-url <url>] [--baseline <file>] [--multiplier 50]
 *         [--scale 1] [--sse-cap 5000] [--shard i/n] [--ramp-s 120] [--steady-s 600]
 *         [--origin-kill-s 300] [--kill-origin-cmd <shell>] [--cache-status-header cf-cache-status]
 *         [--seed 1] [--max-in-flight 20000] [--out <file>] [--dry-run]
 *   merge <report.json>... [--out <file>]
 */

import { DEFAULT_DURATIONS_MS } from './scenario.js';

export interface RunArgs {
  readonly command: 'run';
  readonly baseUrl: string;
  readonly t2Url: string | null;
  readonly baselineFile: string | null;
  readonly multiplier: number;
  readonly scale: number;
  readonly sseCap: number;
  readonly shard: { readonly index: number; readonly count: number };
  readonly durationsMs: {
    readonly ramp: number;
    readonly steady: number;
    readonly originKill: number;
  };
  readonly killOriginCmd: string | null;
  readonly cacheStatusHeader: string;
  readonly seed: number;
  readonly maxInFlight: number;
  readonly out: string | null;
  readonly dryRun: boolean;
}

export interface MergeArgs {
  readonly command: 'merge';
  readonly inputs: readonly string[];
  readonly out: string | null;
}

export type CliArgs = RunArgs | MergeArgs;

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export const USAGE = `usage:
  loadtest run --base-url <url> [--t2-url <url>] [--baseline <file.json>]
               [--multiplier 50] [--scale 1] [--sse-cap 5000] [--shard i/n]
               [--ramp-s 120] [--steady-s 600] [--origin-kill-s 300]
               [--kill-origin-cmd "<shell command>"] [--cache-status-header cf-cache-status]
               [--seed 1] [--max-in-flight 20000] [--out report.json] [--dry-run]
  loadtest merge <shard-report.json>... [--out report.json]

exit: 0 pass · 1 fail · 2 usage error · 3 invalid or incomplete run`;

const RUN_VALUE_FLAGS = new Set([
  '--base-url',
  '--t2-url',
  '--baseline',
  '--multiplier',
  '--scale',
  '--sse-cap',
  '--shard',
  '--ramp-s',
  '--steady-s',
  '--origin-kill-s',
  '--kill-origin-cmd',
  '--cache-status-header',
  '--seed',
  '--max-in-flight',
  '--out',
]);

export function parseArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command === 'run') return parseRun(rest);
  if (command === 'merge') return parseMerge(rest);
  throw new UsageError(command === undefined ? 'missing command' : `unknown command: ${command}`);
}

function parseRun(argv: readonly string[]): RunArgs {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!RUN_VALUE_FLAGS.has(flag)) throw new UsageError(`unknown flag: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new UsageError(`${flag} needs a value`);
    if (values.has(flag)) throw new UsageError(`${flag} given twice`);
    values.set(flag, value);
    i += 1;
  }

  const baseUrl = values.get('--base-url');
  if (baseUrl === undefined) throw new UsageError('--base-url is required');
  const t2Url = values.get('--t2-url') ?? null;
  const killOriginCmd = values.get('--kill-origin-cmd') ?? null;
  const originKillS = number(values, '--origin-kill-s', DEFAULT_DURATIONS_MS.originKill / 1000, 0);
  if (originKillS > 0 && t2Url === null) {
    throw new UsageError('an origin-kill phase needs --t2-url (or pass --origin-kill-s 0)');
  }

  return {
    command: 'run',
    baseUrl: url(baseUrl, '--base-url'),
    t2Url: t2Url === null ? null : url(t2Url, '--t2-url'),
    baselineFile: values.get('--baseline') ?? null,
    multiplier: number(values, '--multiplier', 50, Number.MIN_VALUE),
    scale: number(values, '--scale', 1, Number.MIN_VALUE),
    sseCap: integer(values, '--sse-cap', 5000, 1),
    shard: shard(values.get('--shard') ?? '1/1'),
    durationsMs: {
      ramp: number(values, '--ramp-s', DEFAULT_DURATIONS_MS.ramp / 1000, Number.MIN_VALUE) * 1000,
      steady:
        number(values, '--steady-s', DEFAULT_DURATIONS_MS.steady / 1000, Number.MIN_VALUE) * 1000,
      originKill: originKillS * 1000,
    },
    killOriginCmd,
    cacheStatusHeader: (values.get('--cache-status-header') ?? 'cf-cache-status').toLowerCase(),
    seed: integer(values, '--seed', 1, 0),
    maxInFlight: integer(values, '--max-in-flight', 20_000, 1),
    out: values.get('--out') ?? null,
    dryRun,
  };
}

function parseMerge(argv: readonly string[]): MergeArgs {
  const inputs: string[] = [];
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError('--out needs a value');
      out = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown flag: ${arg}`);
    } else {
      inputs.push(arg);
    }
  }
  if (inputs.length === 0) throw new UsageError('merge needs at least one report');
  return { command: 'merge', inputs, out };
}

function number(values: Map<string, string>, flag: string, fallback: number, min: number): number {
  const raw = values.get(flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < min) {
    throw new UsageError(
      min === Number.MIN_VALUE
        ? `${flag} must be a positive number`
        : `${flag} must be a number ≥ ${min}`,
    );
  }
  return value;
}

function integer(values: Map<string, string>, flag: string, fallback: number, min: number): number {
  const value = number(values, flag, fallback, min);
  if (!Number.isInteger(value)) throw new UsageError(`${flag} must be an integer`);
  return value;
}

function url(value: string, flag: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UsageError(`${flag} is not a URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`${flag} must be http(s)`);
  }
  return value.replace(/\/+$/, '');
}

function shard(value: string): { index: number; count: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || index < 1 || count < 1 || index > count) {
    throw new UsageError('--shard must be i/n with 1 ≤ i ≤ n');
  }
  return { index, count };
}
