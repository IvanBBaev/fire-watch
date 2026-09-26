#!/usr/bin/env node
/**
 * One ingest cycle, by hand (TASKS C1).
 *
 *   node server/dist/app/ingest-cli.js
 *
 * The scheduled path is `worker.ts`; this is the same wiring run exactly once, for the
 * cases where a loop is the wrong shape: a smoke test after a deploy, a backfill of a
 * window the worker was down for, or an operator asking "does this VM reach FIRMS at all"
 * without leaving a process behind.
 *
 * Its exit code is therefore stricter than the worker's: nothing recorded means failure
 * (1), a missing variable means misconfiguration (2). A human ran it and is waiting for
 * an answer.
 *
 * The report goes to stdout as canonical JSON — one line, sorted keys, so two cycles can
 * be diffed and a log search can find a source by name.
 */

import { cycleFailed, runIngestCycle } from '../core/ingest/ingest-cycle.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { wireIngest } from './ingest-wiring.js';
import { processLog } from './logging.js';

const APPLICATION_NAME = 'fire-watch-ingest';

/** A misconfiguration is not a data problem, and the exit code says which one it was. */
const EXIT_MISCONFIGURED = 2;

/** Redacting from the first line, including the one that reports a config failure (C8). */
const log = processLog();

async function main(): Promise<number> {
  const config = loadConfig(process.env, APPLICATION_NAME);
  log.note({ starting: describeConfig(config) });

  const wiring = wireIngest(config);
  try {
    const report = await runIngestCycle(wiring.deps);

    // Through the sink, not `process.stdout`: the report carries each source's error
    // string verbatim, and a FIRMS error string is where a key would appear.
    log.event({ ingest_cycle: report });
    return cycleFailed(report) ? 1 : 0;
  } finally {
    // Ends the pool even when the cycle threw, so a failing run does not leave a
    // connection behind on every invocation until the server runs out of them.
    await wiring.close();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  // A cycle records its own failures; reaching here means the wiring itself failed —
  // no key, no database, a role the login user is not a member of.
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
