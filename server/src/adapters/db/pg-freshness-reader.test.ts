import type { FreshnessRowId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import {
  createPgDatabaseProbe,
  createPgFreshnessReader,
  SELECT_SOURCE_STATUS_SQL,
  sourceRows,
  type PgReadable,
  type SourceStatusRow,
} from './pg-freshness-reader.js';

interface Query {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface FakeDb extends PgReadable {
  readonly queries: Query[];
}

function fakeDb(rows: readonly SourceStatusRow[] = []): FakeDb {
  const queries: Query[] = [];
  return {
    queries,
    query(text, values) {
      queries.push({ text, values });
      return Promise.resolve({ rows });
    },
  };
}

function row(overrides: Partial<SourceStatusRow> = {}): SourceStatusRow {
  return {
    source: 'firms:viirs:snpp',
    last_attempt_at: new Date('2026-08-02T11:30:00Z'),
    last_success_at: new Date('2026-08-02T11:29:30Z'),
    last_data_at: new Date('2026-08-02T11:20:00Z'),
    consecutive_failures: 0,
    ...overrides,
  };
}

const LIVE_SOURCES: readonly FreshnessRowId[] = [
  'firms:viirs:snpp',
  'firms:viirs:noaa20',
  'firms:viirs:noaa21',
];

describe('createPgFreshnessReader', () => {
  it('asks for every source in one statement', async () => {
    // 500 ms to answer (OPERATIONS §2.2 rule 5): a round trip per source would spend the
    // budget on latency, and `= ANY($1)` keeps the prepared-statement shape constant as
    // the registry grows.
    const db = fakeDb();
    await createPgFreshnessReader(db).readObservations(LIVE_SOURCES);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text).toBe(SELECT_SOURCE_STATUS_SQL);
    expect(db.queries[0]?.values).toEqual([LIVE_SOURCES]);
  });

  it('does not ask about rows this table cannot hold', async () => {
    // `source_status.source` is a foreign key to `sources`, so the jobs and the feeds that
    // are not detection sources have no row here yet (TASKS C3, C6, B9). Querying for them
    // would be a statement guaranteed to return nothing.
    const db = fakeDb();
    await createPgFreshnessReader(db).readObservations([
      'firms:viirs:snpp',
      'eumetsat:clm',
      'effis:layers',
      'weather:context',
      'snapshot-push',
      'nightly-backup',
    ]);

    expect(db.queries[0]?.values).toEqual([['firms:viirs:snpp']]);
  });

  it('makes no round trip at all when nothing it can answer for was asked', async () => {
    // A staging box that polls nothing must not fail here, and it must not spend a
    // connection to learn that it has nothing to say.
    const db = fakeDb();

    await expect(
      createPgFreshnessReader(db).readObservations(['snapshot-push', 'wal-archive']),
    ).resolves.toEqual([]);
    expect(db.queries).toEqual([]);
  });

  it('hands the evaluator epoch milliseconds, not driver Dates', async () => {
    const db = fakeDb([row({ consecutive_failures: 2 })]);

    const observations = await createPgFreshnessReader(db).readObservations(LIVE_SOURCES);

    expect(observations).toEqual([
      {
        row: 'firms:viirs:snpp',
        lastAttemptAt: Date.parse('2026-08-02T11:30:00Z'),
        lastSuccessAt: Date.parse('2026-08-02T11:29:30Z'),
        lastDataAt: Date.parse('2026-08-02T11:20:00Z'),
        consecutiveFailures: 2,
      },
    ]);
  });

  it('keeps a null null, because never-succeeded is not the same as long ago', async () => {
    // The evaluator turns the first into `critical` and the second into an age it can
    // compare; collapsing them here would erase the distinction before it is ever made.
    const db = fakeDb([row({ last_success_at: null, last_data_at: null })]);

    const [observation] = await createPgFreshnessReader(db).readObservations(LIVE_SOURCES);

    expect(observation?.lastSuccessAt).toBeNull();
    expect(observation?.lastDataAt).toBeNull();
    expect(observation?.lastAttemptAt).not.toBeNull();
  });

  it('reports fewer rows than asked for rather than inventing the missing ones', async () => {
    // A source that has never been polled has no `source_status` row. Absence is the
    // signal — the evaluator renders it `unknown`, which is exactly what it is.
    const db = fakeDb([row()]);

    const observations = await createPgFreshnessReader(db).readObservations(LIVE_SOURCES);

    expect(observations).toHaveLength(1);
  });

  it('lets a database failure reach the caller', async () => {
    // Swallowing it into an empty result would render as a fleet of unknown feeds rather
    // than as a database nobody can reach — a 200 for the outage that most deserves a 500.
    const db: PgReadable = {
      query: () => Promise.reject(new Error('canceling statement due to statement timeout')),
    };

    await expect(createPgFreshnessReader(db).readObservations(LIVE_SOURCES)).rejects.toThrow(
      /statement timeout/,
    );
  });
});

describe('sourceRows', () => {
  it('keeps the detection sources and drops everything else', () => {
    expect(sourceRows(['firms:viirs:noaa20', 'wal-archive', 'eumetsat:slstr:frp'])).toEqual([
      'firms:viirs:noaa20',
      'eumetsat:slstr:frp',
    ]);
  });
});

describe('createPgDatabaseProbe', () => {
  it('asks the cheapest question there is', async () => {
    // Not a query against a real table: readiness is about the connection, and a probe
    // that also depends on a migration having run would fail a box that is merely new.
    const db = fakeDb();

    await createPgDatabaseProbe(db).ping();

    expect(db.queries.map((query) => query.text)).toEqual(['SELECT 1']);
  });

  it('rejects when the database does not answer', async () => {
    const db: PgReadable = { query: () => Promise.reject(new Error('ECONNREFUSED')) };

    await expect(createPgDatabaseProbe(db).ping()).rejects.toThrow(/ECONNREFUSED/);
  });
});
