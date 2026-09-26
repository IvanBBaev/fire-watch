import { describe, expect, it } from 'vitest';

import { budgetFor } from '../config/freshness-budgets.js';
import { epochMsFromIso } from '../ports/clock.js';
import type { PublicObjectObservation } from '../ports/object-store.js';
import { evaluateMirrorAge, FUTURE_STAMP_TOLERANCE_MS } from './mirror-age.js';

const NOW = epochMsFromIso('2026-07-14T10:15:00Z');
const BUDGET = { warnSeconds: 300, criticalSeconds: 900 };

function present(overrides: Partial<Extract<PublicObjectObservation, { kind: 'present' }>> = {}) {
  return {
    kind: 'present' as const,
    status: 200,
    generatedAtMs: NOW - 30_000,
    lastModifiedMs: NOW - 29_000,
    etag: '"abc"',
    cacheControl: 'public, max-age=0, s-maxage=30',
    ...overrides,
  };
}

describe('evaluateMirrorAge', () => {
  it('uses the snapshot-push budget row (OPERATIONS §1.3)', () => {
    expect(budgetFor('snapshot-push')).toMatchObject(BUDGET);
  });

  it('is ok under the warn budget, anchored on the job-written stamp', () => {
    expect(evaluateMirrorAge(present(), NOW, BUDGET)).toMatchObject({
      level: 'ok',
      reason: 'fresh',
      age_seconds: 30,
      anchor: 'metadata',
      generated_at: '2026-07-14T10:14:30Z',
    });
  });

  it('warns at exactly the warn budget and is critical at exactly the critical one', () => {
    expect(evaluateMirrorAge(present({ generatedAtMs: NOW - 300_000 }), NOW, BUDGET)).toMatchObject(
      { level: 'warn', reason: 'stale', age_seconds: 300 },
    );
    expect(evaluateMirrorAge(present({ generatedAtMs: NOW - 900_000 }), NOW, BUDGET)).toMatchObject(
      { level: 'critical', reason: 'stale', age_seconds: 900 },
    );
  });

  it('prefers the metadata stamp over Last-Modified', () => {
    const verdict = evaluateMirrorAge(
      present({ generatedAtMs: NOW - 1_000_000, lastModifiedMs: NOW - 1_000 }),
      NOW,
      BUDGET,
    );
    expect(verdict).toMatchObject({ level: 'critical', anchor: 'metadata' });
  });

  it('falls back to Last-Modified when the hostname does not echo metadata', () => {
    expect(
      evaluateMirrorAge(
        present({ generatedAtMs: null, lastModifiedMs: NOW - 400_000 }),
        NOW,
        BUDGET,
      ),
    ).toMatchObject({ level: 'warn', anchor: 'last-modified', age_seconds: 400 });
  });

  it('cannot vouch for an object with no age signal', () => {
    expect(
      evaluateMirrorAge(present({ generatedAtMs: null, lastModifiedMs: null }), NOW, BUDGET),
    ).toMatchObject({ level: 'critical', reason: 'no_age_signal', age_seconds: null });
  });

  it('reads a missing or unreachable object as the fallback tier being down', () => {
    expect(evaluateMirrorAge({ kind: 'missing', status: 404 }, NOW, BUDGET)).toMatchObject({
      level: 'critical',
      reason: 'missing',
      status: 404,
    });
    expect(
      evaluateMirrorAge({ kind: 'unreachable', reason: 'timed out' }, NOW, BUDGET),
    ).toMatchObject({ level: 'critical', reason: 'unreachable', detail: 'timed out' });
  });

  it('tolerates small skew but flags a stamp from the future', () => {
    expect(evaluateMirrorAge(present({ generatedAtMs: NOW + 5_000 }), NOW, BUDGET)).toMatchObject({
      level: 'ok',
      age_seconds: 0,
    });
    expect(
      evaluateMirrorAge(
        present({ generatedAtMs: NOW + FUTURE_STAMP_TOLERANCE_MS + 1_000 }),
        NOW,
        BUDGET,
      ),
    ).toMatchObject({ level: 'warn', reason: 'future_stamp' });
  });
});
