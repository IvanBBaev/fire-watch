#!/usr/bin/env node
/**
 * Entry point for the clustering parameter fit (TASKS D7). Everything but the process
 * wiring lives in `fit-cli-run.ts`; see it for arguments, refusals and exit codes.
 */

import { detectionUid } from '@fire-watch/contracts/node';

import { systemClock } from '../adapters/clock/system-clock.js';
import { isoFromEpochMs } from '../core/ports/clock.js';
import { ConfigError } from './config.js';
import { runFitCli } from './fit-cli-run.js';
import { processLog } from './logging.js';

const EXIT_MISCONFIGURED = 2;

const log = processLog();

process.exitCode = await runFitCli(process.argv.slice(2), {
  log,
  nowIso: () => isoFromEpochMs(systemClock.now()),
  detectionUid,
  cwd: process.cwd(),
}).catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
