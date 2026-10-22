/**
 * The incident-log draft→publish workflow, as pure functions (TASKS I1; 05 C4, §5.4.3, T7).
 *
 * An incident-log entry is versioned. Each version moves `draft` → (`in_review`) →
 * `published`; a published version is never edited in place — a revision opens version
 * N+1 as a new draft while version N stays the public one, so the public page's "updated
 * at" history (§5.4.3) is the list of published versions.
 *
 * **When a second review is required** (C4): only when the version triggers notifications
 * or is marked "major incident" — {@link requiresSecondReview}. Otherwise the editor who
 * submits it publishes it.
 *
 * **Who may review**: a principal allowed `incident.review` who did not contribute to the
 * version under review. Contributors, not just the first author: if A drafts and B edits,
 * A reviewing would let A publish their own words with only a co-author's nod. Any edit
 * while `in_review` sends the version back to `draft`, so an approval always covers the
 * exact text that goes live.
 *
 * Every decision here is a value; writing the version row and its audit row
 * (`staff-audit.ts`) in one transaction is the adapter's job.
 */

import { staffMay, type StaffPrincipal } from './staff-policy.js';

export type IncidentEntryStatus = 'draft' | 'in_review' | 'published';

export interface IncidentEntryVersion {
  readonly entryId: string;
  /** 1 for the first version; each revision of a published version adds one. */
  readonly version: number;
  readonly status: IncidentEntryStatus;
  /** Everyone who changed this version's content, in first-touch order. Never empty. */
  readonly contributorIds: readonly string[];
  readonly triggersNotifications: boolean;
  readonly major: boolean;
}

export type WorkflowRefusal =
  'not_permitted' | 'wrong_status' | 'reviewer_is_contributor' | 'review_not_required';

export type WorkflowDecision =
  | { readonly kind: 'ok'; readonly next: IncidentEntryVersion }
  | { readonly kind: 'refused'; readonly reason: WorkflowRefusal };

export function requiresSecondReview(
  version: Pick<IncidentEntryVersion, 'triggersNotifications' | 'major'>,
): boolean {
  return version.triggersNotifications || version.major;
}

/** A brand-new entry: version 1, a draft whose only contributor is its author. */
export function startEntry(
  entryId: string,
  author: StaffPrincipal,
  flags: { readonly triggersNotifications: boolean; readonly major: boolean },
): WorkflowDecision {
  if (!staffMay(author, 'incident.draft')) return refused('not_permitted');
  return {
    kind: 'ok',
    next: {
      entryId,
      version: 1,
      status: 'draft',
      contributorIds: [author.staffId],
      triggersNotifications: flags.triggersNotifications,
      major: flags.major,
    },
  };
}

/**
 * An edit. On a draft it adds the editor as a contributor; on a version in review it also
 * withdraws it to `draft`; on a published version it opens version N+1. The flags may
 * change with the edit — raising `major` on a draft is exactly how an entry comes to need
 * review.
 */
export function editEntry(
  current: IncidentEntryVersion,
  editor: StaffPrincipal,
  flags: { readonly triggersNotifications: boolean; readonly major: boolean },
): WorkflowDecision {
  if (!staffMay(editor, 'incident.draft')) return refused('not_permitted');
  const opensRevision = current.status === 'published';
  return {
    kind: 'ok',
    next: {
      entryId: current.entryId,
      version: opensRevision ? current.version + 1 : current.version,
      status: 'draft',
      contributorIds: opensRevision
        ? [editor.staffId]
        : withContributor(current.contributorIds, editor.staffId),
      triggersNotifications: flags.triggersNotifications,
      major: flags.major,
    },
  };
}

/** Submit a draft: straight to `published`, or to `in_review` when C4 requires it. */
export function submitEntry(
  current: IncidentEntryVersion,
  submitter: StaffPrincipal,
): WorkflowDecision {
  if (!staffMay(submitter, 'incident.publish')) return refused('not_permitted');
  if (current.status !== 'draft') return refused('wrong_status');
  return {
    kind: 'ok',
    next: { ...current, status: requiresSecondReview(current) ? 'in_review' : 'published' },
  };
}

/** The second review: approve publishes, reject returns the version to its authors. */
export function reviewEntry(
  current: IncidentEntryVersion,
  reviewer: StaffPrincipal,
  verdict: 'approve' | 'reject',
): WorkflowDecision {
  if (!staffMay(reviewer, 'incident.review')) return refused('not_permitted');
  if (current.status !== 'in_review') return refused('wrong_status');
  if (!requiresSecondReview(current)) return refused('review_not_required');
  if (current.contributorIds.includes(reviewer.staffId)) return refused('reviewer_is_contributor');
  return {
    kind: 'ok',
    next: { ...current, status: verdict === 'approve' ? 'published' : 'draft' },
  };
}

function withContributor(ids: readonly string[], staffId: string): readonly string[] {
  return ids.includes(staffId) ? ids : [...ids, staffId];
}

function refused(reason: WorkflowRefusal): WorkflowDecision {
  return { kind: 'refused', reason };
}
