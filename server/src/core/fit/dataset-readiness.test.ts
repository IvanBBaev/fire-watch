import { describe, expect, it } from 'vitest';

import { datasetStatus, readiness } from './dataset-readiness.js';

const doc = (ds1: string, ds3: string | null, ds4 = '') => `# Datasets

### DS-1 — FIRMS archive

| Field | Value |
| ----- | ----- |
| Product | VIIRS_SNPP_SP |
${ds1}

### DS-3 — EFFIS labels

| Field | Value |
| ----- | ----- |
${ds3 ?? '| Product | EFFIS BA |'}

## Next section

| Last \`--check\` (offline) | 2026-01-01 |

### DS-4 — GEO
${ds4}
`;

const CHECKED = '| Last `--check` (`backfill-cli.js --check`, offline) | 2026-10-01, sha 1234 |';
const DASH = '| Last `--check` (`backfill-cli.js --check`, offline) | — |';

describe('dataset readiness (23 E1)', () => {
  it('is ready only when DS-1 and DS-3 both carry a dated check row', () => {
    const r = readiness(doc(CHECKED, CHECKED));
    expect(r.ready).toBe(true);
    expect(r.geoReady).toBe(false);
    expect(r.datasets.map((d) => [d.id, d.checkedOn, d.problem])).toEqual([
      ['DS-1', '2026-10-01', null],
      ['DS-3', '2026-10-01', null],
      ['DS-4', null, 'no_check_row'],
    ]);
  });

  it('says whether the row is missing or only undated', () => {
    const r = readiness(doc(DASH, null));
    expect(r.ready).toBe(false);
    expect(r.datasets[0]).toMatchObject({
      id: 'DS-1',
      title: 'FIRMS archive',
      problem: 'no_check_date',
    });
    // DS-3's section ends at the `##` heading: the dated row below it is not DS-3's.
    expect(r.datasets[1]).toMatchObject({ id: 'DS-3', problem: 'no_check_row' });
  });

  it('reports a missing entry', () => {
    expect(datasetStatus('# nothing here', 'DS-1')).toEqual({
      id: 'DS-1',
      title: null,
      checkedOn: null,
      problem: 'no_entry',
    });
  });

  it('gates the GEO sweep on DS-4 alone', () => {
    const r = readiness(doc(DASH, null, `\n| Field | Value |\n| - | - |\n${CHECKED}`));
    expect(r.ready).toBe(false);
    expect(r.geoReady).toBe(true);
  });
});
