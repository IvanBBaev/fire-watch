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

import { canonicalJson } from '../core/determinism/canonical-json.js';
import { cycleFailed, runIngestCycle } from '../core/ingest/ingest-cycle.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { wireIngest } from './ingest-wiring.js';

const APPLICATION_NAME = 'fire-watch-ingest';

/** A misconfiguration is not a data problem, and the exit code says which one it was. */
const EXIT_MISCONFIGURED = 2;

async function main(): Promise<number> {
  const config = loadConfig(process.env, APPLICATION_NAME);
  process.stderr.write(`${canonicalJson({ starting: describeConfig(config) })}\n`);

  const wiring = wireIngest(config);
  try {
    const report = await runIngestCycle(wiring.deps);

    process.stdout.write(`${canonicalJson({ ingest_cycle: report })}\n`);
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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
