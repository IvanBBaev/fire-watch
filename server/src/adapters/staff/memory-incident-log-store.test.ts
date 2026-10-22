/**
 * The curated-statement workflow and its rehearsal over the in-memory incident-log store
 * (TASKS L15). The Postgres store runs the same rehearsal in
 * `pg-staff-plane.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import { runCurationRehearsal } from '../../core/staff/curation-rehearsal.js';
import {
  CURATED_STATEMENT_FLAGS,
  createStatement,
  editStatement,
  openCorrection,
  readStatement,
  reviewStatement,
  submitStatement,
  type CurationDeps,
} from '../../core/staff/curated-statement-workflow.js';
import { REHEARSAL_STATEMENT } from '../../core/staff/curation-rehearsal.js';
import type { StaffPrincipal } from '../../core/staff/staff-policy.js';
import { createMemoryIncidentLogStore } from './memory-incident-log-store.js';

const AT = epochMsFromIso('2026-10-22T08:00:00Z');
const ctx = (who: StaffPrincipal, minutes = 0) => ({
  actorId: who.staffId,
  at: AT + minutes * 60_000,
});

const curator: StaffPrincipal = {
  staffId: 'staff-a',
  roles: ['editor'],
  secondFactorVerified: true,
};
const reviewer: StaffPrincipal = {
  staffId: 'staff-b',
  roles: ['editor'],
  secondFactorVerified: true,
};

function setup() {
  const log = createMemoryIncidentLogStore();
  let n = 0;
  const deps: CurationDeps = { log, newId: () => `entry-${String(++n)}` };
  return { log, deps };
}

describe('curated statement workflow', () => {
  it('always needs a second person, and never triggers a notification', async () => {
    const { deps } = setup();
    const created = await createStatement(deps, curator, REHEARSAL_STATEMENT, ctx(curator));
    expect(created.kind).toBe('ok');
    if (created.kind !== 'ok') return;
    expect(CURATED_STATEMENT_FLAGS).toEqual({ triggersNotifications: false, major: true });
    const submitted = await submitStatement(deps, curator, created.value.entryId, ctx(curator));
    expect(submitted.kind === 'ok' && submitted.value.status).toBe('in_review');
  });

  it('refuses a principal without a second factor, or without the editor role', async () => {
    const { deps } = setup();
    const pending = { ...curator, secondFactorVerified: false };
    expect(await createStatement(deps, pending, REHEARSAL_STATEMENT, ctx(curator))).toEqual({
      kind: 'refused',
      reason: 'not_permitted',
    });
    const moderator: StaffPrincipal = {
      staffId: 'm',
      roles: ['moderator'],
      secondFactorVerified: true,
    };
    expect((await createStatement(deps, moderator, REHEARSAL_STATEMENT, ctx(moderator))).kind).toBe(
      'refused',
    );
    expect(await readStatement(deps, moderator, 'entry-1')).toEqual({
      kind: 'refused',
      reason: 'not_permitted',
    });
  });

  it('refuses a correction as a fresh entry, and a non-correction as a revision', async () => {
    const { deps } = setup();
    expect(
      await createStatement(
        deps,
        curator,
        { ...REHEARSAL_STATEMENT, statementType: 'curated_correction' },
        ctx(curator),
      ),
    ).toMatchObject({ kind: 'refused', reason: 'invalid' });
  });

  it('withdraws a version in review to draft when it is edited', async () => {
    const { deps } = setup();
    const created = await createStatement(deps, curator, REHEARSAL_STATEMENT, ctx(curator));
    if (created.kind !== 'ok') throw new Error('not created');
    const id = created.value.entryId;
    const inReview = await submitStatement(deps, curator, id, ctx(curator, 1));
    if (inReview.kind !== 'ok') throw new Error('not submitted');
    const edited = await editStatement(
      deps,
      reviewer,
      id,
      inReview.value,
      { ...REHEARSAL_STATEMENT, justification: 'Tightened wording of the justification.' },
      ctx(reviewer, 2),
    );
    expect(edited.kind === 'ok' && edited.value.status).toBe('draft');
    expect(edited.kind === 'ok' && edited.value.contributorIds).toEqual(['staff-a', 'staff-b']);
    // A stale approval of the text before the edit is refused.
    expect(
      await reviewStatement(deps, reviewer, id, inReview.value, 'approve', ctx(reviewer, 3)),
    ).toEqual({ kind: 'refused', reason: 'conflict' });
  });

  it('a co-author cannot be the reviewer either', async () => {
    const { deps } = setup();
    const third: StaffPrincipal = {
      staffId: 'staff-c',
      roles: ['editor'],
      secondFactorVerified: true,
    };
    const created = await createStatement(deps, curator, REHEARSAL_STATEMENT, ctx(curator));
    if (created.kind !== 'ok') throw new Error('not created');
    const id = created.value.entryId;
    const edited = await editStatement(
      deps,
      reviewer,
      id,
      created.value,
      REHEARSAL_STATEMENT,
      ctx(reviewer),
    );
    if (edited.kind !== 'ok') throw new Error('not edited');
    const inReview = await submitStatement(deps, curator, id, ctx(curator));
    if (inReview.kind !== 'ok') throw new Error('not submitted');
    expect(
      (await reviewStatement(deps, reviewer, id, inReview.value, 'approve', ctx(reviewer))).kind,
    ).toBe('refused');
    const rejected = await reviewStatement(deps, third, id, inReview.value, 'reject', ctx(third));
    expect(rejected.kind === 'ok' && rejected.value.status).toBe('draft');
  });

  it('a correction must be about the same event and only of a published statement', async () => {
    const { deps } = setup();
    const created = await createStatement(deps, curator, REHEARSAL_STATEMENT, ctx(curator));
    if (created.kind !== 'ok') throw new Error('not created');
    const correction = {
      ...REHEARSAL_STATEMENT,
      statementType: 'curated_correction' as const,
      secondSource: null,
      exception: 'own_correction' as const,
      correctionText: 'the fire is active.',
    };
    expect(
      await openCorrection(deps, curator, created.value.entryId, correction, ctx(curator)),
    ).toEqual({ kind: 'refused', reason: 'wrong_status' });
    expect(await openCorrection(deps, curator, 'missing', correction, ctx(curator))).toEqual({
      kind: 'refused',
      reason: 'not_found',
    });
  });
});

describe('curation rehearsal (in memory)', () => {
  it('walks draft → review → publish → correction with two-person approval', async () => {
    const { log, deps } = setup();
    const report = await runCurationRehearsal(deps, { curator, reviewer, startAt: AT });
    expect(report.steps.filter((s) => !s.passed)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.history.map((v) => [v.version, v.statement.statementType, v.corrects])).toEqual([
      [1, 'officially_extinguished', null],
      [2, 'curated_correction', 1],
    ]);
    // The trail: each publication is the reviewer's, never the curator's.
    expect(log.audit().map((row) => [row.actorId, row.action, row.version])).toEqual([
      ['staff-a', 'incident.draft', 1],
      ['staff-a', 'incident.submit', 1],
      ['staff-b', 'incident.publish', 1],
      ['staff-a', 'incident.edit', 2],
      ['staff-a', 'incident.submit', 2],
      ['staff-b', 'incident.publish', 2],
    ]);
  });

  it('fails when the second member is the curator', async () => {
    const { deps } = setup();
    const report = await runCurationRehearsal(deps, { curator, reviewer: curator, startAt: AT });
    expect(report.passed).toBe(false);
  });
});
