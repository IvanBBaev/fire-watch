import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { check, type DrillRecord } from '../core/drills/drill-record.js';
import { DRILL_EXIT_CODES, drillSummaryLine, writeDrillRecord } from './drill-output.js';

const RECORD: DrillRecord = {
  kind: 'erasure',
  environment: 'staging',
  target: { pg_host: 'db.staging.internal' },
  startedAt: '2026-09-25T10:00:00Z',
  finishedAt: '2026-09-25T10:00:05Z',
  steps: [
    {
      id: 'seed',
      title: 'Seed',
      mode: 'automated',
      onRtoPath: false,
      status: 'passed',
      startedAt: '2026-09-25T10:00:00Z',
      durationMs: 1_000,
      detail: '',
    },
  ],
  checks: [
    check('rows_gone', 'Rows gone', 'pass', '', 'ADR-004 D8'),
    check('ledger', 'Ledger', 'fail', 'missing', 'OPERATIONS §6.2'),
  ],
  rto: null,
  facts: {},
  findings: ['ledger missing'],
  openItems: [],
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('writeDrillRecord', () => {
  it('writes the rendered record under a nested directory and never overwrites', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fw-drill-'));
    dirs.push(root);
    const dir = join(root, 'records', 'nested');
    const path = await writeDrillRecord(RECORD, dir);
    expect(path).toBe(join(dir, '2026-09-25T100000Z-erasure-staging.md'));
    expect(await readFile(path, 'utf8')).toContain('**Verdict: FAILED**');
    await expect(writeDrillRecord(RECORD, dir)).rejects.toThrow(/EEXIST/);
  });
});

describe('drillSummaryLine', () => {
  it('is one canonical-JSON line with the verdict and the tally', () => {
    const line = drillSummaryLine(RECORD, '/r.md');
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      drill_summary: {
        kind: 'erasure',
        environment: 'staging',
        verdict: 'failed',
        checks: { pass: 1, fail: 1 },
        failed_steps: [],
        rto: null,
        findings: 1,
        record: '/r.md',
      },
    });
  });
});

describe('DRILL_EXIT_CODES', () => {
  it('keeps 2 free for misconfiguration', () => {
    expect(Object.values(DRILL_EXIT_CODES).sort()).toEqual([0, 1, 3]);
  });
});
