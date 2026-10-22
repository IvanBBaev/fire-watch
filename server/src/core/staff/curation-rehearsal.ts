/**
 * The curated_correction rehearsal (TASKS L15; GATES.md §3 L-15; review 16 §5.5, §5.10).
 *
 * A scripted walk through the life of one curated statement with two staff members,
 * asserting each step's outcome. A curator drafts an "officially extinguished" statement,
 * submits it, cannot approve it themself, and a second member publishes it; the fire then
 * turns out not to be out, and the statement is corrected the same way, as version 2 of the
 * same entry. Along the way it checks the two refusals §5.10 names (a T4 source, a missing
 * capture) and that a published statement cannot be edited in place.
 *
 * It runs over the `IncidentLogStore` port, so the same script runs against the in-memory
 * store (`pnpm curation-rehearsal`, unit tests) and against Postgres (the staff-plane
 * integration test). The staging rehearsal with real people (GATES L-17) is not this; this
 * is the machinery that one will exercise.
 *
 * The data is synthetic: the URLs are on the reserved `.invalid` domain and name no real
 * authority, and nothing here is ever published anywhere.
 */

import type { CuratedStatementDraft, StatementIssue } from '@fire-watch/contracts';

import type { EpochMs } from '../ports/clock.js';
import {
  createStatement,
  editStatement,
  openCorrection,
  publishedHistory,
  reviewStatement,
  submitStatement,
  type CurationDeps,
  type CurationRefusal,
  type CurationResult,
  type CuratedStatementVersion,
} from './curated-statement-workflow.js';
import type { StaffPrincipal } from './staff-policy.js';

export const REHEARSAL_EVENT_ID = 'rehearsal-event-0001';

const STATED_AT = '2026-08-01T09:30:00Z';

/** The statement the rehearsal publishes: two independent sources, both captured. */
export const REHEARSAL_STATEMENT: CuratedStatementDraft = {
  eventId: REHEARSAL_EVENT_ID,
  statementType: 'officially_extinguished',
  source: {
    tier: 'T1',
    url: 'https://authority.rehearsal.invalid/bulletins/2026-08-01',
    capture: 'rehearsal/captures/bulletin-2026-08-01.pdf',
  },
  statedAt: STATED_AT,
  secondSource: {
    tier: 'T2',
    url: 'https://regional.rehearsal.invalid/posts/4711',
    capture: 'rehearsal/captures/regional-post-4711.png',
  },
  exception: null,
  justification: 'Bulletin and the regional directorate post both declare the fire extinguished.',
  correctionText: null,
};

/** The correction: our own, so the second source is not required (§5.3 exception 3). */
export const REHEARSAL_CORRECTION: CuratedStatementDraft = {
  eventId: REHEARSAL_EVENT_ID,
  statementType: 'curated_correction',
  source: {
    tier: 'T1',
    url: 'https://authority.rehearsal.invalid/bulletins/2026-08-02',
    capture: 'rehearsal/captures/bulletin-2026-08-02.pdf',
  },
  statedAt: '2026-08-02T07:00:00Z',
  secondSource: null,
  exception: 'own_correction',
  justification: 'The next bulletin reports the fire active again; the earlier state was wrong.',
  correctionText: 'the fire re-ignited on 2 August and is active.',
};

export interface RehearsalStep {
  readonly step: string;
  readonly expected: string;
  readonly outcome: string;
  readonly passed: boolean;
}

export interface RehearsalReport {
  readonly passed: boolean;
  readonly entryId: string | null;
  readonly steps: readonly RehearsalStep[];
  /** The published history at the end: the statement, then its correction. */
  readonly history: readonly CuratedStatementVersion[];
}

export interface RehearsalInput {
  readonly curator: StaffPrincipal;
  readonly reviewer: StaffPrincipal;
  /** The first step's time; each later step is one minute on. */
  readonly startAt: EpochMs;
}

const MINUTE = 60_000;

export async function runCurationRehearsal(
  deps: CurationDeps,
  input: RehearsalInput,
): Promise<RehearsalReport> {
  const steps: RehearsalStep[] = [];
  let tick = 0;
  const as = (who: StaffPrincipal) => ({
    actorId: who.staffId,
    at: input.startAt + tick++ * MINUTE,
  });
  const record = <T>(
    step: string,
    expected: 'ok' | CurationRefusal,
    result: CurationResult<T>,
    extra?: (value: T) => string | null,
  ): T | null => {
    const outcome = result.kind === 'ok' ? 'ok' : result.reason;
    let passed = outcome === expected;
    let note = outcome;
    if (passed && result.kind === 'ok' && extra !== undefined) {
      const problem = extra(result.value);
      if (problem !== null) {
        passed = false;
        note = `ok, but ${problem}`;
      }
    }
    if (result.kind === 'refused' && result.issues !== undefined && result.issues.length > 0) {
      note = `${note} (${result.issues.join(', ')})`;
    }
    steps.push({ step, expected, outcome: note, passed });
    return result.kind === 'ok' ? result.value : null;
  };
  const statusIs =
    (status: CuratedStatementVersion['status'], version: number) =>
    (value: CuratedStatementVersion): string | null =>
      value.status === status && value.version === version
        ? null
        : `version ${String(value.version)} is ${value.status}`;
  const refusedWith =
    (issue: StatementIssue) =>
    (result: CurationResult<CuratedStatementVersion>): CurationResult<CuratedStatementVersion> =>
      result.kind === 'refused' && !(result.issues ?? []).includes(issue)
        ? { kind: 'refused', reason: 'invalid' }
        : result;

  const { curator, reviewer } = input;

  // §5.10 refusal 1: a T4 source is never the basis of a public statement.
  record(
    'curator cites an unverified (T4) source',
    'source_unverified',
    refusedWith('source_unverified')(
      await createStatement(
        deps,
        curator,
        { ...REHEARSAL_STATEMENT, source: { ...REHEARSAL_STATEMENT.source, tier: 'T4' } },
        as(curator),
      ),
    ),
  );
  // §5.10 refusal 2: no capture, no save.
  record(
    'curator saves without a capture',
    'capture_missing',
    refusedWith('capture_missing')(
      await createStatement(
        deps,
        curator,
        { ...REHEARSAL_STATEMENT, source: { ...REHEARSAL_STATEMENT.source, capture: '' } },
        as(curator),
      ),
    ),
  );

  const draft = record(
    'curator drafts the statement',
    'ok',
    await createStatement(deps, curator, REHEARSAL_STATEMENT, as(curator)),
    statusIs('draft', 1),
  );
  if (draft === null) return finish(deps, null, steps);
  const entryId = draft.entryId;

  const submitted = record(
    'curator submits it for review',
    'ok',
    await submitStatement(deps, curator, entryId, as(curator)),
    statusIs('in_review', 1),
  );
  if (submitted === null) return finish(deps, entryId, steps);

  record(
    'curator tries to approve their own statement',
    'self_review',
    await reviewStatement(deps, curator, entryId, submitted, 'approve', as(curator)),
  );
  const published = record(
    'second member approves: published',
    'ok',
    await reviewStatement(deps, reviewer, entryId, submitted, 'approve', as(reviewer)),
    statusIs('published', 1),
  );
  if (published === null) return finish(deps, entryId, steps);

  record(
    'anyone edits the published statement in place',
    'wrong_status',
    await editStatement(
      deps,
      reviewer,
      entryId,
      published,
      { ...REHEARSAL_STATEMENT, justification: 'Silent edit.' },
      as(reviewer),
    ),
  );

  const correction = record(
    'curator opens a curated_correction',
    'ok',
    await openCorrection(deps, curator, entryId, REHEARSAL_CORRECTION, as(curator)),
    (value) =>
      statusIs('draft', 2)(value) ?? (value.corrects === 1 ? null : 'it corrects no version'),
  );
  if (correction === null) return finish(deps, entryId, steps);

  const correctionInReview = record(
    'curator submits the correction',
    'ok',
    await submitStatement(deps, curator, entryId, as(curator)),
    statusIs('in_review', 2),
  );
  if (correctionInReview === null) return finish(deps, entryId, steps);

  record(
    'curator tries to approve their own correction',
    'self_review',
    await reviewStatement(deps, curator, entryId, correctionInReview, 'approve', as(curator)),
  );
  record(
    'second member approves the correction: published',
    'ok',
    await reviewStatement(deps, reviewer, entryId, correctionInReview, 'approve', as(reviewer)),
    statusIs('published', 2),
  );

  return finish(deps, entryId, steps);
}

async function finish(
  deps: CurationDeps,
  entryId: string | null,
  steps: RehearsalStep[],
): Promise<RehearsalReport> {
  const history = entryId === null ? [] : await publishedHistory(deps, entryId);
  const shape = history.map((v) => `${String(v.version)}:${v.statement.statementType}`).join(' → ');
  const expectedShape = '1:officially_extinguished → 2:curated_correction';
  steps.push({
    step: 'the published history keeps the original beside its correction',
    expected: expectedShape,
    outcome: shape.length === 0 ? '(empty)' : shape,
    passed: shape === expectedShape && history[1]?.corrects === 1,
  });
  return {
    passed: steps.every((s) => s.passed),
    entryId,
    steps,
    history,
  };
}

/** The report as plain lines, for the CLI. */
export function rehearsalLines(report: RehearsalReport): readonly string[] {
  return [
    ...report.steps.map(
      (s) => `${s.passed ? 'PASS' : 'FAIL'}  ${s.step} — expected ${s.expected}, got ${s.outcome}`,
    ),
    report.passed ? 'Rehearsal passed.' : 'Rehearsal FAILED.',
  ];
}
