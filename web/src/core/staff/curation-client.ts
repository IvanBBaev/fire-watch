/**
 * The WP6 admin/approval form's client (TASKS L15; review 16 §5.10): the six calls of
 * `/api/v1/staff/curated-statements` (`server/src/adapters/http/staff-curation-route.ts`).
 *
 * Same request shape as the sign-in client (`core/auth/sign-in.ts`): same-origin, the
 * staff session cookie included, nothing cached, `strict-origin` referrer so the Origin
 * check passes. Refusals are told apart by the problem `code`, never the title.
 *
 * **The routes are not served anywhere yet** (the staff host and its cookie are an owner
 * decision), so "absent" is a first-class outcome: a 404 or 405 that carries no
 * statement code means the staff plane is not on this origin, and the form says so.
 *
 * Framework-free and I/O-free but for the injected `fetch` (ADR-005 D1).
 */

import {
  isProblemCode,
  PROBLEM_CODE_MEMBER,
  type CuratedStatementDraft,
  type ProblemCode,
} from '@fire-watch/contracts';

export const STAFF_CURATION_URL = '/api/v1/staff/curated-statements';

export type StatementStatus = 'draft' | 'in_review' | 'published';

/** One version as the staff routes return it (`wireOf`). */
export interface StaffStatementVersion {
  readonly entryId: string;
  readonly version: number;
  readonly status: StatementStatus;
  readonly editSeq: number;
  readonly corrects: number | null;
  readonly statement: CuratedStatementDraft;
  readonly contributorIds: readonly string[];
  /** The asker wrote this version: they may not approve it. */
  readonly youContributed: boolean;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

/** Why the server refused; each is one line on the form. */
export const CURATION_REFUSAL_KINDS = [
  'not-signed-in',
  'forbidden',
  'invalid',
  'source-unverified',
  'capture-missing',
  'not-found',
  'wrong-status',
  'self-review',
  'conflict',
] as const;
export type CurationRefusalKind = (typeof CURATION_REFUSAL_KINDS)[number];

export type CurationOutcome =
  | { readonly kind: 'ok'; readonly value: StaffStatementVersion }
  | { readonly kind: 'refused'; readonly reason: CurationRefusalKind }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

export interface CurationClient {
  create(statement: CuratedStatementDraft): Promise<CurationOutcome>;
  read(entryId: string): Promise<CurationOutcome>;
  edit(current: StaffStatementVersion, statement: CuratedStatementDraft): Promise<CurationOutcome>;
  submit(entryId: string): Promise<CurationOutcome>;
  review(current: StaffStatementVersion, verdict: 'approve' | 'reject'): Promise<CurationOutcome>;
  correct(entryId: string, statement: CuratedStatementDraft): Promise<CurationOutcome>;
}

/** The codes these routes emit, read for the form. Others fall back to the status. */
const REFUSAL_BY_CODE: Partial<Readonly<Record<ProblemCode, CurationRefusalKind>>> = {
  not_signed_in: 'not-signed-in',
  staff_forbidden: 'forbidden',
  statement_invalid: 'invalid',
  statement_source_unverified: 'source-unverified',
  statement_capture_missing: 'capture-missing',
  statement_not_found: 'not-found',
  statement_wrong_status: 'wrong-status',
  statement_self_review: 'self-review',
  statement_conflict: 'conflict',
};

function request(method: 'GET' | 'POST' | 'PUT', body?: unknown): RequestInit {
  return {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'strict-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      accept: 'application/json, application/problem+json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function codeOf(response: Response): Promise<ProblemCode | null> {
  if (!(response.headers.get('content-type') ?? '').includes('json')) return null;
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const code = (body as Record<string, unknown>)[PROBLEM_CODE_MEMBER];
    return isProblemCode(code) ? code : null;
  } catch {
    return null;
  }
}

function versionOf(body: unknown): StaffStatementVersion | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const status = b['status'];
  if (
    typeof b['entry_id'] !== 'string' ||
    typeof b['version'] !== 'number' ||
    typeof b['edit_seq'] !== 'number' ||
    (status !== 'draft' && status !== 'in_review' && status !== 'published') ||
    typeof b['statement'] !== 'object' ||
    b['statement'] === null
  ) {
    return null;
  }
  const corrects = b['corrects'];
  const contributors = b['contributor_ids'];
  const publishedAt = b['published_at'];
  return {
    entryId: b['entry_id'],
    version: b['version'],
    status,
    editSeq: b['edit_seq'],
    corrects: typeof corrects === 'number' ? corrects : null,
    statement: b['statement'] as CuratedStatementDraft,
    contributorIds: Array.isArray(contributors)
      ? contributors.filter((c): c is string => typeof c === 'string')
      : [],
    youContributed: b['you_contributed'] === true,
    updatedAt: typeof b['updated_at'] === 'string' ? b['updated_at'] : '',
    publishedAt: typeof publishedAt === 'string' ? publishedAt : null,
  };
}

/** Map one answer to the form's outcome. Exported for tests. */
export async function curationOutcomeOf(response: Response): Promise<CurationOutcome> {
  if (response.ok) {
    try {
      const value = versionOf(await response.json());
      return value === null ? { kind: 'failed' } : { kind: 'ok', value };
    } catch {
      return { kind: 'failed' };
    }
  }
  const code = await codeOf(response);
  const reason = code === null ? undefined : REFUSAL_BY_CODE[code];
  if (reason !== undefined) return { kind: 'refused', reason };
  // A 404/405 with no statement code: the staff routes are not on this origin.
  if (response.status === 404 || response.status === 405) return { kind: 'unavailable' };
  if (response.status === 401) return { kind: 'refused', reason: 'not-signed-in' };
  if (response.status === 403 && code === null) return { kind: 'refused', reason: 'forbidden' };
  return { kind: 'failed' };
}

export function createCurationClient(deps: { readonly fetchFn: typeof fetch }): CurationClient {
  const call = async (path: string, init: RequestInit): Promise<CurationOutcome> => {
    try {
      return await curationOutcomeOf(await deps.fetchFn(`${STAFF_CURATION_URL}${path}`, init));
    } catch {
      return { kind: 'failed' };
    }
  };
  const id = (entryId: string) => `/${encodeURIComponent(entryId)}`;
  return {
    create: (statement) => call('', request('POST', statement)),
    read: (entryId) => call(id(entryId), request('GET')),
    edit: (current, statement) =>
      call(
        id(current.entryId),
        request('PUT', { statement, version: current.version, edit_seq: current.editSeq }),
      ),
    submit: (entryId) => call(`${id(entryId)}/submit`, request('POST', {})),
    review: (current, verdict) =>
      call(
        `${id(current.entryId)}/review`,
        request('POST', { verdict, version: current.version, edit_seq: current.editSeq }),
      ),
    correct: (entryId, statement) => call(`${id(entryId)}/corrections`, request('POST', statement)),
  };
}
