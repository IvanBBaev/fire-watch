/**
 * Configuration and argument parsing for the weekly QA report CLI (TASKS D8). In its own
 * module, away from the CLI entrypoint, so tests can exercise the parsing without
 * importing a file whose top level runs `main()`.
 *
 * Three environment variables:
 *
 *   * DATABASE_URL — required.
 *   * FIRE_WATCH_DB_ROLE — optional, defaulting to `fire_watch_app` (which holds SELECT on
 *     the pipeline tables and INSERT/UPDATE on `qa_weekly_reports`), a bare identifier.
 *   * FIRE_WATCH_POLL_INTERVAL_MS — optional, the worker's own variable with the worker's
 *     default and bounds. Shadow-PLB's first budget is `poll interval + margin`, so a
 *     report must be graded against the interval the week actually ran under; reading the
 *     worker's variable keeps the CLI and the loop on one number.
 *
 * Arguments: `--week=YYYY-Www` **or** `--from=YYYY-MM-DD --to=YYYY-MM-DD` (inclusive UTC
 * days), or neither for the last closed ISO week; and `--out=<directory>`, required.
 */

import {
  isoWeekWindow,
  lastClosedIsoWeek,
  utcDayRangeWindow,
  type ReportWindow,
} from '../core/qa/iso-week.js';
import type { EpochMs } from '../core/ports/clock.js';
import type { Environment } from './config.js';
import { ConfigError, DEFAULT_POLL_INTERVAL_MS } from './config.js';

const DEFAULT_DATABASE_ROLE = 'fire_watch_app';

// The worker's bounds (app/config.ts, unexported there); a mismatch would only make this
// CLI stricter or looser than the loop, never grade against a different number.
const MIN_POLL_INTERVAL_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 3_600_000;

export interface QaReportConfig {
  readonly databaseUrl: string;
  readonly databaseRole: string;
  readonly pollIntervalMs: number;
}

export type QaReportWindowArg =
  | { readonly kind: 'last_closed' }
  | { readonly kind: 'week'; readonly week: string }
  | { readonly kind: 'range'; readonly fromDay: string; readonly toDay: string };

export interface QaReportArgs {
  readonly window: QaReportWindowArg;
  readonly outDir: string;
}

export function loadQaReportConfig(env: Environment): QaReportConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new ConfigError('missing required environment variable(s): DATABASE_URL');
  }
  return {
    databaseUrl,
    databaseRole: readRole(env['FIRE_WATCH_DB_ROLE']?.trim()),
    pollIntervalMs: readPollInterval(env['FIRE_WATCH_POLL_INTERVAL_MS']?.trim()),
  };
}

// Same rule as app/config.ts's unexported `readRole`.
function readRole(role: string | undefined): string {
  if (role === undefined || role === '') return DEFAULT_DATABASE_ROLE;
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new ConfigError(
      `FIRE_WATCH_DB_ROLE must be a lowercase unquoted identifier, got ${JSON.stringify(role)}`,
    );
  }
  return role;
}

// Same rule as app/config.ts's unexported `readPollInterval`.
function readPollInterval(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_POLL_INTERVAL_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < MIN_POLL_INTERVAL_MS || ms > MAX_POLL_INTERVAL_MS) {
    throw new ConfigError(
      `FIRE_WATCH_POLL_INTERVAL_MS must be an integer between ${String(MIN_POLL_INTERVAL_MS)} ` +
        `and ${String(MAX_POLL_INTERVAL_MS)} ms, got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

const USAGE =
  'usage: qa-report-cli [--week=YYYY-Www | --from=YYYY-MM-DD --to=YYYY-MM-DD] --out=<directory>';

export function parseQaReportArgs(args: readonly string[]): QaReportArgs {
  let week: string | null = null;
  let from: string | null = null;
  let to: string | null = null;
  let outDir: string | null = null;
  const once = (current: string | null, flag: string, value: string): string => {
    if (current !== null) throw new ConfigError(`${flag} given more than once. ${USAGE}`);
    if (value === '') throw new ConfigError(`${flag} needs a value. ${USAGE}`);
    return value;
  };
  for (const arg of args) {
    if (arg.startsWith('--week=')) week = once(week, '--week', arg.slice('--week='.length));
    else if (arg.startsWith('--from=')) from = once(from, '--from', arg.slice('--from='.length));
    else if (arg.startsWith('--to=')) to = once(to, '--to', arg.slice('--to='.length));
    else if (arg.startsWith('--out=')) outDir = once(outDir, '--out', arg.slice('--out='.length));
    else throw new ConfigError(`unknown argument ${JSON.stringify(arg)}. ${USAGE}`);
  }
  if (outDir === null) throw new ConfigError(`--out is required. ${USAGE}`);

  if (week !== null) {
    if (from !== null || to !== null) {
      throw new ConfigError(`--week excludes --from/--to. ${USAGE}`);
    }
    validate(() => isoWeekWindow(week), '--week');
    return { window: { kind: 'week', week }, outDir };
  }
  if (from === null && to === null) return { window: { kind: 'last_closed' }, outDir };
  if (from === null || to === null) throw new ConfigError(`--from and --to go together. ${USAGE}`);
  const [fromDay, toDay] = [from, to];
  validate(() => utcDayRangeWindow(fromDay, toDay), '--from/--to');
  return { window: { kind: 'range', fromDay, toDay }, outDir };
}

function validate(check: () => unknown, flag: string): void {
  try {
    check();
  } catch (error) {
    throw new ConfigError(
      `${flag}: ${error instanceof Error ? error.message : String(error)}. ${USAGE}`,
    );
  }
}

/** The window the arguments name, relative to `nowMs` for the default. */
export function resolveReportWindow(arg: QaReportWindowArg, nowMs: EpochMs): ReportWindow {
  switch (arg.kind) {
    case 'last_closed':
      return lastClosedIsoWeek(nowMs);
    case 'week':
      return isoWeekWindow(arg.week);
    case 'range':
      return utcDayRangeWindow(arg.fromDay, arg.toDay);
  }
}

/**
 * The output files' shared stem: `qa-weekly-2026-W38`, or `qa-range-2026-09-01_2026-09-10`
 * for an ad-hoc range (inclusive days, as given).
 */
export function reportFileStem(arg: QaReportWindowArg, window: ReportWindow): string {
  if (window.isoWeek !== null) return `qa-weekly-${window.isoWeek}`;
  if (arg.kind === 'range') return `qa-range-${arg.fromDay}_${arg.toDay}`;
  throw new Error('an unlabelled window can only come from --from/--to');
}

/** Safe to print: the password never leaves the URL object. */
export function describeQaReportConfig(config: QaReportConfig): Record<string, string | number> {
  return {
    database: redactUrl(config.databaseUrl),
    database_role: config.databaseRole,
    poll_interval_ms: config.pollIntervalMs,
  };
}

// Local copy of app/config.ts's unexported helper (same behavior, verbatim rules).
function redactUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return '<unparseable DATABASE_URL>';
  }
  const user = url.username === '' ? '' : `${url.username}@`;
  return `${url.protocol}//${user}${url.host}${url.pathname}`;
}
