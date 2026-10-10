/**
 * Arguments, the credential gate and the exit code of the F18 lightning-context archive
 * backfill CLI (TASKS F18; DATA-SOURCES §F18). In its own module, away from the CLI
 * entrypoint, so tests can exercise them without importing a file whose top level runs
 * `main()`.
 *
 * The environment is the worker's (`loadConfig`): DATABASE_URL, FIRE_WATCH_DB_ROLE,
 * FIRE_WATCH_STATE_DIR and the EUMETSAT pair. Without the EUMETSAT credentials nothing can
 * be fetched — the archive's downloads need OAuth — so the run is refused as a
 * misconfiguration before anything is listed or written.
 */

import type { LightningBackfillReport } from '../core/lightning/lightning-context-backfill.js';
import type { LightningConfig, ServerConfig } from './config.js';
import { ConfigError, EUMETSAT_CONSUMER_KEY_ENV, EUMETSAT_CONSUMER_SECRET_ENV } from './config.js';

/**
 * Founder decision: the defaults keep one run small. 50 events and 200 products (about
 * eleven three-hour windows of 18 ten-minute products) is a few hundred megabytes at most;
 * a larger backlog is worked through by running it again, which is idempotent.
 */
export const LIGHTNING_BACKFILL_DEFAULTS = Object.freeze({ maxEvents: 50, maxProducts: 200 });

/** Hard ceilings, so a typo cannot start an unbounded download. */
export const LIGHTNING_BACKFILL_CEILINGS = Object.freeze({ maxEvents: 1_000, maxProducts: 5_000 });

export interface LightningBackfillArgs {
  readonly maxEvents: number;
  readonly maxProducts: number;
}

const USAGE = 'usage: lightning-backfill-cli.js [--max-events=N] [--max-products=N]';

export function parseLightningBackfillArgs(args: readonly string[]): LightningBackfillArgs {
  let maxEvents: number | null = null;
  let maxProducts: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('--max-events=')) {
      if (maxEvents !== null) throw new ConfigError(`--max-events given more than once. ${USAGE}`);
      maxEvents = readCount(arg, '--max-events', 1, LIGHTNING_BACKFILL_CEILINGS.maxEvents);
    } else if (arg.startsWith('--max-products=')) {
      if (maxProducts !== null) {
        throw new ConfigError(`--max-products given more than once. ${USAGE}`);
      }
      maxProducts = readCount(arg, '--max-products', 0, LIGHTNING_BACKFILL_CEILINGS.maxProducts);
    } else {
      // Refused rather than ignored: a mistyped bound must not silently become the default.
      throw new ConfigError(`unknown argument ${JSON.stringify(arg)}. ${USAGE}`);
    }
  }
  return {
    maxEvents: maxEvents ?? LIGHTNING_BACKFILL_DEFAULTS.maxEvents,
    maxProducts: maxProducts ?? LIGHTNING_BACKFILL_DEFAULTS.maxProducts,
  };
}

function readCount(arg: string, flag: string, min: number, max: number): number {
  const text = arg.slice(flag.length + 1);
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(
      `${flag} must be an integer from ${String(min)} to ${String(max)}, got ${JSON.stringify(text)}. ${USAGE}`,
    );
  }
  return value;
}

/** What the backfill needs from the loaded configuration, or a refusal that says why. */
export function requireLightningBackfill(config: Pick<ServerConfig, 'lightning' | 'stateDir'>): {
  readonly lightning: LightningConfig;
  readonly stateDir: string;
} {
  if (config.lightning === null) {
    throw new ConfigError(
      `${EUMETSAT_CONSUMER_KEY_ENV} and ${EUMETSAT_CONSUMER_SECRET_ENV} are not set: the ` +
        'archived LI products cannot be downloaded without them. Nothing was fetched and ' +
        'no lightning context was written.',
    );
  }
  // `loadConfig` already refuses credentials without a state dir; checked again so the
  // type says so.
  if (config.stateDir === null) {
    throw new ConfigError('FIRE_WATCH_STATE_DIR is not set; the backfill keeps its records there.');
  }
  return { lightning: config.lightning, stateDir: config.stateDir };
}

/** 0 — every listed event answered; 3 — some are still incomplete; 1 — something failed. */
export const EXIT_INCOMPLETE = 3;

export function lightningBackfillExitCode(report: LightningBackfillReport): number {
  if (report.error !== null) return 1;
  if (report.events.some((e) => e.outcome === 'failed' || e.outcome === 'search_failed')) {
    return 1;
  }
  if (report.stopped !== null) return 1;
  return report.events.every((e) => e.outcome === 'complete') ? 0 : EXIT_INCOMPLETE;
}
