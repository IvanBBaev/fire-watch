/**
 * Row counts after a restore, against the gauges the backup recorded at dump time
 * (TASKS J2, C6; OPERATIONS §6.3 rule 3; runbook 02 §5 step 3).
 *
 * The backup counts every table **inside the exported snapshot** both dumps read, so its
 * gauges are exactly what a faithful restore must hold — not an estimate. Hence the check
 * is equality, table by table:
 *
 *   - a `main` table holds its gauged rows;
 *   - a `personal` table holds its gauged rows when the companion was restored, and none
 *     when it was not (the rule-8 leg: main alone must carry no personal row);
 *   - a gauged table missing from the restore is a mismatch; so is a table the backup
 *     never gauged (no artifact carries its data) that comes back holding rows.
 *
 * Pure.
 */

import type { RelationRowCount } from '../backup/restore-verify.js';
import type { TableGauge } from '../backup/table-gauges.js';
import { check, type DrillCheck } from './drill-record.js';

export interface RowMismatch {
  readonly relation: string;
  readonly expected: number | null;
  readonly restored: number | null;
}

export interface RowComparison {
  readonly check: DrillCheck;
  readonly mismatches: readonly RowMismatch[];
  /** Tables compared and equal. */
  readonly matched: number;
}

const ID = 'row_counts_match_gauges';
const TITLE = 'Restored row counts equal the gauges recorded at dump time';
const SPEC = 'OPERATIONS §6.3 rule 3; runbook 02 §5 step 3';

export function compareRestoredRows(
  gauges: readonly TableGauge[] | null,
  restored: readonly RelationRowCount[] | null,
  personalRestored: boolean,
): RowComparison {
  if (gauges === null || restored === null) {
    return {
      check: check(
        ID,
        TITLE,
        'not_run',
        gauges === null
          ? 'no dump-time gauges (restore-only drill, or the backup could not read them)'
          : 'the restore did not report row counts',
        SPEC,
      ),
      mismatches: [],
      matched: 0,
    };
  }
  const restoredBy = new Map(restored.map((count) => [count.relation, count.rows]));
  const gaugedBy = new Map(gauges.map((gauge) => [gauge.relation, gauge]));
  const mismatches: RowMismatch[] = [];
  let matched = 0;
  for (const gauge of [...gauges].sort((a, b) => a.relation.localeCompare(b.relation))) {
    const expected = gauge.set === 'personal' && !personalRestored ? 0 : gauge.rows;
    const rows = restoredBy.get(gauge.relation);
    if (rows === undefined) {
      mismatches.push({ relation: gauge.relation, expected, restored: null });
    } else if (rows !== expected) {
      mismatches.push({ relation: gauge.relation, expected, restored: rows });
    } else {
      matched += 1;
    }
  }
  for (const count of [...restored].sort((a, b) => a.relation.localeCompare(b.relation))) {
    // A table no artifact carries data for (excluded, or unplanned at dump time) is
    // restored schema-only: empty is right, rows are not.
    if (!gaugedBy.has(count.relation) && count.rows > 0) {
      mismatches.push({ relation: count.relation, expected: null, restored: count.rows });
    }
  }
  const detail =
    mismatches.length === 0
      ? `${String(matched)} tables equal${personalRestored ? '' : ' (personal tables expected empty: companion not restored)'}`
      : mismatches
          .map(
            (m) =>
              `${m.relation}: expected ${m.expected === null ? 'not gauged' : String(m.expected)}, restored ${m.restored === null ? 'absent' : String(m.restored)}`,
          )
          .join('; ');
  return {
    check: check(ID, TITLE, mismatches.length === 0 ? 'pass' : 'fail', detail, SPEC),
    mismatches,
    matched,
  };
}
