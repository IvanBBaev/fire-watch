/**
 * `source_status`, read for the health endpoint.
 *
 * One statement, one index lookup per row, no joins: the endpoint has 500 ms to answer and
 * has to keep answering while the database is the thing that is unwell (OPERATIONS §2.2
 * rule 5). Nothing is cached — a cached freshness answer is a freshness answer that can
 * outlive the outage it is supposed to report.
 *
 * ## Why some monitored rows are silently not queried
 *
 * `source_status.source` is a foreign key to `sources`, so the table can only ever hold the
 * frozen detection sources. The other monitored rows — the unregistered feeds (`eumetsat:clm`,
 * `effis:layers`, `weather:context`) and the scheduled jobs — have no store yet because the
 * jobs that would write them do not exist yet (TASKS C3, C6, B9). They are filtered out here
 * rather than queried and missed, and the evaluator reports them as `unknown`, which is
 * exactly what they are. Their primary detector today is the healthchecks.io leg, which is
 * off-box and does not need us to be running at all (§3).
 */

import { isMonitoredFeedId, isMonitoredSourceId, type FreshnessRowId } from '@fire-watch/contracts';
import type { Selectable } from 'kysely';

import type { FreshnessObservation } from '../../core/health/freshness.js';
import type { DatabaseProbe, FreshnessReader } from '../../core/ports/freshness-reader.js';
import type { SourceStatus } from '../../db/types.generated.js';

/**
 * The slice of `pg` this module uses. Structural, like the archive's — but this one reads,
 * so it names the row shape it expects back rather than only a count.
 */
export interface PgReadable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly SourceStatusRow[] }>;
}

/**
 * One `source_status` row as the driver hands it over: `timestamptz` arrives as a `Date`.
 * Derived from the generated schema types (B4) — the picked keys are exactly the columns
 * `SELECT_SOURCE_STATUS` names, so a renamed column fails to compile here.
 */
export type SourceStatusRow = Readonly<
  Pick<
    Selectable<SourceStatus>,
    'source' | 'last_attempt_at' | 'last_success_at' | 'last_data_at' | 'consecutive_failures'
  >
>;

/**
 * `= ANY($1)` rather than an `IN` list built per call: one prepared statement shape, so the
 * plan is reused and the parameter count cannot grow with the source registry.
 */
const SELECT_SOURCE_STATUS = `
SELECT source, last_attempt_at, last_success_at, last_data_at, consecutive_failures
FROM source_status
WHERE source = ANY($1::text[])
`.trim();

export function createPgFreshnessReader(db: PgReadable): FreshnessReader {
  return {
    async readObservations(
      rows: readonly FreshnessRowId[],
    ): Promise<readonly FreshnessObservation[]> {
      const sources = sourceRows(rows);
      // No round trip for a question with no answers in this table. It is also what a
      // staging box that polls nothing does, and it must not fail there.
      if (sources.length === 0) return [];

      const result = await db.query(SELECT_SOURCE_STATUS, [sources]);
      return result.rows.map(toObservation);
    },
  };
}

/** The monitored rows this table can actually answer for; see the module comment. */
export function sourceRows(rows: readonly FreshnessRowId[]): readonly string[] {
  return rows.filter((row) => isMonitoredFeedId(row) && isMonitoredSourceId(row));
}

function toObservation(row: SourceStatusRow): FreshnessObservation {
  return {
    // Narrowed by the query: only ids that passed `sourceRows` can come back.
    row: row.source as FreshnessRowId,
    lastAttemptAt: epoch(row.last_attempt_at),
    lastSuccessAt: epoch(row.last_success_at),
    lastDataAt: epoch(row.last_data_at),
    consecutiveFailures: row.consecutive_failures,
  };
}

function epoch(at: Date | null): number | null {
  return at === null ? null : at.getTime();
}

/** Exported for the tests that assert the statement's shape rather than its effect. */
export const SELECT_SOURCE_STATUS_SQL = SELECT_SOURCE_STATUS;

/**
 * `/readyz`, which asks the cheapest question there is. `SELECT 1` and not a query against
 * a real table on purpose: readiness is about the connection, and a probe that also depends
 * on a migration having run would fail a box that is merely new.
 */
export function createPgDatabaseProbe(db: PgReadable): DatabaseProbe {
  return {
    async ping(): Promise<void> {
      await db.query('SELECT 1');
    },
  };
}
