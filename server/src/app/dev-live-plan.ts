/**
 * What `pnpm dev:live` (see `dev-live-cli.ts`) will run, decided from the caller's
 * environment. Pure, so the decisions — ports, the Docker socket, which FIRMS mode the
 * server gets, that the web build reads live data — are testable without Docker.
 */

import { join } from 'node:path';

export const DEV_PG_CONTAINER = 'fire-watch-dev-pg';
export const DEV_PG_IMAGE = 'imresamu/postgis:16-3.4';
export const DEV_PG_PORT = 55_433;
/** Five minutes: frequent enough to watch data land, polite to NASA's file server. */
export const DEV_POLL_INTERVAL_MS = 300_000;
export const DEV_PG_PASSWORD = 'fire_watch_dev';
export const DEV_PG_DATABASE = 'fire_watch';

export interface DevLivePlan {
  readonly dockerHost: string | undefined;
  readonly image: string;
  readonly port: number;
  /** As the container superuser: migrations need it, and the runtime role is SET ROLE. */
  readonly databaseUrl: string;
  /** The environment the worker and the API run with. */
  readonly serverEnv: Readonly<Record<string, string>>;
  /** The environment the Vite dev server runs with. */
  readonly webEnv: Readonly<Record<string, string>>;
}

/** Everything the run decides, from the caller's environment — pure, so it is testable. */
export function planDevLive(
  env: Readonly<Record<string, string | undefined>>,
  fwtestSocketExists: boolean,
  home: string,
): DevLivePlan {
  const port = readPort(env['FIRE_WATCH_DEV_PG_PORT']);
  const dockerHost =
    env['DOCKER_HOST'] ??
    (fwtestSocketExists ? `unix://${join(home, '.colima', 'fwtest', 'docker.sock')}` : undefined);
  const databaseUrl =
    `postgres://postgres:${DEV_PG_PASSWORD}@127.0.0.1:${String(port)}/${DEV_PG_DATABASE}` +
    '?sslmode=disable';
  const inherited = definedOnly(env);
  return {
    dockerHost,
    image: nonBlank(env['FIRE_WATCH_PG_IMAGE']) ?? DEV_PG_IMAGE,
    port,
    databaseUrl,
    serverEnv: {
      ...inherited,
      DATABASE_URL: databaseUrl,
      FIRE_WATCH_FIRMS_MODE: nonBlank(env['FIRE_WATCH_FIRMS_MODE']) ?? 'keyless',
      FIRE_WATCH_POLL_INTERVAL_MS:
        nonBlank(env['FIRE_WATCH_POLL_INTERVAL_MS']) ?? String(DEV_POLL_INTERVAL_MS),
    },
    webEnv: { ...inherited, VITE_FIRE_WATCH_DATA: 'live' },
  };
}

function readPort(raw: string | undefined): number {
  const value = nonBlank(raw);
  if (value === undefined) return DEV_PG_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new RangeError(`FIRE_WATCH_DEV_PG_PORT must be a port in 1024..65535, got ${value}`);
  }
  return port;
}

function nonBlank(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function definedOnly(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}
