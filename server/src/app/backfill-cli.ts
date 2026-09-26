#!/usr/bin/env node
/**
 * The FIRMS 2020–2025 SP backfill (TASKS B8; OPERATIONS §6.4).
 *
 *   node server/dist/app/backfill-cli.js           # download what the manifest lacks
 *   node server/dist/app/backfill-cli.js --check   # re-hash the archive, no network
 *
 * Resumable by design: Ctrl+C (or SIGTERM) finishes nothing mid-file — the pause aborts,
 * the in-flight chunk completes or fails, the manifest is persisted, and the next
 * invocation picks up at the first chunk the manifest does not vouch for. Interrupting
 * and rerunning is the normal way to operate this job, so a clean abort exits 0, like
 * the worker.
 *
 * One canonical-JSON line per chunk goes to stdout; the summary is the last line.
 */

import { createFsArchiveStore } from '../adapters/backfill/fs-archive-store.js';
import { systemClock } from '../adapters/clock/system-clock.js';
import { createFirmsHttpClient } from '../adapters/firms/firms-http-client.js';
import { systemSleeper } from '../adapters/scheduler/system-sleeper.js';
import { backfillJob } from '../core/backfill/backfill-plan.js';
import { checkArchive, runBackfill } from '../core/backfill/backfill-run.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { describeBackfillConfig, loadBackfillConfig } from './backfill-config.js';
import { ConfigError } from './config.js';
import { processLog } from './logging.js';

/** A misconfiguration is not a data problem, and the exit code says which one it was. */
const EXIT_MISCONFIGURED = 2;

/**
 * Redacting from the first line. This job is the one that hands the FIRMS map key to the
 * HTTP client for 70 minutes at a stretch, so every chunk line it writes is a line that
 * could carry the key back out of a failed request (C8).
 */
const log = processLog();

function parseMode(args: readonly string[]): 'run' | 'check' {
  if (args.length === 0) return 'run';
  if (args.length === 1 && args[0] === '--check') return 'check';
  // Refused rather than ignored: a mistyped `--chekc` that silently starts a 70-minute
  // download against a live API is worse than an exit-2 asking the operator to look.
  throw new ConfigError(`unknown argument(s): ${args.join(' ')}. Usage: backfill-cli.js [--check]`);
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));
  const config = loadBackfillConfig(process.env);
  const store = createFsArchiveStore(config.archiveDir);
  const job = backfillJob();
  const writeLine = (line: string): void => {
    log.line(line);
  };

  log.note({
    starting: {
      ...describeBackfillConfig(config),
      mode,
      plan: job.plan,
      plan_digest: job.planDigest,
      chunks: String(job.chunks.length),
    },
  });

  if (mode === 'check') {
    const summary = await checkArchive(job, { store, writeLine });
    writeLine(canonicalJson({ backfill_check_run: summary }));
    return summary.mismatched + summary.missing > 0 ? 1 : 0;
  }

  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    // First signal of either kind starts the drain and stands down BOTH handlers, so a
    // second SIGTERM/SIGINT reaches the default handler and ends the process (worker.ts).
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    log.note({ stopping: { signal } });
    controller.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const summary = await runBackfill(job, {
    client: createFirmsHttpClient({
      mapKey: config.firmsMapKey,
      clock: systemClock,
      baseUrl: config.firmsBaseUrl,
    }),
    store,
    clock: systemClock,
    sleeper: systemSleeper,
    signal: controller.signal,
    delayMs: config.requestDelayMs,
    writeLine,
  });

  writeLine(canonicalJson({ backfill_run: summary }));
  // An aborted run exits 0 — being interrupted and resumed is this job's normal life.
  // Failed chunks exit 1 so a wrapper script knows a rerun is needed.
  return summary.failed > 0 ? 1 : 0;
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
