#!/usr/bin/env node
/**
 * The deploy smoke (review 27 E-5; see `deploy-smoke.ts` for what passes and why).
 *
 *   docker compose exec -T worker node dist/app/deploy-smoke-cli.js
 *
 * `infra/deploy.sh` runs it after restarting the worker and the API; a non-zero exit makes
 * the script redeploy the last good tag. It writes one canonical-JSON report on stdout —
 * probe names and verdicts, never a URL with a token or a response body.
 *
 * Exit codes: 0 — every probe passed in one round before the deadline; 1 — the deadline
 * expired first; 2 — misconfiguration.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { systemClock } from '../adapters/clock/system-clock.js';
import { ConfigError } from './config.js';
import { runSmoke, smokeProbes, type SmokeProbe, type SmokeResponse } from './deploy-smoke.js';
import { loadDeploySmokeConfig } from './deploy-smoke-config.js';
import { processLog } from './logging.js';

const EXIT_FAILED = 1;
const EXIT_MISCONFIGURED = 2;

/** One probe may not eat the whole deadline. */
const PROBE_TIMEOUT_MS = 5_000;

const log = processLog();

async function fetchProbe(probe: SmokeProbe): Promise<SmokeResponse> {
  const response = await fetch(probe.url, {
    headers: { accept: 'application/json', ...probe.headers },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

async function main(): Promise<number> {
  const config = loadDeploySmokeConfig(process.env);
  const probes = smokeProbes(config);
  log.note({
    starting: {
      deploy_smoke: {
        probes: probes.map((probe) => probe.name),
        deadline_ms: config.deadlineMs,
        interval_ms: config.intervalMs,
      },
    },
  });
  const result = await runSmoke(
    probes,
    { fetch: fetchProbe, now: () => systemClock.now(), sleep: (ms) => sleep(ms) },
    config,
  );
  log.event({ deploy_smoke: result });
  return result.passed ? 0 : EXIT_FAILED;
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : EXIT_FAILED;
});
