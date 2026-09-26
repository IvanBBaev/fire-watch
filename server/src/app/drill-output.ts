/**
 * What both drill CLIs do with a finished record (TASKS I7, J2; OPERATIONS §6.3 rule 3):
 * render it, write it under the records directory — never over an existing file — and turn
 * its verdict into the process exit code and one summary line.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../core/determinism/canonical-json.js';
import { drillVerdict, type DrillRecord, type DrillVerdict } from '../core/drills/drill-record.js';
import { recordFileName, renderDrillRecord } from '../core/drills/render-record.js';

/** `docs/drills/records`, from `server/dist/app/` and from `server/src/app/` alike. */
export const DEFAULT_RECORD_DIR = fileURLToPath(
  new URL('../../../docs/drills/records', import.meta.url),
);

export const DRILL_EXIT_CODES: Readonly<Record<DrillVerdict, number>> = {
  passed: 0,
  failed: 1,
  incomplete: 3,
};

/** Writes the rendered record; `wx`, so a second drill in the same second never overwrites. */
export async function writeDrillRecord(record: DrillRecord, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, recordFileName(record));
  await writeFile(path, renderDrillRecord(record), { flag: 'wx', encoding: 'utf8' });
  return path;
}

export function drillSummaryLine(record: DrillRecord, recordPath: string): string {
  const tally: Record<string, number> = {};
  for (const item of record.checks) tally[item.status] = (tally[item.status] ?? 0) + 1;
  return canonicalJson({
    drill_summary: {
      kind: record.kind,
      environment: record.environment,
      verdict: drillVerdict(record),
      checks: tally,
      failed_steps: record.steps.filter((s) => s.status === 'failed').map((s) => s.id),
      rto:
        record.rto === null
          ? null
          : { status: record.rto.status, minutes: record.rto.measuredMinutes },
      findings: record.findings.length,
      record: recordPath,
    },
  });
}
