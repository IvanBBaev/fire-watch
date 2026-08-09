#!/usr/bin/env node
/**
 * The API process: the probe surface, and for now nothing else.
 *
 *   node server/dist/app/api.js
 *
 * Separate from the worker on purpose (OPERATIONS §9.1): scheduling lives in the worker,
 * never in the API process. If the two shared a process, a long cycle would make the health
 * endpoint slow exactly when it is being asked whether things are slow — and a restart of
 * the API would silently skip a poll.
 *
 * Shutdown drains in-flight requests before releasing the pool, so a rolling deploy never
 * answers a probe with a connection error it caused itself.
 */

import { canonicalJson } from '../core/determinism/canonical-json.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { wireHealthServer } from './health-wiring.js';

const APPLICATION_NAME = 'fire-watch-api';

/** A misconfiguration is not a data problem, and the exit code says which one it was. */
const EXIT_MISCONFIGURED = 2;

async function main(): Promise<number> {
  const config = loadConfig(process.env, APPLICATION_NAME);
  process.stderr.write(`${canonicalJson({ starting: describeConfig(config) })}\n`);

  const wiring = wireHealthServer(config);
  await wiring.listen();
  process.stderr.write(`${canonicalJson({ listening: true })}\n`);

  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      // The first signal, of either kind, starts the drain — and removes *both* listeners,
      // so that a second signal of either kind finds none and reaches Node's default
      // handler, which ends the process. An operator who asks twice gets to be obeyed
      // even when the drain is hung, and even when they mixed SIGTERM with SIGINT.
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      process.stderr.write(`${canonicalJson({ stopping: { signal } })}\n`);
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });

  await wiring.close();
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
