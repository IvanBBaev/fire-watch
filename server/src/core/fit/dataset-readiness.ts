/**
 * "D7 does not start until its input has an entry" (review 23 E1) as a check the fit CLI
 * runs, not a sentence it hopes was read (TASKS D7).
 *
 * The input is the text of `docs/data/DATASETS.md`. An entry is a `### DS-n — …` section;
 * it is *checked* when its table has a row whose field begins with ``Last `--check` `` and
 * whose value begins with a `YYYY-MM-DD` date — the date its manifest was last verified
 * offline. A dash, a blank, or no such row at all is "not checked", and the reason says
 * which, so the operator knows whether to run `--check` or to write the row first.
 *
 * DS-1 (detections) and DS-3 (labels) gate the run. DS-4 (GEO, 2025) gates only the ε_geo
 * sweep. `--synthetic` skips the whole check and the report says it did.
 */

export type DatasetId = 'DS-1' | 'DS-3' | 'DS-4';

export interface DatasetStatus {
  readonly id: DatasetId;
  readonly title: string | null;
  /** `YYYY-MM-DD`, or `null` when not checked. */
  readonly checkedOn: string | null;
  /** Why it is not checked; `null` when it is. */
  readonly problem: 'no_entry' | 'no_check_row' | 'no_check_date' | null;
}

export const REQUIRED_DATASETS: readonly DatasetId[] = ['DS-1', 'DS-3'];

const HEADING_RE = /^###\s+(DS-\d+)\s*(?:[—–-]\s*(.*))?$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})\b/;

export function datasetStatus(markdown: string, id: DatasetId): DatasetStatus {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADING_RE.exec(line.trim())?.[1] === id);
  if (start < 0) return { id, title: null, checkedOn: null, problem: 'no_entry' };
  const title = (HEADING_RE.exec((lines[start] as string).trim())?.[2] ?? '').trim();
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,3}\s/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  for (const line of lines.slice(start + 1, end)) {
    const cells = line.split('|').map((c) => c.trim());
    // `| field | value |` → ['', field, value, '']
    if (cells.length < 4 || cells[0] !== '') continue;
    if (!(cells[1] as string).startsWith('Last `--check`')) continue;
    const date = DATE_RE.exec(cells[2] as string)?.[1] ?? null;
    return date === null
      ? { id, title, checkedOn: null, problem: 'no_check_date' }
      : { id, title, checkedOn: date, problem: null };
  }
  return { id, title, checkedOn: null, problem: 'no_check_row' };
}

export interface Readiness {
  readonly datasets: readonly DatasetStatus[];
  /** DS-1 and DS-3 both checked. */
  readonly ready: boolean;
  /** DS-4 checked: the ε_geo sweep may run on real data. */
  readonly geoReady: boolean;
}

export function readiness(markdown: string): Readiness {
  const datasets = (['DS-1', 'DS-3', 'DS-4'] as const).map((id) => datasetStatus(markdown, id));
  const checked = (id: DatasetId): boolean =>
    datasets.some((d) => d.id === id && d.checkedOn !== null);
  return {
    datasets,
    ready: REQUIRED_DATASETS.every(checked),
    geoReady: checked('DS-4'),
  };
}
