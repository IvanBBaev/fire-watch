/**
 * Configuration and argument parsing for the nightly backup and the restore CLIs (TASKS
 * C6; OPERATIONS §6.2, §6.3). In its own module, away from the entrypoints, so tests can
 * exercise it without importing a file whose top level runs `main()`; and away from
 * `app/config.ts` because only these two jobs may ever hold a backup credential.
 *
 * The two sides hold **different** credentials, deliberately (§6.2): the VM's token is
 * write-only, so a compromised VM cannot read or delete history, and the restore's read
 * token lives with the operator, not on the VM.
 *
 * Backup (`loadBackupConfig`):
 *
 *   * Store — exactly one of:
 *     - FIRE_WATCH_BACKUP_R2_{ENDPOINT,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY}, together or
 *       not at all: the write-only R2 token;
 *     - FIRE_WATCH_BACKUP_LOCAL_DIR: an absolute directory (a second disk, a drill).
 *   * BACKUP_AGE_RECIPIENT — required, the age public key (`age1…`); not a secret.
 *   * FIRE_WATCH_BACKUP_PG_EXEC — optional, the words run before `psql`/`pg_dump`; default
 *     `docker compose exec -T postgres`; `none` runs the host's tools directly.
 *   * PGUSER (default `postgres`), PGDATABASE (default `fire_watch`).
 *   * BACKUP_STAGING (default `/var/backups/fire-watch`), absolute.
 *   * BACKUP_KEEP_LOCAL — `0` or `1` (default `1`): keep tonight's main artifact staged.
 *   * FIRE_WATCH_HEARTBEAT_URL — optional; the `nightly-backup` check is pinged under it.
 *
 * Restore (`loadRestoreConfig`):
 *
 *   * Store — FIRE_WATCH_RESTORE_R2_{…} (the separate read token) or
 *     FIRE_WATCH_RESTORE_LOCAL_DIR.
 *   * FIRE_WATCH_RESTORE_AGE_IDENTITY — required, absolute path of the age identity file.
 *   * FIRE_WATCH_BACKUP_PG_EXEC, PGUSER as above; FIRE_WATCH_RESTORE_MAINTENANCE_DB
 *     (default `postgres`), the database `CREATE DATABASE` runs in.
 *   * FIRE_WATCH_RESTORE_WORKDIR (default `/var/backups/fire-watch/restore`), absolute.
 *
 * **No value ever reaches an error or a log line.** Messages name variables; the describe
 * functions print hosts, buckets and directories, and say only whether credentials are set.
 * The identity path is not printed either.
 */

import { isAbsolute } from 'node:path';

import { assertPingBaseUrl } from '../adapters/monitoring/healthchecks-heartbeat.js';
import type { Environment } from './config.js';
import { ConfigError } from './config.js';

export const DEFAULT_PG_EXEC = ['docker', 'compose', 'exec', '-T', 'postgres'] as const;
export const DEFAULT_BACKUP_STAGING = '/var/backups/fire-watch';
export const DEFAULT_RESTORE_WORKDIR = '/var/backups/fire-watch/restore';

export type BackupStoreConfig =
  | {
      readonly kind: 'r2';
      readonly endpoint: string;
      readonly bucket: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
    }
  | { readonly kind: 'local'; readonly directory: string };

export interface PgToolsConfig {
  readonly execPrefix: readonly string[];
  readonly user: string;
}

export interface BackupConfig {
  readonly store: BackupStoreConfig;
  readonly ageRecipient: string;
  readonly pg: PgToolsConfig;
  readonly database: string;
  readonly stagingDir: string;
  readonly keepLocalMain: 0 | 1;
  readonly heartbeatUrl: string | null;
}

export interface RestoreConfig {
  readonly store: BackupStoreConfig;
  readonly ageIdentityFile: string;
  readonly pg: PgToolsConfig;
  readonly maintenanceDatabase: string;
  readonly workDir: string;
}

export interface BackupArgs {
  readonly dryRun: boolean;
}

export interface RestoreArgs {
  readonly database: string;
  readonly mainKey: string | null;
  readonly mainOnly: boolean;
}

/** bech32 data characters; an X25519 recipient is `age1` plus 58 of them. */
const AGE_RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const EXEC_WORD_RE = /^[A-Za-z0-9_./:=@+-]+$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const ACCESS_KEY_ID_RE = /^[A-Za-z0-9]{16,128}$/;
const SECRET_RE = /^[A-Za-z0-9/+=]{20,128}$/;

export function loadBackupConfig(env: Environment): BackupConfig {
  const recipient = env['BACKUP_AGE_RECIPIENT']?.trim() ?? '';
  if (recipient === '') {
    throw new ConfigError('missing required environment variable(s): BACKUP_AGE_RECIPIENT');
  }
  if (!AGE_RECIPIENT_RE.test(recipient)) {
    throw new ConfigError('BACKUP_AGE_RECIPIENT is not an age X25519 recipient (age1…)');
  }
  const keep = env['BACKUP_KEEP_LOCAL']?.trim() ?? '';
  if (keep !== '' && keep !== '0' && keep !== '1') {
    throw new ConfigError('BACKUP_KEEP_LOCAL must be 0 or 1');
  }
  return {
    store: readStore(env, 'BACKUP'),
    ageRecipient: recipient,
    pg: readPgTools(env),
    database: readIdent(env, 'PGDATABASE', 'fire_watch'),
    stagingDir: readAbsoluteDir(env, 'BACKUP_STAGING', DEFAULT_BACKUP_STAGING),
    keepLocalMain: keep === '0' ? 0 : 1,
    heartbeatUrl: readHeartbeatUrl(env['FIRE_WATCH_HEARTBEAT_URL']?.trim()),
  };
}

export function loadRestoreConfig(env: Environment): RestoreConfig {
  const identity = env['FIRE_WATCH_RESTORE_AGE_IDENTITY']?.trim() ?? '';
  if (identity === '') {
    throw new ConfigError(
      'missing required environment variable(s): FIRE_WATCH_RESTORE_AGE_IDENTITY',
    );
  }
  if (!isAbsolute(identity)) {
    throw new ConfigError('FIRE_WATCH_RESTORE_AGE_IDENTITY must be an absolute path');
  }
  return {
    store: readStore(env, 'RESTORE'),
    ageIdentityFile: identity,
    pg: readPgTools(env),
    maintenanceDatabase: readIdent(env, 'FIRE_WATCH_RESTORE_MAINTENANCE_DB', 'postgres'),
    workDir: readAbsoluteDir(env, 'FIRE_WATCH_RESTORE_WORKDIR', DEFAULT_RESTORE_WORKDIR),
  };
}

export function parseBackupArgs(argv: readonly string[]): BackupArgs {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else throw new ConfigError(`unknown argument ${JSON.stringify(arg)}; usage: [--dry-run]`);
  }
  return { dryRun };
}

const RESTORE_USAGE = 'usage: --database=<scratch name> [--key=<fw-main/… key>] [--main-only]';

export function parseRestoreArgs(argv: readonly string[]): RestoreArgs {
  let database: string | null = null;
  let mainKey: string | null = null;
  let mainOnly = false;
  for (const arg of argv) {
    if (arg === '--main-only') mainOnly = true;
    else if (arg.startsWith('--database=')) database = arg.slice('--database='.length);
    else if (arg.startsWith('--key=')) mainKey = arg.slice('--key='.length);
    else throw new ConfigError(`unknown argument ${JSON.stringify(arg)}; ${RESTORE_USAGE}`);
  }
  if (database === null || database === '') {
    throw new ConfigError(`--database is required; ${RESTORE_USAGE}`);
  }
  if (mainKey === '') throw new ConfigError(`--key must not be empty; ${RESTORE_USAGE}`);
  return { database, mainKey, mainOnly };
}

/** Safe to print: no credential, no ping URL, no identity path. */
export function describeBackupConfig(config: BackupConfig): Record<string, unknown> {
  return {
    ...describeStore(config.store),
    pg_exec: config.pg.execPrefix.length === 0 ? 'host' : config.pg.execPrefix.join(' '),
    pg_user: config.pg.user,
    pg_database: config.database,
    staging: config.stagingDir,
    keep_local_main: config.keepLocalMain,
    age_recipient: 'set',
    heartbeat: config.heartbeatUrl === null ? 'unset' : 'set',
  };
}

export function describeRestoreConfig(config: RestoreConfig): Record<string, unknown> {
  return {
    ...describeStore(config.store),
    pg_exec: config.pg.execPrefix.length === 0 ? 'host' : config.pg.execPrefix.join(' '),
    pg_user: config.pg.user,
    maintenance_database: config.maintenanceDatabase,
    work_dir: config.workDir,
    age_identity: 'set',
  };
}

function describeStore(store: BackupStoreConfig): Record<string, unknown> {
  return store.kind === 'local'
    ? { store: 'local', store_dir: store.directory }
    : {
        store: 'r2',
        r2_endpoint_host: new URL(store.endpoint).host,
        r2_bucket: store.bucket,
        r2_credentials: 'set',
      };
}

function readStore(env: Environment, side: 'BACKUP' | 'RESTORE'): BackupStoreConfig {
  const names = [
    `FIRE_WATCH_${side}_R2_ENDPOINT`,
    `FIRE_WATCH_${side}_R2_BUCKET`,
    `FIRE_WATCH_${side}_R2_ACCESS_KEY_ID`,
    `FIRE_WATCH_${side}_R2_SECRET_ACCESS_KEY`,
  ] as const;
  const [endpointName, bucketName, keyIdName, secretName] = names;
  const localName = `FIRE_WATCH_${side}_LOCAL_DIR`;
  const group = readGroup(env, names);
  const local = env[localName]?.trim() ?? '';

  if (group === null) {
    if (local === '') {
      throw new ConfigError(`no backup store: set the ${endpointName} group or ${localName}`);
    }
    if (!isAbsolute(local)) throw new ConfigError(`${localName} must be an absolute path`);
    return { kind: 'local', directory: local };
  }
  if (local !== '') {
    throw new ConfigError(`${localName} and ${endpointName} are exclusive; set one store`);
  }

  const endpoint = readEndpoint(endpointName, group[endpointName]);
  const bucket = group[bucketName];
  const accessKeyId = group[keyIdName];
  const secretAccessKey = group[secretName];
  if (!BUCKET_RE.test(bucket)) throw new ConfigError(`${bucketName} is not a valid bucket name`);
  if (!ACCESS_KEY_ID_RE.test(accessKeyId)) {
    throw new ConfigError(`${keyIdName} does not look like an access key id`);
  }
  if (!SECRET_RE.test(secretAccessKey)) {
    throw new ConfigError(`${secretName} does not look like a secret access key`);
  }
  if (secretAccessKey === accessKeyId) {
    throw new ConfigError(`${secretName} repeats ${keyIdName}`);
  }
  return { kind: 'r2', endpoint, bucket, accessKeyId, secretAccessKey };
}

function readPgTools(env: Environment): PgToolsConfig {
  const raw = env['FIRE_WATCH_BACKUP_PG_EXEC']?.trim() ?? '';
  let execPrefix: readonly string[];
  if (raw === '') execPrefix = DEFAULT_PG_EXEC;
  else if (raw === 'none') execPrefix = [];
  else {
    execPrefix = raw.split(/\s+/);
    if (!execPrefix.every((word) => EXEC_WORD_RE.test(word))) {
      throw new ConfigError(
        "FIRE_WATCH_BACKUP_PG_EXEC must be plain words (letters, digits, '._/:=@+-') or 'none'",
      );
    }
  }
  return { execPrefix, user: readIdent(env, 'PGUSER', 'postgres') };
}

function readIdent(env: Environment, name: string, fallback: string): string {
  const value = env[name]?.trim() ?? '';
  if (value === '') return fallback;
  if (!IDENT_RE.test(value)) throw new ConfigError(`${name} must be a plain lower-case identifier`);
  return value;
}

function readAbsoluteDir(env: Environment, name: string, fallback: string): string {
  const value = env[name]?.trim() ?? '';
  if (value === '') return fallback;
  if (!isAbsolute(value)) throw new ConfigError(`${name} must be an absolute path`);
  return value;
}

function readHeartbeatUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  try {
    return assertPingBaseUrl(raw);
  } catch (error: unknown) {
    // The gate's messages describe the shape of the problem, never the value.
    throw new ConfigError(
      `FIRE_WATCH_HEARTBEAT_URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readEndpoint(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (url.protocol !== 'https:') throw new ConfigError(`${name} must be https`);
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`${name} must not carry credentials`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${name} must be an origin, with no path or query`);
  }
  return url.origin;
}

// Local copy of app/config.ts's unexported helper (as in r2-mirror-config.ts): a group is
// all present or all absent, and a partial group names only the variables missing.
function readGroup<const Names extends readonly string[]>(
  env: Environment,
  names: Names,
): Readonly<Record<Names[number], string>> | null {
  const present: Partial<Record<Names[number], string>> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value === undefined || value === '') missing.push(name);
    else present[name as Names[number]] = value;
  }
  if (missing.length === names.length) return null;
  if (missing.length > 0) {
    throw new ConfigError(
      `${names.join(', ')} are configured together or not at all; missing: ${missing.join(', ')}`,
    );
  }
  return present as Readonly<Record<Names[number], string>>;
}
