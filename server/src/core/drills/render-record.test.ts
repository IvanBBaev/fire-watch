import { describe, expect, it } from 'vitest';

import { check, type DrillRecord } from './drill-record.js';
import { recordFileName, renderDrillRecord } from './render-record.js';
import { evaluateRto } from './rto.js';

const STEP = {
  id: 'restore_database',
  title: 'Restore',
  mode: 'automated' as const,
  onRtoPath: true,
  status: 'passed' as const,
  startedAt: '2026-09-25T10:00:00.000Z',
  durationMs: 90_000,
  detail: 'fw-main/daily/… → fw_restore_drill',
};

const RECORD: DrillRecord = {
  kind: 'restore',
  environment: 'Staging EU',
  target: { pg_database: 'fire_watch_staging', bucket: 'fw-staging' },
  startedAt: '2026-09-25T10:00:00.000Z',
  finishedAt: '2026-09-25T10:02:00.000Z',
  steps: [STEP],
  checks: [check('row_counts_match_gauges', 'Rows', 'fail', 'a | b\nc', 'OPERATIONS §6.3')],
  rto: evaluateRto([{ ...STEP, durationMs: 300 * 60_000 }]),
  facts: { scratch_database: 'fw_restore_drill' },
  findings: ['fire_events short by 1'],
  openItems: ['Drop the scratch database.'],
};

describe('renderDrillRecord', () => {
  const text = renderDrillRecord(RECORD);

  it('leads with the kind, the start and the verdict', () => {
    expect(text.split('\n')[0]).toBe(
      '# Backup/restore + RTO drill (TASKS J2) — 2026-09-25T10:00:00.000Z',
    );
    expect(text).toContain('**Verdict: FAILED**');
  });

  it('escapes pipes and newlines inside table cells', () => {
    expect(text).toContain(
      '| row_counts_match_gauges — Rows | fail | a \\| b c | OPERATIONS §6.3 |',
    );
  });

  it('states an exceeded RTO and the freeze-priority rule', () => {
    expect(text).toContain('- Status: **exceeded**');
    expect(text).toContain('§6.3 rule 4');
    expect(text).toContain('| restore_database — Restore | automated | yes | passed | 1.5 min |');
  });

  it('leaves operator notes, secrets included for a restore', () => {
    expect(text).toContain('## Operator notes');
    expect(text).toContain('- Secrets restored');
    expect(renderDrillRecord({ ...RECORD, kind: 'erasure', rto: null })).not.toContain(
      'Secrets restored',
    );
  });

  it('is deterministic and sorts target and facts', () => {
    expect(renderDrillRecord(RECORD)).toBe(text);
    expect(text.indexOf('Target: bucket')).toBeLessThan(text.indexOf('Target: pg_database'));
  });
});

describe('recordFileName', () => {
  it('is sortable and slugs the environment', () => {
    expect(recordFileName(RECORD)).toBe('2026-09-25T100000Z-restore-staging-eu.md');
    expect(recordFileName({ ...RECORD, environment: '!!' })).toBe(
      '2026-09-25T100000Z-restore-unnamed.md',
    );
  });
});
