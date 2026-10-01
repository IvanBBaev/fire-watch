/**
 * `pnpm dev:live` — the whole stack on a developer machine, reading real FIRMS data.
 *
 * One command, in order:
 *
 *  1. a local PostGIS container (`fire-watch-dev-pg`), reused if it is already running;
 *  2. `dbmate up` against it, as the container superuser;
 *  3. the worker and the API from the compiled server (`server/dist`), pointed at it, with
 *     `FIRE_WATCH_FIRMS_MODE=keyless` unless the caller chose a mode — no MAP_KEY needed;
 *  4. the Vite dev server with `VITE_FIRE_WATCH_DATA=live`, which proxies `/snapshot.json`
 *     and `/api` to the API.
 *
 * Ctrl-C stops the three processes and then the container — only if this run started it.
 * The container is stopped, not removed, so the archive survives to the next run;
 * `docker rm fire-watch-dev-pg` resets it.
 *
 * This is a developer tool. Fixtures stay the default for unit tests, e2e and CI (CI-7);
 * nothing here is on any production path.
 *
 * Environment (all optional):
 *  - DOCKER_HOST — defaults to the colima `fwtest` profile socket when that exists.
 *  - FIRE_WATCH_PG_IMAGE — the PostGIS image (default `imresamu/postgis:16-3.4`, which
 *    has an arm64 build; the integration suite's `postgis/postgis` runs emulated on
 *    Apple silicon).
 *  - FIRE_WATCH_DEV_PG_PORT — the host port for Postgres (default 55433, loopback only).
 *  - FIRE_WATCH_FIRMS_MODE, FIRE_WATCH_POLL_INTERVAL_MS (default 300000 here), and every
 *    other server variable — passed through to the worker and the API.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEV_PG_CONTAINER,
  DEV_PG_DATABASE,
  DEV_PG_PASSWORD,
  planDevLive,
  type DevLivePlan,
} from './dev-live-plan.js';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoDir = join(serverDir, '..');

function log(message: string): void {
  process.stdout.write(`[dev:live] ${message}\n`);
}

function docker(plan: DevLivePlan, args: readonly string[]): { ok: boolean; out: string } {
  const result = spawnSync('docker', args, {
    env:
      plan.dockerHost === undefined
        ? process.env
        : { ...process.env, DOCKER_HOST: plan.dockerHost },
    encoding: 'utf8',
  });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
}

/** Returns whether this run started the container (and so must stop it). */
function ensureDatabase(plan: DevLivePlan): boolean {
  const state = docker(plan, ['inspect', '--format', '{{.State.Running}}', DEV_PG_CONTAINER]);
  if (state.ok && state.out === 'true') {
    log(`reusing running container ${DEV_PG_CONTAINER}`);
    return false;
  }
  if (state.ok) {
    log(`starting existing container ${DEV_PG_CONTAINER}`);
    const started = docker(plan, ['start', DEV_PG_CONTAINER]);
    if (!started.ok) throw new Error(`docker start failed: ${started.out}`);
    return true;
  }
  log(
    `creating container ${DEV_PG_CONTAINER} from ${plan.image} on 127.0.0.1:${String(plan.port)}`,
  );
  const created = docker(plan, [
    'run',
    '--detach',
    '--name',
    DEV_PG_CONTAINER,
    '--env',
    `POSTGRES_PASSWORD=${DEV_PG_PASSWORD}`,
    '--env',
    `POSTGRES_DB=${DEV_PG_DATABASE}`,
    '--publish',
    `127.0.0.1:${String(plan.port)}:5432`,
    plan.image,
  ]);
  if (!created.ok) throw new Error(`docker run failed: ${created.out}`);
  return true;
}

async function waitForDatabase(plan: DevLivePlan): Promise<void> {
  // Over TCP inside the container: the image's init phase listens on the socket only, so
  // a TCP answer means the real server is up, not the temporary one that runs the init.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = docker(plan, [
      'exec',
      DEV_PG_CONTAINER,
      'pg_isready',
      '--host',
      '127.0.0.1',
      '--username',
      'postgres',
      '--dbname',
      DEV_PG_DATABASE,
    ]);
    if (ready.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${DEV_PG_CONTAINER} did not become ready within 60 s`);
}

function migrate(plan: DevLivePlan): void {
  log('applying migrations (dbmate up)');
  const result = spawnSync(
    join(serverDir, 'node_modules', '.bin', 'dbmate'),
    ['--no-dump-schema', 'up'],
    { cwd: serverDir, env: { ...process.env, DATABASE_URL: plan.databaseUrl }, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('dbmate up failed');
}

function start(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): ChildProcess {
  log(`starting ${name}`);
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (chunk: Buffer): string =>
    chunk
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => `[${name}] ${line}\n`)
      .join('');
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(prefix(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(prefix(chunk)));
  return child;
}

async function main(): Promise<void> {
  const home = homedir();
  const plan = planDevLive(
    process.env,
    existsSync(join(home, '.colima', 'fwtest', 'docker.sock')),
    home,
  );
  log(`docker: ${plan.dockerHost ?? '<default context>'}`);

  const startedContainer = ensureDatabase(plan);
  const children: ChildProcess[] = [];
  let stopping = false;

  const stop = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
            child.once('exit', () => {
              clearTimeout(force);
              resolve();
            });
            child.kill('SIGTERM');
          }),
      ),
    );
    if (startedContainer) {
      log(`stopping container ${DEV_PG_CONTAINER}`);
      docker(plan, ['stop', DEV_PG_CONTAINER]);
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void stop(0));
  process.once('SIGTERM', () => void stop(0));

  try {
    await waitForDatabase(plan);
    migrate(plan);
  } catch (error) {
    process.stderr.write(`[dev:live] ${error instanceof Error ? error.message : String(error)}\n`);
    await stop(1);
    return;
  }

  const node = process.execPath;
  children.push(
    start('worker', node, [join(serverDir, 'dist', 'app', 'worker.js')], serverDir, plan.serverEnv),
    start('api', node, [join(serverDir, 'dist', 'app', 'api.js')], serverDir, plan.serverEnv),
    start(
      'web',
      join(repoDir, 'web', 'node_modules', '.bin', 'vite'),
      ['--strictPort'],
      join(repoDir, 'web'),
      plan.webEnv,
    ),
  );
  for (const child of children) {
    child.once('exit', (code, signal) => {
      if (stopping) return;
      log(`a process exited (${signal ?? String(code)}); shutting the rest down`);
      void stop(1);
    });
  }
  log('up — web on http://localhost:5173 (Ctrl-C to stop)');
}

void main();
