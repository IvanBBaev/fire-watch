import { describe, expect, it } from 'vitest';

import { FRESHNESS_STATES, FRESHNESS_STATUSES } from '../../../packages/contracts/src/freshness.js';

import {
  FRESHNESS_BODY_STATES,
  FRESHNESS_BODY_STATUSES,
  parseFreshnessBody,
} from './freshness-body.js';

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  row: 'firms:viirs:snpp',
  state: 'ok',
  pages: true,
  ageSeconds: 120,
  lastSuccessAt: '2026-09-25T10:00:00Z',
  mutedUntil: null,
  muteReason: null,
  // Fields the status page does not read are tolerated, not required.
  budget: { warnSeconds: 1800 },
  ...overrides,
});

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'ok',
  generatedAt: '2026-09-25T10:02:00Z',
  budgetVersion: '2026-09-01',
  rows: [row()],
  ...overrides,
});

describe('parseFreshnessBody', () => {
  it('mirrors the contract vocabularies exactly (drift pin)', () => {
    expect([...FRESHNESS_BODY_STATES]).toEqual([...FRESHNESS_STATES]);
    expect([...FRESHNESS_BODY_STATUSES]).toEqual([...FRESHNESS_STATUSES]);
  });

  it('reads a well-formed report, keeping only what the page uses', () => {
    expect(parseFreshnessBody(body())).toEqual({
      status: 'ok',
      generatedAt: '2026-09-25T10:02:00Z',
      budgetVersion: '2026-09-01',
      rows: [
        {
          row: 'firms:viirs:snpp',
          state: 'ok',
          pages: true,
          ageSeconds: 120,
          lastSuccessAt: '2026-09-25T10:00:00Z',
          mutedUntil: null,
          muteReason: null,
        },
      ],
    });
  });

  it('keeps a row id this build does not know', () => {
    const parsed = parseFreshnessBody(body({ rows: [row({ row: 'future:feed' })] }));
    expect(parsed?.rows[0]?.row).toBe('future:feed');
  });

  it('accepts a null age and a muted row with its reason', () => {
    const parsed = parseFreshnessBody(
      body({
        rows: [
          row({
            state: 'muted',
            ageSeconds: null,
            mutedUntil: '2026-09-26T00:00:00Z',
            muteReason: 'Provider maintenance',
          }),
        ],
      }),
    );
    expect(parsed?.rows[0]).toMatchObject({ state: 'muted', ageSeconds: null });
  });

  it.each([
    ['a non-object', 'Bad Gateway'],
    ['null', null],
    ['an array', []],
    ['an unknown status', body({ status: 'fine' })],
    ['a missing generatedAt', body({ generatedAt: undefined })],
    ['a numeric budgetVersion', body({ budgetVersion: 3 })],
    ['rows that are not an array', body({ rows: {} })],
  ])('rejects %s', (_label, value) => {
    expect(parseFreshnessBody(value)).toBeNull();
  });

  it.each([
    ['an unknown state', { state: 'green' }],
    ['an empty row id', { row: '' }],
    ['a non-boolean pages', { pages: 'yes' }],
    ['a non-finite age', { ageSeconds: Number.NaN }],
    ['a string age', { ageSeconds: '120' }],
    ['a numeric lastSuccessAt', { lastSuccessAt: 5 }],
    ['a numeric muteReason', { muteReason: 1 }],
  ])('rejects the whole body for one row with %s', (_label, overrides) => {
    expect(parseFreshnessBody(body({ rows: [row(), row(overrides)] }))).toBeNull();
  });
});
