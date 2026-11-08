/**
 * Configuration for `deploy-smoke-cli.ts`. The smoke runs inside the worker container
 * (`docker compose exec -T worker …`), which is why its defaults are the compose service
 * name for the API and the worker's own loopback for the metrics listener: that listener
 * is never published, and the bearer token is a file only the containers mount.
 */

import type { Environment } from './config.js';
import { ConfigError } from './config.js';
import type { SecretFileReader } from './metrics-config.js';
import { loadMetricsConfig } from './metrics-config.js';
import type { SmokeOptions, SmokeTargets } from './deploy-smoke.js';

export const DEFAULT_SMOKE_API_URL = 'http://api:8080';
export const DEFAULT_SMOKE_DEADLINE_MS = 120_000;
export const DEFAULT_SMOKE_INTERVAL_MS = 3_000;

export interface DeploySmokeConfig extends SmokeTargets, SmokeOptions {}

function positiveInt(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

export function loadDeploySmokeConfig(
  env: Environment,
  readFile?: SecretFileReader,
): DeploySmokeConfig {
  const apiUrl = env['FIRE_WATCH_SMOKE_API_URL']?.trim() || DEFAULT_SMOKE_API_URL;
  if (!/^https?:\/\//.test(apiUrl)) {
    throw new ConfigError(`FIRE_WATCH_SMOKE_API_URL must be an http(s) URL, got ${apiUrl}`);
  }

  // The worker's own listener, read exactly as the worker reads it, so the smoke cannot
  // probe a port the worker did not bind.
  const apiPort = positiveInt(env, 'FIRE_WATCH_API_PORT', 8080);
  const metrics = loadMetricsConfig(env, apiPort, readFile);
  const metaUrl = metrics === null ? null : `http://127.0.0.1:${String(metrics.port)}`;
  const metaToken = metrics === null ? null : metrics.bearerToken;

  return {
    apiUrl,
    metaUrl,
    metaToken,
    deadlineMs: positiveInt(env, 'FIRE_WATCH_SMOKE_DEADLINE_MS', DEFAULT_SMOKE_DEADLINE_MS),
    intervalMs: positiveInt(env, 'FIRE_WATCH_SMOKE_INTERVAL_MS', DEFAULT_SMOKE_INTERVAL_MS),
  };
}
