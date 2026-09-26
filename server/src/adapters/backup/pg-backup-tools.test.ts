import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  createFsRestoreWorkspace,
  createPgDumpAgeProducer,
  createPgRestoreTarget,
  createPsqlBackupDatabase,
  DEFAULT_PG_EXEC_PREFIX,
  pgCommand,
  type PgConnection,
} from './pg-backup-tools.js';
import type {
  CommandSpec,
  InteractiveSession,
  PipelineIo,
  ProcessRunner,
} from './process-runner.js';

const dir = mkdtempSync(join(tmpdir(), 'fw-pg-tools-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PROD: PgConnection = {
  execPrefix: DEFAULT_PG_EXEC_PREFIX,
  user: 'postgres',
  database: 'fire_watch',
};

interface FakeRunner extends ProcessRunner {
  readonly runs: { spec: CommandSpec; input: string | undefined }[];
  readonly pipelines: { stages: readonly CommandSpec[]; io: PipelineIo }[];
  readonly sessionLines: string[];
}

function fakeRunner(answers: {
  readonly run?: (sql: string) => string;
  readonly snapshotLine?: string;
}): FakeRunner {
  const runs: FakeRunner['runs'] = [];
  const pipelines: FakeRunner['pipelines'] = [];
  const sessionLines: string[] = [];
  return {
    runs,
    pipelines,
    sessionLines,
    run(spec, input) {
      runs.push({ spec, input });
      return Promise.resolve({ stdout: answers.run?.(input ?? '') ?? '' });
    },
    pipeline(stages, io) {
      pipelines.push({ stages, io });
      if (io.outputFile !== undefined) writeFileSync(io.outputFile, 'enc', { mode: 0o600 });
      return Promise.resolve({ bytes: 3, sha256: 'c'.repeat(64) });
    },
    interactive(): InteractiveSession {
      return {
        writeLine: (line) => sessionLines.push(line),
        readLine: () => Promise.resolve(answers.snapshotLine ?? '00000003-0000001B-1'),
        end: () => {
          sessionLines.push('<end>');
          return Promise.resolve();
        },
        kill: () => sessionLines.push('<kill>'),
      };
    },
  };
}

describe('pgCommand', () => {
  it('runs the tool through the prefix, or directly without one', () => {
    expect(pgCommand(PROD, 'pg_dump', ['-x'])).toEqual({
      command: 'docker',
      args: ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-x'],
      label: 'pg_dump',
    });
    expect(pgCommand({ ...PROD, execPrefix: [] }, 'psql', [])).toEqual({
      command: 'psql',
      args: [],
      label: 'psql',
    });
  });
});

describe('psql backup database', () => {
  it('parses the registry listing, null for unregistered, and refuses unknown classes', async () => {
    const runner = fakeRunner({
      run: () => 'accounts\tpersonal\ndetections\tmain\nschema_migrations\t\n',
    });
    const db = createPsqlBackupDatabase(runner, PROD);
    expect(await db.classifiedRelations()).toEqual([
      { relation: 'accounts', backupClass: 'personal' },
      { relation: 'detections', backupClass: 'main' },
      { relation: 'schema_migrations', backupClass: null },
    ]);
    const [call] = runner.runs;
    expect(call?.spec.args).toEqual(
      expect.arrayContaining([
        'psql',
        '-X',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        'fire_watch',
      ]),
    );
    expect(call?.input).toContain('table_backup_class');

    const bad = createPsqlBackupDatabase(fakeRunner({ run: () => 'x\tsecret\n' }), PROD);
    await expect(bad.classifiedRelations()).rejects.toThrow(/unknown backup class/);
    const odd = createPsqlBackupDatabase(fakeRunner({ run: () => 'Weird Name\tmain\n' }), PROD);
    await expect(odd.classifiedRelations()).rejects.toThrow(/plain identifier/);
  });

  it('reads applied migrations', async () => {
    const db = createPsqlBackupDatabase(fakeRunner({ run: () => '001\n002\n' }), PROD);
    expect(await db.appliedMigrations()).toEqual(['001', '002']);
  });

  it('reads table stats inside the exported snapshot', async () => {
    const runner = fakeRunner({ run: () => 'accounts\t2\t16384\ndetections\t1500\t2105344\n' });
    const db = createPsqlBackupDatabase(runner, PROD);
    expect(await db.tableStats('00000003-0000001B-1')).toEqual([
      { relation: 'accounts', rows: 2, bytes: 16_384 },
      { relation: 'detections', rows: 1500, bytes: 2_105_344 },
    ]);
    const sql = runner.runs[0]?.input ?? '';
    const statements = sql.split('\n');
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    // The snapshot must be imported before anything else runs in the transaction.
    expect(statements[1]).toBe("SET TRANSACTION SNAPSHOT '00000003-0000001B-1';");
    expect(sql).toContain('pg_total_relation_size');
    expect(sql).toContain("c.relkind = 'r'");
    expect(statements.at(-1)).toBe('COMMIT;');
  });

  it('refuses a malformed snapshot id before running anything', async () => {
    const runner = fakeRunner({});
    const db = createPsqlBackupDatabase(runner, PROD);
    await expect(db.tableStats("x'; DROP TABLE detections; --")).rejects.toThrow(
      /pg_export_snapshot/,
    );
    expect(runner.runs).toEqual([]);
  });

  it('refuses a table stat without a count or size', async () => {
    const noCount = createPsqlBackupDatabase(fakeRunner({ run: () => 'accounts\t\t8192\n' }), PROD);
    await expect(noCount.tableStats('00000003-0000001B-1')).rejects.toThrow(
      /no row count for accounts/,
    );
    const noSize = createPsqlBackupDatabase(fakeRunner({ run: () => 'accounts\t3\n' }), PROD);
    await expect(noSize.tableStats('00000003-0000001B-1')).rejects.toThrow(/no size for accounts/);
    const huge = createPsqlBackupDatabase(
      fakeRunner({ run: () => 'accounts\t99999999999999999999\t1\n' }),
      PROD,
    );
    await expect(huge.tableStats('00000003-0000001B-1')).rejects.toThrow(/out of range/);
  });

  it('holds the snapshot in one session and commits once on release', async () => {
    const runner = fakeRunner({});
    const lease = await createPsqlBackupDatabase(runner, PROD).exportSnapshot();
    expect(lease.snapshotId).toBe('00000003-0000001B-1');
    await lease.release();
    await lease.release();
    expect(runner.sessionLines).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
      'SELECT pg_export_snapshot();',
      'COMMIT;',
      '<end>',
    ]);
  });

  it('kills the session when psql does not answer with a snapshot id', async () => {
    const runner = fakeRunner({ snapshotLine: 'ERROR: nope' });
    await expect(createPsqlBackupDatabase(runner, PROD).exportSnapshot()).rejects.toThrow(
      /not a snapshot id/,
    );
    expect(runner.sessionLines.slice(-2)).toEqual(['<kill>', '<end>']);
  });
});

describe('pg_dump | age producer', () => {
  it('pipes pg_dump through the prefix into host-side age, into a 0700 staging dir', async () => {
    const staging = join(dir, 'staging');
    const runner = fakeRunner({});
    const producer = createPgDumpAgeProducer(runner, {
      connection: PROD,
      ageRecipient: 'age1example',
      stagingDir: staging,
    });
    const fileName = 'fire-watch-main-20260924T022000Z.dump.age';
    const artifact = await producer.dumpEncrypted({ fileName, pgDumpArgs: ['--format=custom'] });
    expect(artifact).toEqual({ path: join(staging, fileName), bytes: 3, sha256: 'c'.repeat(64) });
    expect(statSync(staging).mode & 0o777).toBe(0o700);
    const [call] = runner.pipelines;
    expect(call?.stages.map((s) => s.label)).toEqual(['pg_dump', 'age']);
    expect(call?.stages[0]?.args.slice(-5)).toEqual([
      '-U',
      'postgres',
      '-d',
      'fire_watch',
      '--format=custom',
    ]);
    expect(call?.stages[1]).toEqual({ command: 'age', args: ['-r', 'age1example'], label: 'age' });
    expect(call?.io).toEqual({ outputFile: join(staging, fileName) });

    await expect(
      producer.dumpEncrypted({ fileName: '../escape.dump.age', pgDumpArgs: [] }),
    ).rejects.toThrow(RangeError);
  });

  it('prunes staged artifacts except the kept ones, and nothing else', async () => {
    const staging = join(dir, 'prune');
    mkdirSync(staging);
    const keep = join(staging, 'fire-watch-main-20260924T022000Z.dump.age');
    const old = join(staging, 'fire-watch-20260901T022000Z.dump.age');
    const other = join(staging, 'notes.txt');
    for (const p of [keep, old, other]) writeFileSync(p, 'x');
    const producer = createPgDumpAgeProducer(fakeRunner({}), {
      connection: PROD,
      ageRecipient: 'age1example',
      stagingDir: staging,
    });
    await producer.pruneStaging([keep]);
    expect([existsSync(keep), existsSync(old), existsSync(other)]).toEqual([true, false, true]);
    await createPgDumpAgeProducer(fakeRunner({}), {
      connection: PROD,
      ageRecipient: 'a',
      stagingDir: join(dir, 'missing'),
    }).pruneStaging([]);
  });
});

describe('pg_restore target', () => {
  const options = {
    connection: { ...PROD, database: 'postgres' },
    ageIdentityFile: '/root/age.key',
  };

  it('creates a scratch database only when it does not exist', async () => {
    const runner = fakeRunner({ run: () => '' });
    await createPgRestoreTarget(runner, options).createDatabase('fw_restore_drill');
    expect(runner.runs.map((r) => r.input)).toEqual([
      "SELECT 1 FROM pg_database WHERE datname = 'fw_restore_drill';",
      'CREATE DATABASE "fw_restore_drill";',
    ]);

    const exists = fakeRunner({ run: () => '1\n' });
    await expect(
      createPgRestoreTarget(exists, options).createDatabase('fw_restore_drill'),
    ).rejects.toThrow(/already exists/);
    expect(exists.runs).toHaveLength(1);
  });

  it('refuses production and odd names before running anything', async () => {
    const runner = fakeRunner({});
    const target = createPgRestoreTarget(runner, options);
    await expect(target.createDatabase('fire_watch')).rejects.toThrow(/refusing restore target/);
    await expect(target.createDatabase("x'; DROP")).rejects.toThrow(/refusing/);
    await expect(
      target.restore({ database: 'fire_watch', artifactPath: '/a', pgRestoreArgs: [] }),
    ).rejects.toThrow(/refusing/);
    expect(runner.runs).toEqual([]);
    expect(runner.pipelines).toEqual([]);
  });

  it('decrypts on the host and restores through the prefix', async () => {
    const runner = fakeRunner({});
    await createPgRestoreTarget(runner, options).restore({
      database: 'fw_restore_drill',
      artifactPath: '/work/a.dump.age',
      pgRestoreArgs: ['--exit-on-error'],
    });
    const [call] = runner.pipelines;
    expect(call?.io).toEqual({ inputFile: '/work/a.dump.age' });
    expect(call?.stages[0]).toEqual({
      command: 'age',
      args: ['-d', '-i', '/root/age.key'],
      label: 'age',
    });
    expect(call?.stages[1]?.args.slice(-6)).toEqual([
      '--no-password',
      '-U',
      'postgres',
      '-d',
      'fw_restore_drill',
      '--exit-on-error',
    ]);
  });

  it('reads row counts and migrations from the scratch database', async () => {
    const runner = fakeRunner({
      run: (sql) =>
        sql.includes('count(*)') ? 'accounts\tpersonal\t0\ndetections\tmain\t12\n' : '001\n',
    });
    const target = createPgRestoreTarget(runner, options);
    expect(await target.rowCounts('fw_restore_drill')).toEqual([
      { relation: 'accounts', backupClass: 'personal', rows: 0 },
      { relation: 'detections', backupClass: 'main', rows: 12 },
    ]);
    expect(await target.appliedMigrations('fw_restore_drill')).toEqual(['001']);
    expect(runner.runs.every((r) => r.spec.args.includes('fw_restore_drill'))).toBe(true);

    const broken = createPgRestoreTarget(
      fakeRunner({ run: () => 'accounts\tpersonal\t\n' }),
      options,
    );
    await expect(broken.rowCounts('fw_restore_drill')).rejects.toThrow(/no row count/);
  });
});

describe('fs restore workspace', () => {
  it('places plain file names in a 0700 directory and discards idempotently', async () => {
    const work = join(dir, 'work');
    const workspace = createFsRestoreWorkspace(work);
    await workspace.prepare();
    expect(statSync(work).mode & 0o777).toBe(0o700);
    const path = workspace.pathFor('fire-watch-main-20260924T022000Z.dump.age');
    writeFileSync(path, 'x');
    await workspace.discard(path);
    await workspace.discard(path);
    expect(existsSync(path)).toBe(false);
    expect(() => workspace.pathFor('../x')).toThrow(RangeError);
    expect(() => workspace.pathFor('.hidden')).toThrow(RangeError);
  });
});
