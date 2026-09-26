#!/usr/bin/env node
/**
 * The API process: the probe surface, the T1 snapshot and the T0 stream, and nothing else.
 *
 *   node server/dist/app/api.js
 *
 * Separate from the worker on purpose (OPERATIONS §9.1): scheduling lives in the worker,
 * never in the API process. If the two shared a process, a long cycle would make the health
 * endpoint slow exactly when it is being asked whether things are slow — and a restart of
 * the API would silently skip a poll.
 *
 * Shutdown drains in-flight requests before releasing the pools, so a rolling deploy never
 * answers a probe with a connection error it caused itself; open streams are told when to
 * reconnect and closed first, because a server waiting on them would never close at all.
 */

import { startApi } from './api-composition.js';
import { ConfigError } from './config.js';
import { processLog } from './logging.js';

/** A misconfiguration is not a data problem, and the exit code says which one it was. */
const EXIT_MISCONFIGURED = 2;

/** Redacting from the first line, including the one that reports a config failure (C8). */
const log = processLog();

async function main(): Promise<number> {
  // The composition lives in api-composition.ts so that the integration test boots
  // exactly this process's wiring; what remains here is the signal handling.
  const api = await startApi(process.env, log);

  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      // The first signal, of either kind, starts the drain — and removes *both* listeners,
      // so that a second signal of either kind finds none and reaches Node's default
      // handler, which ends the process. An operator who asks twice gets to be obeyed
      // even when the drain is hung, and even when they mixed SIGTERM with SIGINT.
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      log.note({ stopping: { signal } });
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });

  await api.close();
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
