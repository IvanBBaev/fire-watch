import { describe, expect, it } from 'vitest';

import {
  editEntry,
  requiresSecondReview,
  reviewEntry,
  startEntry,
  submitEntry,
  type IncidentEntryVersion,
  type WorkflowDecision,
} from './incident-log-workflow.js';
import type { StaffPrincipal, StaffRole } from './staff-policy.js';

const member = (
  staffId: string,
  roles: StaffRole[] = ['editor'],
  verified = true,
): StaffPrincipal => ({
  staffId,
  roles,
  secondFactorVerified: verified,
});
const ANA = member('ana');
const BOB = member('bob');
const CAL = member('cal');
const PLAIN = { triggersNotifications: false, major: false };
const MAJOR = { triggersNotifications: false, major: true };

function ok(decision: WorkflowDecision): IncidentEntryVersion {
  if (decision.kind !== 'ok') throw new Error(`refused: ${decision.reason}`);
  return decision.next;
}

describe('requiresSecondReview (C4)', () => {
  it('only when the entry triggers notifications or is major', () => {
    expect(requiresSecondReview(PLAIN)).toBe(false);
    expect(requiresSecondReview(MAJOR)).toBe(true);
    expect(requiresSecondReview({ triggersNotifications: true, major: false })).toBe(true);
  });
});

describe('an ordinary entry', () => {
  it('is published by the editor who submits it, with no review', () => {
    const draft = ok(startEntry('e1', ANA, PLAIN));
    expect(draft).toEqual({
      entryId: 'e1',
      version: 1,
      status: 'draft',
      contributorIds: ['ana'],
      ...PLAIN,
    });
    expect(ok(submitEntry(draft, ANA)).status).toBe('published');
  });
});

describe('a major entry', () => {
  const inReview = ok(submitEntry(ok(startEntry('e1', ANA, MAJOR)), ANA));

  it('goes to review instead of going live', () => {
    expect(inReview.status).toBe('in_review');
  });

  it('cannot be reviewed by its author', () => {
    expect(reviewEntry(inReview, ANA, 'approve')).toEqual({
      kind: 'refused',
      reason: 'reviewer_is_contributor',
    });
  });

  it('is published by a second editor, or returned to draft', () => {
    expect(ok(reviewEntry(inReview, BOB, 'approve')).status).toBe('published');
    expect(ok(reviewEntry(inReview, BOB, 'reject')).status).toBe('draft');
  });

  it('cannot be reviewed by any co-author, not just the first one', () => {
    const coWritten = ok(submitEntry(ok(editEntry(inReview, BOB, MAJOR)), BOB));
    expect(coWritten.contributorIds).toEqual(['ana', 'bob']);
    expect(reviewEntry(coWritten, ANA, 'approve').kind).toBe('refused');
    expect(reviewEntry(coWritten, BOB, 'approve').kind).toBe('refused');
    expect(ok(reviewEntry(coWritten, CAL, 'approve')).status).toBe('published');
  });

  it('is withdrawn to draft by any edit during review, so approval covers the live text', () => {
    const edited = ok(editEntry(inReview, ANA, MAJOR));
    expect(edited.status).toBe('draft');
    expect(reviewEntry(edited, BOB, 'approve')).toEqual({
      kind: 'refused',
      reason: 'wrong_status',
    });
  });

  it('needs review once an edit raises the flag on an ordinary draft', () => {
    const raised = ok(editEntry(ok(startEntry('e2', ANA, PLAIN)), ANA, MAJOR));
    expect(ok(submitEntry(raised, ANA)).status).toBe('in_review');
  });
});

describe('revising a published entry', () => {
  it('opens version N+1 as a fresh draft whose contributors are only the reviser', () => {
    const published = ok(submitEntry(ok(startEntry('e1', ANA, PLAIN)), ANA));
    const revision = ok(editEntry(published, BOB, MAJOR));
    expect(revision).toMatchObject({
      version: 2,
      status: 'draft',
      contributorIds: ['bob'],
      major: true,
    });
    expect(published.version).toBe(1);
    // Ana did not write version 2, so she may review it.
    expect(ok(reviewEntry(ok(submitEntry(revision, BOB)), ANA, 'approve')).status).toBe(
      'published',
    );
  });
});

describe('permissions', () => {
  it('refuses everything to non-editors and to a session without its second factor', () => {
    for (const who of [
      member('o', ['alert-operator']),
      member('a', ['admin']),
      member('e', ['editor'], false),
    ]) {
      expect(startEntry('e1', who, PLAIN)).toEqual({ kind: 'refused', reason: 'not_permitted' });
    }
    const inReview = ok(submitEntry(ok(startEntry('e1', ANA, MAJOR)), ANA));
    expect(reviewEntry(inReview, member('a', ['admin']), 'approve')).toEqual({
      kind: 'refused',
      reason: 'not_permitted',
    });
  });

  it('refuses to submit anything that is not a draft', () => {
    const published = ok(submitEntry(ok(startEntry('e1', ANA, PLAIN)), ANA));
    expect(submitEntry(published, ANA)).toEqual({ kind: 'refused', reason: 'wrong_status' });
  });
});
