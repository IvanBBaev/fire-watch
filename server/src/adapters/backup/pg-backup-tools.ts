/**
 * The Postgres side of the backup and the restore, over `psql`, `pg_dump`, `pg_restore`
 * and `age` child processes (TASKS C6; OPERATIONS §6.2, §6.3).
 *
 * No driver: the production Postgres publishes no port (§9.2), so every client runs
 * **inside** the database container through a command prefix — by default
 * `docker compose exec -T postgres` — which also guarantees the client tools match the
 * server version (a host-side pg_dump one major behind refuses to dump). With an empty
 * prefix the tools run on the host and read the usual `PG*` environment.
 *
 * `age` always runs on the host: the recipient (backup) and the identity file (restore)
 * never enter the database container.
 *
 * The snapshot both dumps share is held by one interactive `psql` session: it opens a
 * REPEATABLE READ transaction, prints `pg_export_snapshot()`, and stays open until the
 * lease is released — an exported snapshot lives exactly as long as its transaction.
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  isValidSnapshotId,
  type BackupClass,
  type ClassifiedRelation,
} from '../../core/backup/dump-plan.js';
import type {
  ArtifactProducer,
  BackupDatabase,
  RestoreTarget,
  RestoreWorkspace,
  SnapshotLease,
} from '../../core/backup/ports.js';
import { scratchDatabaseProblem, type RelationRowCount } from '../../core/backup/restore-verify.js';
import type { TableStat } from '../../core/backup/table-gauges.js';
import type { CommandSpec, ProcessRunner } from './process-runner.js';

/** The compose service and default prefix of the production host. */
export const DEFAULT_PG_EXEC_PREFIX = ['docker', 'compose', 'exec', '-T', 'postgres'] as const;

export interface PgConnection {
  /** argv words run before the tool, e.g. `docker compose exec -T postgres`; may be empty. */
  readonly execPrefix: readonly string[];
  readonly user: string;
  readonly database: string;
}

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const ARTIFACT_NAME_RE = /^fire-watch-(main|personal)-\d{8}T\d{6}Z\.dump\.age$/;

/** One Postgres client tool, through the prefix. */
export function pgCommand(
  connection: PgConnection,
  tool: 'psql' | 'pg_dump' | 'pg_restore',
  args: readonly string[],
): CommandSpec {
  const [head, ...rest] = connection.execPrefix;
  return head === undefined
    ? { command: tool, args: [...args], label: tool }
    : { command: head, args: [...rest, tool, ...args], label: tool };
}

function psqlArgs(connection: PgConnection, database: string): string[] {
  return [
    '-X',
    '-q',
    '-A',
    '-t',
    '-F',
    '\t',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    connection.user,
    '-d',
    database,
  ];
}

async function query(
  runner: ProcessRunner,
  connection: PgConnection,
  database: string,
  sql: string,
): Promise<string[][]> {
  const { stdout } = await runner.run(
    pgCommand(connection, 'psql', psqlArgs(connection, database)),
    sql,
  );
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
}

/** Tables in `public`, partitions resolved to their root's class, extension tables left out. */
const RELATIONS_FROM = `
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
JOIN pg_class r ON r.oid = coalesce(pg_partition_root(c.oid)::oid, c.oid)
LEFT JOIN public.table_backup_class b ON b.table_name = r.relname
WHERE NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')`;

export const CLASSIFIED_RELATIONS_SQL = `SELECT c.relname, coalesce(b.class, '')${RELATIONS_FROM}
  AND c.relkind IN ('r', 'p')
ORDER BY c.relname;`;

/** Leaves only: a partitioned parent has no rows of its own. Counted in the server. */
export const ROW_COUNTS_SQL = `SELECT c.relname, coalesce(b.class, ''),
  (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text${RELATIONS_FROM}
  AND c.relkind = 'r'
ORDER BY c.relname;`;

/** Leaves only, as for the row counts, plus the on-disk size (heap, indexes, TOAST). */
const TABLE_STATS_SELECT = `SELECT c.relname,
  (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text,
  pg_total_relation_size(c.oid)::text${RELATIONS_FROM}
  AND c.relkind = 'r'
ORDER BY c.relname;`;

/**
 * The table gauges, read **inside** the backup's exported snapshot: the counts are exactly
 * the rows the two dumps carry. `SET TRANSACTION SNAPSHOT` must be the transaction's first
 * statement; the id is checked against the `pg_export_snapshot()` shape before it is
 * interpolated.
 */
export function tableStatsSql(snapshotId: string): string {
  if (!isValidSnapshotId(snapshotId)) {
    throw new RangeError('snapshot id is not a pg_export_snapshot() value');
  }
  return [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
    `SET TRANSACTION SNAPSHOT '${snapshotId}';`,
    TABLE_STATS_SELECT,
    'COMMIT;',
  ].join('\n');
}

function countOf(text: string | undefined, what: string, relation: string): number {
  if (text === undefined || !/^\d+$/.test(text)) throw new RangeError(`no ${what} for ${relation}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} of ${relation} is out of range`);
  return value;
}

export const APPLIED_MIGRATIONS_SQL =
  'SELECT version FROM public.schema_migrations ORDER BY version;';

function backupClassOf(text: string | undefined, relation: string): BackupClass | null {
  if (text === undefined || text === '') return null;
  if (text === 'main' || text === 'personal') return text;
  throw new RangeError(`relation ${relation} has an unknown backup class`);
}

function relationName(row: readonly string[]): string {
  const name = row[0] ?? '';
  if (!IDENT_RE.test(name))
    throw new RangeError('the catalog returned a relation that is not a plain identifier');
  return name;
}

export function createPsqlBackupDatabase(
  runner: ProcessRunner,
  connection: PgConnection,
): BackupDatabase {
  return {
    async classifiedRelations(): Promise<readonly ClassifiedRelation[]> {
      const rows = await query(runner, connection, connection.database, CLASSIFIED_RELATIONS_SQL);
      return rows.map((row) => {
        const relation = relationName(row);
        return { relation, backupClass: backupClassOf(row[1], relation) };
      });
    },

    async appliedMigrations(): Promise<readonly string[]> {
      const rows = await query(runner, connection, connection.database, APPLIED_MIGRATIONS_SQL);
      return rows.map((row) => row[0] ?? '');
    },

    async tableStats(snapshotId): Promise<readonly TableStat[]> {
      const rows = await query(runner, connection, connection.database, tableStatsSql(snapshotId));
      return rows.map((row) => {
        const relation = relationName(row);
        return {
          relation,
          rows: countOf(row[1], 'row count', relation),
          bytes: countOf(row[2], 'size', relation),
        };
      });
    },

    async exportSnapshot(): Promise<SnapshotLease> {
      const session = runner.interactive(
        pgCommand(connection, 'psql', psqlArgs(connection, connection.database)),
      );
      let snapshotId: string;
      try {
        session.writeLine('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
        session.writeLine('SELECT pg_export_snapshot();');
        snapshotId = (await session.readLine()).trim();
        if (!isValidSnapshotId(snapshotId)) {
          throw new Error('psql answered with something that is not a snapshot id');
        }
      } catch (error) {
        session.kill();
        await session.end().catch(() => undefined);
        throw error;
      }
      let released: Promise<void> | null = null;
      return {
        snapshotId,
        release() {
          released ??= (async () => {
            session.writeLine('COMMIT;');
            await session.end();
          })();
          return released;
        },
      };
    },
  };
}

export interface PgDumpAgeProducerOptions {
  readonly connection: PgConnection;
  /** The age public key (`age1…`): a recipient, not a secret. */
  readonly ageRecipient: string;
  readonly stagingDir: string;
  readonly ageCommand?: string;
}

/** `pg_dump | age -r <recipient>` into a 0600 staging file, hashed in the same pass. */
export function createPgDumpAgeProducer(
  runner: ProcessRunner,
  options: PgDumpAgeProducerOptions,
): ArtifactProducer {
  const age = options.ageCommand ?? 'age';
  const { connection } = options;
  return {
    async dumpEncrypted({ fileName, pgDumpArgs }) {
      if (!ARTIFACT_NAME_RE.test(fileName)) {
        throw new RangeError(`${JSON.stringify(fileName)} is not an artifact file name`);
      }
      await mkdir(options.stagingDir, { recursive: true, mode: 0o700 });
      const path = join(options.stagingDir, fileName);
      const { bytes, sha256 } = await runner.pipeline(
        [
          pgCommand(connection, 'pg_dump', [
            '-U',
            connection.user,
            '-d',
            connection.database,
            ...pgDumpArgs,
          ]),
          { command: age, args: ['-r', options.ageRecipient], label: 'age' },
        ],
        { outputFile: path },
      );
      return { path, bytes, sha256 };
    },

    async pruneStaging(keep) {
      const kept = new Set(keep);
      let names: string[];
      try {
        names = await readdir(options.stagingDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const name of names) {
        // Only our artifacts — and the shell job's `fire-watch-<ts>.dump.age` — are pruned.
        if (!/^fire-watch-.*\.dump\.age$/.test(name)) continue;
        const path = join(options.stagingDir, name);
        if (!kept.has(path)) await rm(path, { force: true });
      }
    },
  };
}

export interface PgRestoreTargetOptions {
  /** The connection used for `CREATE DATABASE`; its database is the maintenance one. */
  readonly connection: PgConnection;
  /** The age identity file (the private key). Its path is logged nowhere. */
  readonly ageIdentityFile: string;
  readonly ageCommand?: string;
}

/** A scratch database on the same (or a rebuilt) cluster; never production. */
export function createPgRestoreTarget(
  runner: ProcessRunner,
  options: PgRestoreTargetOptions,
): RestoreTarget {
  const age = options.ageCommand ?? 'age';
  const { connection } = options;
  const checked = (name: string): string => {
    const problem = scratchDatabaseProblem(name);
    if (problem !== null) throw new RangeError(`refusing restore target ${name}: ${problem}`);
    return name;
  };

  return {
    async createDatabase(name) {
      const database = checked(name);
      const existing = await query(
        runner,
        connection,
        connection.database,
        `SELECT 1 FROM pg_database WHERE datname = '${database}';`,
      );
      if (existing.length > 0) {
        throw new Error(`database ${database} already exists; a restore never lands on data`);
      }
      await query(runner, connection, connection.database, `CREATE DATABASE "${database}";`);
    },

    async restore({ database, artifactPath, pgRestoreArgs }) {
      const target = checked(database);
      await runner.pipeline(
        [
          { command: age, args: ['-d', '-i', options.ageIdentityFile], label: 'age' },
          pgCommand(connection, 'pg_restore', [
            '--no-password',
            '-U',
            connection.user,
            '-d',
            target,
            ...pgRestoreArgs,
          ]),
        ],
        { inputFile: artifactPath },
      );
    },

    async appliedMigrations(database) {
      const rows = await query(runner, connection, checked(database), APPLIED_MIGRATIONS_SQL);
      return rows.map((row) => row[0] ?? '');
    },

    async rowCounts(database): Promise<readonly RelationRowCount[]> {
      const rows = await query(runner, connection, checked(database), ROW_COUNTS_SQL);
      return rows.map((row) => {
        const relation = relationName(row);
        const rowsText = row[2] ?? '';
        if (!/^\d+$/.test(rowsText)) throw new RangeError(`no row count for ${relation}`);
        return { relation, backupClass: backupClassOf(row[1], relation), rows: Number(rowsText) };
      });
    },
  };
}

/** Downloads land in one 0700 directory and are deleted by name when the restore ends. */
export function createFsRestoreWorkspace(directory: string): RestoreWorkspace & {
  prepare(): Promise<void>;
} {
  return {
    async prepare() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    },
    pathFor(fileName) {
      if (basename(fileName) !== fileName || fileName.startsWith('.')) {
        throw new RangeError(`${JSON.stringify(fileName)} is not a plain file name`);
      }
      return join(directory, fileName);
    },
    async discard(path) {
      await rm(path, { force: true });
    },
  };
}
