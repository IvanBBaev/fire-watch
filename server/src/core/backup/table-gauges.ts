/**
 * Per-table row and byte gauges, recorded at dump time (TASKS C6; OPERATIONS §6.3 rule 2).
 *
 * A backup that uploads is not a backup that holds what it should: a table emptied by a bad
 * retention job, a botched promotion or an erasure that ran wide still dumps, still clears
 * the byte floor, and still pings `nightly-backup` green. These gauges make that visible —
 * every night, per table, the rows the snapshot holds and the bytes the table occupies — and
 * a comparison against the previous night names every table that shrank or disappeared.
 * They are also the "metric gauges recorded at dump time" the quarterly drill compares a
 * restore against.
 *
 * Rows are counted **inside the exported snapshot**, so they are exactly the rows the two
 * artifacts carry. Bytes are `pg_total_relation_size` (heap, indexes and TOAST): physical,
 * not snapshot-scoped, and meant for trends rather than equality.
 *
 * Shrinkage is reported, never paged or refused: several tables shrink by design (the
 * clustering working set, expired auth links, sessions), so a decrease is a line to read,
 * not an incident. What is an incident is decided off-box, on the exported series.
 *
 * Series names follow `core/observability/alert-metrics.ts`: declared here as data, so an
 * exporter adapter reads them rather than restating them. No exporter exists yet; until one
 * does, the gauges travel in the job's canonical-JSON progress lines.
 *
 * Pure: the counts, the plan and the previous snapshot arrive as arguments.
 */

import type { MetricDescriptor } from '../observability/alert-metrics.js';
import type { BackupSet } from './backup-keys.js';
import type { BackupRunPlan } from './dump-plan.js';

export const BACKUP_TABLE_ROWS: MetricDescriptor = {
  name: 'fw_backup_table_rows',
  kind: 'gauge',
  help: 'Rows in a table inside the snapshot the nightly backup dumped, by the artifact carrying them.',
  labels: ['relation', 'set'],
};

export const BACKUP_TABLE_BYTES: MetricDescriptor = {
  name: 'fw_backup_table_bytes',
  kind: 'gauge',
  help: 'On-disk size of a table (heap, indexes, TOAST) at nightly backup time, by the artifact carrying its rows.',
  labels: ['relation', 'set'],
};

export const BACKUP_TABLE_METRICS: readonly MetricDescriptor[] = [
  BACKUP_TABLE_ROWS,
  BACKUP_TABLE_BYTES,
];

/** One leaf table as the database reports it (a partitioned parent has no rows of its own). */
export interface TableStat {
  readonly relation: string;
  readonly rows: number;
  readonly bytes: number;
}

export interface TableGauge extends TableStat {
  /** The artifact whose rows include this table's. */
  readonly set: BackupSet;
}

export interface TableGauges {
  readonly gauges: readonly TableGauge[];
  /**
   * Tables the snapshot holds that the plan does not name — created between reading the
   * registry and exporting the snapshot. Reported, not gauged: no set carries them by plan.
   */
  readonly unplanned: readonly string[];
}

/** What the job remembers between nights. */
export interface TableGaugeSnapshot {
  /** ISO instant of the run that recorded it (`YYYY-MM-DDTHH:MM:SSZ`). */
  readonly takenAt: string;
  readonly gauges: readonly TableGauge[];
}

export interface ShrunkTable {
  readonly relation: string;
  readonly set: BackupSet;
  readonly previousRows: number;
  readonly rows: number;
}

export interface TableShrinkage {
  readonly previousTakenAt: string;
  /** Tables holding fewer rows than on the previous night, sorted by relation. */
  readonly shrunk: readonly ShrunkTable[];
  /** Tables gauged on the previous night and absent tonight, sorted. */
  readonly vanished: readonly string[];
}

const RELATION_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const TAKEN_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function checkedStat(stat: TableStat): void {
  if (!RELATION_RE.test(stat.relation)) {
    throw new RangeError(`relation ${JSON.stringify(stat.relation)} is not a plain identifier`);
  }
  if (!isCount(stat.rows)) {
    throw new RangeError(`rows of ${stat.relation} must be a non-negative integer`);
  }
  if (!isCount(stat.bytes)) {
    throw new RangeError(`bytes of ${stat.relation} must be a non-negative integer`);
  }
}

/**
 * Labels each table with the artifact that carries its rows under `plan`. Throws on a
 * malformed or duplicated stat: a gauge that is `NaN` or counted twice would read as a
 * healthy number on the dashboard it exists to keep honest.
 */
export function backupTableGauges(stats: readonly TableStat[], plan: BackupRunPlan): TableGauges {
  const setOf = new Map<string, BackupSet>();
  for (const artifact of plan.artifacts) {
    for (const relation of artifact.tablesWithData) setOf.set(relation, artifact.set);
  }
  const seen = new Set<string>();
  const gauges: TableGauge[] = [];
  const unplanned: string[] = [];
  for (const stat of stats) {
    checkedStat(stat);
    if (seen.has(stat.relation)) throw new RangeError(`relation ${stat.relation} listed twice`);
    seen.add(stat.relation);
    const set = setOf.get(stat.relation);
    if (set === undefined) unplanned.push(stat.relation);
    else gauges.push({ relation: stat.relation, set, rows: stat.rows, bytes: stat.bytes });
  }
  gauges.sort((a, b) => (a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0));
  unplanned.sort();
  return { gauges, unplanned };
}

/** Tonight against the previous night: every table that lost rows, and every one that went. */
export function compareTableGauges(
  previous: TableGaugeSnapshot,
  current: readonly TableGauge[],
): TableShrinkage {
  const tonight = new Map(current.map((g) => [g.relation, g]));
  const shrunk: ShrunkTable[] = [];
  const vanished: string[] = [];
  for (const before of previous.gauges) {
    const now = tonight.get(before.relation);
    if (now === undefined) {
      vanished.push(before.relation);
      continue;
    }
    if (now.rows < before.rows) {
      shrunk.push({
        relation: now.relation,
        set: now.set,
        previousRows: before.rows,
        rows: now.rows,
      });
    }
  }
  shrunk.sort((a, b) => (a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0));
  vanished.sort();
  return { previousTakenAt: previous.takenAt, shrunk, vanished };
}

/**
 * Reads a stored snapshot back, or null when it is not one. A malformed file is treated as
 * no previous night rather than as an error: the comparison is a convenience on top of the
 * gauges, and it must never be the reason a backup fails.
 */
export function parseTableGaugeSnapshot(value: unknown): TableGaugeSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { takenAt, gauges } = record;
  if (typeof takenAt !== 'string' || !TAKEN_AT_RE.test(takenAt)) return null;
  if (!Array.isArray(gauges)) return null;
  const parsed: TableGauge[] = [];
  const seen = new Set<string>();
  for (const entry of gauges as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { relation, set, rows, bytes } = entry as Record<string, unknown>;
    if (typeof relation !== 'string' || !RELATION_RE.test(relation) || seen.has(relation)) {
      return null;
    }
    if (set !== 'main' && set !== 'personal') return null;
    if (!isCount(rows) || !isCount(bytes)) return null;
    seen.add(relation);
    parsed.push({ relation, set, rows, bytes });
  }
  return { takenAt, gauges: parsed };
}
