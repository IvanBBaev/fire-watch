/**
 * Curated statements on the incident-log workflow (TASKS L15; review 16 §5.2–§5.5, §5.10).
 *
 * A curated statement — "the authority declared this fire contained / extinguished", or
 * our correction of such a statement — is an incident-log entry whose content is the WP6
 * form (`@fire-watch/contracts` `CuratedStatementDraft`). Reusing the incident log gives
 * the statement everything §5.5 asks of it without a new table: versions that are frozen
 * once published, a revision that is version N+1 while version N stays on the record, a
 * compare-and-set on every write, and an audit row in the same transaction.
 *
 * **Two-person approval, always.** Every version is written with `major: true` and
 * `triggersNotifications: false`. The first forces the C4 second review, so a statement is
 * published only when a staff member who did not contribute to it approves it (L-15: the
 * curator is never the sole reviewer). The second is §5.5.3: a curated change is shown,
 * never the trigger of a push. Neither flag is the client's to set.
 *
 * **A correction is a revision, never a deletion** (§5.5). Once a statement is published
 * the only way to change it is {@link openCorrection}: version N+1 of the same entry, typed
 * `curated_correction`, naming the version it corrects and saying what is now known. The
 * published history (`listPublished`) is then the original and its correction, in order —
 * the struck-through original and the correction above it are both still there to render.
 *
 * **The rules are the shared validator's.** The form runs the same
 * `validateCuratedStatement` before it sends; this module runs it again because the form
 * is not trusted. T4 sources and missing captures are refused with their own reasons, the
 * two refusals §5.10 names.
 *
 * **Not here:** applying the state to the event (the reversion on a correction must not
 * manufacture a `new_fire`), the public rendering, and the Bulgarian wording — all
 * founder-gated (`docs/EDITORIAL-STANDARD.md`).
 */

import {
  isCuratedStatementType,
  parseCuratedStatementDraft,
  validateCuratedStatement,
  type CuratedStatementDraft,
  type StatementIssue,
} from '@fire-watch/contracts';

import type { EpochMs } from '../ports/clock.js';
import type {
  IncidentLogStore,
  StaffActionContext,
  StoredIncidentVersion,
} from '../ports/staff-stores.js';
import {
  editEntry,
  reviewEntry,
  startEntry,
  submitEntry,
  type IncidentEntryStatus,
  type WorkflowRefusal,
} from './incident-log-workflow.js';
import { staffMay, type StaffPrincipal } from './staff-policy.js';

/** The flags every curated version carries: two-person review, never a push (§5.5.3). */
export const CURATED_STATEMENT_FLAGS = { triggersNotifications: false, major: true } as const;

/** The marker that tells a curated statement's content from any other incident-log entry. */
export const CURATED_STATEMENT_KIND = 'curated_statement';

/** What the version row's `content` holds. */
export interface CuratedStatementContent {
  readonly kind: typeof CURATED_STATEMENT_KIND;
  readonly statement: CuratedStatementDraft;
  /** The published version a correction corrects; null for an original statement. */
  readonly corrects: number | null;
}

export interface CuratedStatementVersion {
  readonly entryId: string;
  readonly version: number;
  readonly status: IncidentEntryStatus;
  readonly editSeq: number;
  /** In first-touch order; the first is the curator. Never in the content (personal data). */
  readonly contributorIds: readonly string[];
  readonly statement: CuratedStatementDraft;
  readonly corrects: number | null;
  readonly updatedAt: EpochMs;
  readonly publishedAt: EpochMs | null;
}

export type CurationRefusal =
  | 'not_permitted'
  | 'invalid'
  | 'source_unverified'
  | 'capture_missing'
  | 'not_found'
  | 'wrong_status'
  | 'self_review'
  | 'conflict';

export type CurationResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | {
      readonly kind: 'refused';
      readonly reason: CurationRefusal;
      /** The validator's findings, for `invalid`, `source_unverified` and `capture_missing`. */
      readonly issues?: readonly StatementIssue[];
    };

export interface CurationDeps {
  readonly log: IncidentLogStore;
  /** A fresh entry id (`crypto.randomUUID` in production). */
  readonly newId: () => string;
}

/** The version a reviewer approves: the exact row they read, or the approval is refused. */
export interface ExpectedVersion {
  readonly version: number;
  readonly editSeq: number;
}

export async function createStatement(
  deps: CurationDeps,
  curator: StaffPrincipal,
  statement: CuratedStatementDraft,
  context: StaffActionContext,
): Promise<CurationResult<CuratedStatementVersion>> {
  if (statement.statementType === 'curated_correction') {
    // A correction exists only as a revision of a published statement.
    return { kind: 'refused', reason: 'invalid', issues: ['statement_type_invalid'] };
  }
  const invalid = refusalFor(statement, context.at);
  if (invalid !== null) return invalid;
  const entryId = deps.newId();
  const decision = startEntry(entryId, curator, CURATED_STATEMENT_FLAGS);
  if (decision.kind === 'refused') return fromWorkflow(decision.reason);
  const content: CuratedStatementContent = {
    kind: CURATED_STATEMENT_KIND,
    statement,
    corrects: null,
  };
  const written = await deps.log.write({
    expected: null,
    next: decision.next,
    content: { ...content },
    action: 'incident.draft',
    context,
  });
  if (written.kind === 'conflict') return { kind: 'refused', reason: 'conflict' };
  return readBack(deps, entryId);
}

/**
 * Edit an unpublished version (a draft, or one in review, which goes back to draft so the
 * approval covers the text that goes live). A published statement is never edited: that
 * is {@link openCorrection}.
 */
export async function editStatement(
  deps: CurationDeps,
  editor: StaffPrincipal,
  entryId: string,
  expected: ExpectedVersion,
  statement: CuratedStatementDraft,
  context: StaffActionContext,
): Promise<CurationResult<CuratedStatementVersion>> {
  if (!staffMay(editor, 'incident.draft')) return { kind: 'refused', reason: 'not_permitted' };
  const current = await findStatement(deps, entryId);
  if (current === null) return { kind: 'refused', reason: 'not_found' };
  if (current.status === 'published') return { kind: 'refused', reason: 'wrong_status' };
  if (!matches(current, expected)) return { kind: 'refused', reason: 'conflict' };
  const kindChanged =
    (current.corrects === null) !== (statement.statementType !== 'curated_correction');
  if (kindChanged) {
    // An original stays an original and a correction a correction across edits.
    return { kind: 'refused', reason: 'invalid', issues: ['statement_type_invalid'] };
  }
  const invalid = refusalFor(statement, context.at);
  if (invalid !== null) return invalid;
  const decision = editEntry(asWorkflowVersion(current), editor, CURATED_STATEMENT_FLAGS);
  if (decision.kind === 'refused') return fromWorkflow(decision.reason);
  const content: CuratedStatementContent = {
    kind: CURATED_STATEMENT_KIND,
    statement,
    corrects: current.corrects,
  };
  return writeAndReadBack(deps, current, decision.next, { ...content }, 'incident.edit', context);
}

/** Send a draft to its second review (the flags make review always required). */
export async function submitStatement(
  deps: CurationDeps,
  submitter: StaffPrincipal,
  entryId: string,
  context: StaffActionContext,
): Promise<CurationResult<CuratedStatementVersion>> {
  if (!staffMay(submitter, 'incident.publish')) return { kind: 'refused', reason: 'not_permitted' };
  const current = await findStatement(deps, entryId);
  if (current === null) return { kind: 'refused', reason: 'not_found' };
  // Re-checked at submission: a rule may have tightened since the draft was saved.
  const invalid = refusalFor(current.statement, context.at);
  if (invalid !== null) return invalid;
  const decision = submitEntry(asWorkflowVersion(current), submitter);
  if (decision.kind === 'refused') return fromWorkflow(decision.reason);
  return writeAndReadBack(deps, current, decision.next, undefined, 'incident.submit', context);
}

/**
 * The second person: approve publishes, reject returns the version to its authors. The
 * reviewer must not have contributed to the version, and approves the exact row they read.
 */
export async function reviewStatement(
  deps: CurationDeps,
  reviewer: StaffPrincipal,
  entryId: string,
  expected: ExpectedVersion,
  verdict: 'approve' | 'reject',
  context: StaffActionContext,
): Promise<CurationResult<CuratedStatementVersion>> {
  if (!staffMay(reviewer, 'incident.review')) return { kind: 'refused', reason: 'not_permitted' };
  const current = await findStatement(deps, entryId);
  if (current === null) return { kind: 'refused', reason: 'not_found' };
  if (!matches(current, expected)) return { kind: 'refused', reason: 'conflict' };
  const decision = reviewEntry(asWorkflowVersion(current), reviewer, verdict);
  if (decision.kind === 'refused') return fromWorkflow(decision.reason);
  return writeAndReadBack(
    deps,
    current,
    decision.next,
    undefined,
    verdict === 'approve' ? 'incident.publish' : 'incident.reject',
    context,
  );
}

/**
 * Open a correction of the published statement (§5.5): version N+1 of the same entry, typed
 * `curated_correction`, about the same event. It goes through the same two-person review.
 */
export async function openCorrection(
  deps: CurationDeps,
  editor: StaffPrincipal,
  entryId: string,
  correction: CuratedStatementDraft,
  context: StaffActionContext,
): Promise<CurationResult<CuratedStatementVersion>> {
  if (!staffMay(editor, 'incident.draft')) return { kind: 'refused', reason: 'not_permitted' };
  const current = await findStatement(deps, entryId);
  if (current === null) return { kind: 'refused', reason: 'not_found' };
  if (current.status !== 'published') return { kind: 'refused', reason: 'wrong_status' };
  if (correction.statementType !== 'curated_correction') {
    return { kind: 'refused', reason: 'invalid', issues: ['statement_type_invalid'] };
  }
  if (correction.eventId !== current.statement.eventId) {
    return { kind: 'refused', reason: 'invalid', issues: ['event_id_invalid'] };
  }
  const invalid = refusalFor(correction, context.at);
  if (invalid !== null) return invalid;
  const decision = editEntry(asWorkflowVersion(current), editor, CURATED_STATEMENT_FLAGS);
  if (decision.kind === 'refused') return fromWorkflow(decision.reason);
  const content: CuratedStatementContent = {
    kind: CURATED_STATEMENT_KIND,
    statement: correction,
    corrects: current.version,
  };
  return writeAndReadBack(deps, current, decision.next, { ...content }, 'incident.edit', context);
}

/** The newest version, for staff who may draft or review. */
export async function readStatement(
  deps: CurationDeps,
  reader: StaffPrincipal,
  entryId: string,
): Promise<CurationResult<CuratedStatementVersion>> {
  if (!staffMay(reader, 'incident.draft') && !staffMay(reader, 'incident.review')) {
    return { kind: 'refused', reason: 'not_permitted' };
  }
  const current = await findStatement(deps, entryId);
  return current === null
    ? { kind: 'refused', reason: 'not_found' }
    : { kind: 'ok', value: current };
}

/** The published history: the statement, then each correction, oldest first. */
export async function publishedHistory(
  deps: Pick<CurationDeps, 'log'>,
  entryId: string,
): Promise<readonly CuratedStatementVersion[]> {
  const rows = await deps.log.listPublished(entryId);
  return rows.flatMap((row) => {
    const read = statementVersionOf(row);
    return read === null ? [] : [read];
  });
}

/** A stored version read as a curated statement; null for any other incident-log entry. */
export function statementVersionOf(row: StoredIncidentVersion): CuratedStatementVersion | null {
  const content = row.content;
  if (content['kind'] !== CURATED_STATEMENT_KIND) return null;
  const statement = parseCuratedStatementDraft(content['statement']);
  if (statement === null || !isCuratedStatementType(statement.statementType)) return null;
  const corrects = content['corrects'];
  if (corrects !== null && (typeof corrects !== 'number' || !Number.isInteger(corrects))) {
    return null;
  }
  return {
    entryId: row.version.entryId,
    version: row.version.version,
    status: row.version.status,
    editSeq: row.editSeq,
    contributorIds: row.version.contributorIds,
    statement,
    corrects,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
  };
}

// ── internals ────────────────────────────────────────────────────────────────────────

async function findStatement(
  deps: Pick<CurationDeps, 'log'>,
  entryId: string,
): Promise<CuratedStatementVersion | null> {
  const row = await deps.log.findLatest(entryId);
  return row === null ? null : statementVersionOf(row);
}

async function readBack(
  deps: Pick<CurationDeps, 'log'>,
  entryId: string,
): Promise<CurationResult<CuratedStatementVersion>> {
  const stored = await findStatement(deps, entryId);
  // Written a moment ago in this request; absent only if something deleted it, which
  // nothing does (026: versions are never deleted).
  return stored === null ? { kind: 'refused', reason: 'conflict' } : { kind: 'ok', value: stored };
}

async function writeAndReadBack(
  deps: CurationDeps,
  current: CuratedStatementVersion,
  next: Parameters<IncidentLogStore['write']>[0]['next'],
  content: Readonly<Record<string, unknown>> | undefined,
  action: Parameters<IncidentLogStore['write']>[0]['action'],
  context: StaffActionContext,
): Promise<CurationResult<CuratedStatementVersion>> {
  const written = await deps.log.write({
    expected: { version: current.version, status: current.status, editSeq: current.editSeq },
    next,
    ...(content === undefined ? {} : { content }),
    action,
    context,
  });
  if (written.kind === 'conflict') return { kind: 'refused', reason: 'conflict' };
  return readBack(deps, current.entryId);
}

function asWorkflowVersion(current: CuratedStatementVersion) {
  return {
    entryId: current.entryId,
    version: current.version,
    status: current.status,
    contributorIds: current.contributorIds,
    ...CURATED_STATEMENT_FLAGS,
  };
}

function matches(current: CuratedStatementVersion, expected: ExpectedVersion): boolean {
  return current.version === expected.version && current.editSeq === expected.editSeq;
}

/** The validator's verdict as a refusal; the two §5.10 refusals keep their own reason. */
function refusalFor(statement: CuratedStatementDraft, at: EpochMs): CurationResult<never> | null {
  const issues = validateCuratedStatement(statement, new Date(at));
  if (issues.length === 0) return null;
  const reason: CurationRefusal =
    issues.includes('source_unverified') || issues.includes('second_source_unverified')
      ? 'source_unverified'
      : issues.includes('capture_missing') || issues.includes('second_source_capture_missing')
        ? 'capture_missing'
        : 'invalid';
  return { kind: 'refused', reason, issues };
}

function fromWorkflow(reason: WorkflowRefusal): CurationResult<never> {
  switch (reason) {
    case 'not_permitted':
      return { kind: 'refused', reason: 'not_permitted' };
    case 'reviewer_is_contributor':
      return { kind: 'refused', reason: 'self_review' };
    case 'wrong_status':
    case 'review_not_required':
      return { kind: 'refused', reason: 'wrong_status' };
  }
}
