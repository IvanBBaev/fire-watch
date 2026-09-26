/**
 * The previous night's table gauges, as one JSON file on the backup host (TASKS C6).
 *
 * Kept beside the staging directory (the CLI puts it there), outside the artifact name
 * pattern the staging prune deletes. It holds counts and sizes only — no rows — so it needs
 * no lifecycle rule; it is still written 0600 like everything else the job leaves on disk.
 *
 * The write is atomic (temporary file, then rename), so a job killed mid-write leaves the
 * previous baseline intact rather than a truncated one. A missing or malformed file reads
 * as "no previous night": the comparison is a convenience and never fails a backup.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { TableGaugeLedger } from '../../core/backup/ports.js';
import {
  parseTableGaugeSnapshot,
  type TableGaugeSnapshot,
} from '../../core/backup/table-gauges.js';
import { canonicalJson } from '../../core/determinism/canonical-json.js';

/** The ledger's file name inside the staging directory. */
export const TABLE_GAUGE_LEDGER_FILE = 'table-gauges.json';

export function createLocalFsGaugeLedger(filePath: string): TableGaugeLedger {
  return {
    async read(): Promise<TableGaugeSnapshot | null> {
      let text: string;
      try {
        text = await readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      try {
        return parseTableGaugeSnapshot(JSON.parse(text) as unknown);
      } catch {
        return null;
      }
    },

    async write(snapshot: TableGaugeSnapshot): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.tmp`;
      const body = canonicalJson({
        takenAt: snapshot.takenAt,
        gauges: snapshot.gauges.map((g) => ({
          relation: g.relation,
          set: g.set,
          rows: g.rows,
          bytes: g.bytes,
        })),
      });
      try {
        await writeFile(temporary, `${body}\n`, { mode: 0o600 });
        await rename(temporary, filePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}
