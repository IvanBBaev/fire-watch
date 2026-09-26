/**
 * The account routes through the production wiring against a real Postgres (TASKS I2, I4,
 * I6): no `createSurface`, so the session guard, the eraser, the zone creator and the
 * exporter are exactly the ones `wireAuthRoutes` builds, over its own pools, as the
 * runtime role.
 *
 * What a unit test cannot show: that a session cookie resolves through `account_sessions`,
 * that `DELETE /api/v1/account` goes through `createPgAccountEraser` (the account is
 * tombstoned and its ledger row written, and the cookie stops working), and that a zone
 * created over HTTP comes back from the list and the export decrypted.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNT_EXPORT_PATH } from '../adapters/http/account-export-route.js';
import { ACCOUNT_PATH } from '../adapters/http/account-route.js';
import { SESSION_COOKIE_NAME } from '../adapters/http/session-cookie.js';
import { ZONES_PATH } from '../adapters/http/zones-route.js';
import { wireAuthRoutes, type AuthWiring } from './auth-wiring.js';
import { loadConfig, type Environment } from './config.js';

const execFileAsync = promisify(execFile);

const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';
const ORIGIN = 'https://app.example.invalid';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const dbmateBin = fileURLToPath(new URL('../../node_modules/.bin/dbmate', import.meta.url));

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker && process.env['FIRE_WATCH_REQUIRE_DOCKER'] === '1') {
  throw new Error(
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The account routes ' +
      'are only ever run against Postgres here, so skipping them in CI is a false green.',
  );
}

function env(databaseUrl: string): Environment {
  return {
    DATABASE_URL: databaseUrl,
    FIRMS_MAP_KEY: '0123456789abcdef0123456789abcdef',
    FIRE_WATCH_AUTH_ENABLED: 'true',
    FIRE_WATCH_AUTH_MAIL_FROM: 'sign-in@auth.example.invalid',
    FIRE_WATCH_AUTH_MAIL_DOMAIN: 'auth.example.invalid',
    FIRE_WATCH_AUTH_LANDING_URL: `${ORIGIN}/sign-in`,
    FIRE_WATCH_AUTH_ALLOWED_ORIGINS: ORIGIN,
    FIRE_WATCH_SES_REGION: 'eu-central-1',
    FIRE_WATCH_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    FIRE_WATCH_SES_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    FIRE_WATCH_SES_FROM_ADDRESS: 'alerts@alerts.example.invalid',
  };
}

describe.skipIf(!hasDocker)('account routes through the production wiring', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let server: FastifyInstance;
  let wiring: AuthWiring;

  /** An account with a live session; returns the cookie a browser would send. */
  async function signedInAccount(): Promise<{ accountId: string; cookie: string }> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (timezone, email, email_verified_at)
       VALUES ('Europe/Sofia', $1, now()) RETURNING id`,
      [`routes-${randomUUID()}@example.org`],
    );
    const accountId = rows[0]?.id ?? '';
    const token = randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO account_sessions (token_hash, account_id, ua_family, created_at,
                                     last_seen_at, expires_at)
       VALUES ($1, $2, 'firefox', now(), now(), now() + interval '1 day')`,
      [createHash('sha256').update(token, 'utf8').digest(), accountId],
    );
    return { accountId, cookie: `${SESSION_COOKIE_NAME}=${token}` };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    db = new Client({ connectionString: databaseUrl });
    await db.connect();

    server = Fastify({ logger: false });
    wiring = wireAuthRoutes(server, loadConfig(env(databaseUrl), 'fire-watch-api-test'), {
      onProblem: () => undefined,
      zoneKeyring: { active: { id: 'itest-1', key: randomBytes(32) }, retired: [] },
    });
    await server.ready();
  }, 180_000);

  afterAll(async () => {
    await server.close();
    await wiring.close();
    await db.end();
    await container.stop();
  });

  it('answers GET /api/v1/account for a live session and 401 for none', async () => {
    const { cookie } = await signedInAccount();
    const me = await server.inject({ method: 'GET', url: ACCOUNT_PATH, headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ signed_in: true });
    const anonymous = await server.inject({ method: 'GET', url: ACCOUNT_PATH });
    expect(anonymous.statusCode).toBe(401);
  });

  it('creates a zone, lists it and exports it, decrypted, for its owner only', async () => {
    const owner = await signedInAccount();
    const other = await signedInAccount();
    const created = await server.inject({
      method: 'POST',
      url: ZONES_PATH,
      headers: { origin: ORIGIN, cookie: owner.cookie },
      payload: { name: 'Home', lat: 42.58, lon: 23.28 },
    });
    expect(created.statusCode).toBe(201);

    const listed = await server.inject({
      method: 'GET',
      url: ZONES_PATH,
      headers: { cookie: owner.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).toContain('Home');

    const othersList = await server.inject({
      method: 'GET',
      url: ZONES_PATH,
      headers: { cookie: other.cookie },
    });
    expect(JSON.stringify(othersList.json())).not.toContain('Home');

    const exported = await server.inject({
      method: 'GET',
      url: ACCOUNT_EXPORT_PATH,
      headers: { cookie: owner.cookie },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain('Home');
  });

  it('erases through createPgAccountEraser: tombstone, ledger row, and a dead cookie', async () => {
    const { accountId, cookie } = await signedInAccount();
    const erased = await server.inject({
      method: 'DELETE',
      url: ACCOUNT_PATH,
      headers: { origin: ORIGIN, cookie },
    });
    expect(erased.statusCode).toBe(204);

    const { rows } = await db.query<{ deleted: boolean; email: string | null }>(
      'SELECT deleted_at IS NOT NULL AS deleted, email FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(rows[0]?.deleted).toBe(true);
    expect(rows[0]?.email).toBeNull();
    const { rows: ledger } = await db.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM erasure_requests
       WHERE account_hash = sha256(convert_to($1::text, 'UTF8'))`,
      [accountId],
    );
    expect(ledger[0]?.n).toBe(1);

    const after = await server.inject({ method: 'GET', url: ACCOUNT_PATH, headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});
