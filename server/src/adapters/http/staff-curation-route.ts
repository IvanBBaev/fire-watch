/**
 * `/api/v1/staff/curated-statements` — the WP6 admin/approval form's server side (TASKS
 * L15; review 16 §5.10; GATES.md §3 L-15).
 *
 *   * `POST /`                     — a curator saves a new statement as a draft.
 *   * `GET /:id`                   — the newest version, for the form and its reviewer.
 *   * `PUT /:id`                   — edit an unpublished version (`{statement, version, edit_seq}`).
 *   * `POST /:id/submit`           — send the draft to its second review.
 *   * `POST /:id/review`           — `{verdict, version, edit_seq}`: approve publishes,
 *                                    reject returns it to its authors.
 *   * `POST /:id/corrections`      — open a `curated_correction` of the published statement.
 *
 * The decisions are `core/staff/curated-statement-workflow.ts`'s; this module maps them to
 * HTTP. The capture is in every answer here because these answers go to staff only — the
 * reviewer has to see the evidence to approve it. The public view (`publicViewOf`) never
 * carries it.
 *
 * **Who is asking is a port.** `authenticate` turns the request's cookie header into a
 * staff principal, or null. Production wires {@link staffSessionAuthenticator} over the
 * staff session store (migration 029); the routes are tested with a fake. They are not
 * registered in `api.ts` yet: the staff cookie's name and the host it is scoped to (a
 * staff subdomain or a path on the public one) are undecided, and staff primary sign-in
 * needs a mailer that does not exist. Neither is invented here.
 *
 * A principal whose session has not passed its second factor authenticates but may do
 * nothing (`staffMay`), so it gets `staff_forbidden`, not `not_signed_in`.
 */

import { parseCuratedStatementDraft, type CuratedStatementDraft } from '@fire-watch/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isoFromEpochMs, type Clock, type EpochMs } from '../../core/ports/clock.js';
import type { IncidentLogStore } from '../../core/ports/staff-stores.js';
import {
  createStatement,
  editStatement,
  openCorrection,
  readStatement,
  reviewStatement,
  submitStatement,
  type CurationRefusal,
  type CurationResult,
  type CuratedStatementVersion,
} from '../../core/staff/curated-statement-workflow.js';
import type { StaffPrincipal } from '../../core/staff/staff-policy.js';
import { authenticateStaffSession, type StaffSessionDeps } from '../../core/staff/staff-session.js';
import { INVALID_BODY, refuseForeignOrigin } from './auth-route.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';

export const STAFF_CURATION_PATH = '/api/v1/staff/curated-statements';

const STAFF_NOT_SIGNED_IN: CodedProblemSpec = {
  status: 401,
  title: 'Not signed in',
  detail: 'Sign in to the staff plane to curate statements.',
  code: 'not_signed_in',
};

const STAFF_FORBIDDEN: CodedProblemSpec = {
  status: 403,
  title: 'Not permitted',
  detail: 'This needs an editor whose session has passed its second factor.',
  code: 'staff_forbidden',
};

const STATEMENT_NOT_FOUND: CodedProblemSpec = {
  status: 404,
  title: 'Statement not found',
  detail: 'There is no curated statement with this id.',
  code: 'statement_not_found',
};

/** The workflow's refusals as the wire states them. Exported for the code-coverage test. */
export const CURATION_REFUSALS: Readonly<Record<CurationRefusal, CodedProblemSpec>> = {
  not_permitted: STAFF_FORBIDDEN,
  invalid: {
    status: 422,
    title: 'Statement refused',
    detail: 'The statement breaks a rule of the editorial standard; the form names which.',
    code: 'statement_invalid',
  },
  source_unverified: {
    status: 422,
    title: 'Unverified source',
    detail: 'A T4 (unverified) source is never the basis of a public statement.',
    code: 'statement_source_unverified',
  },
  capture_missing: {
    status: 422,
    title: 'Capture missing',
    detail: 'Every cited source needs its capture before the statement can be saved.',
    code: 'statement_capture_missing',
  },
  not_found: STATEMENT_NOT_FOUND,
  wrong_status: {
    status: 409,
    title: 'Not in that state',
    detail: 'The statement is not in a state that allows this step.',
    code: 'statement_wrong_status',
  },
  self_review: {
    status: 403,
    title: 'Not your review',
    detail: 'A statement is approved by someone who did not write it.',
    code: 'statement_self_review',
  },
  conflict: {
    status: 409,
    title: 'Statement changed',
    detail: 'The statement changed since it was read. Reload it and try again.',
    code: 'statement_conflict',
  },
};

/** Every refusal this module writes itself, beyond the table. For the code-coverage test. */
export const STAFF_CURATION_PROBLEMS: readonly CodedProblemSpec[] = [
  STAFF_NOT_SIGNED_IN,
  STAFF_FORBIDDEN,
  STATEMENT_NOT_FOUND,
];

/** Resolves the request's cookie header to a staff principal; null when there is none. */
export type StaffAuthenticator = (
  cookieHeader: string | undefined,
  at: EpochMs,
) => Promise<StaffPrincipal | null>;

export interface StaffCurationRouteDeps {
  readonly authenticate: StaffAuthenticator;
  readonly log: IncidentLogStore;
  readonly newId: () => string;
  readonly allowedOrigins: readonly string[];
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
}

/**
 * The production authenticator over the staff session store. `readToken` takes the staff
 * session token out of the cookie header; its cookie name is the open decision above, so
 * the caller supplies it.
 */
export function staffSessionAuthenticator(
  deps: Pick<StaffSessionDeps, 'sessions' | 'tokens'>,
  readToken: (cookieHeader: string | undefined) => string | undefined,
): StaffAuthenticator {
  return async (cookieHeader, at) => {
    const token = readToken(cookieHeader);
    if (token === undefined) return null;
    const result = await authenticateStaffSession(deps, token, at);
    return result.kind === 'authenticated' ? result.principal : null;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type IdRequest = FastifyRequest<{ Params: { id: string } }>;

export function registerStaffCurationRoutes(
  app: FastifyInstance,
  deps: StaffCurationRouteDeps,
): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (request, _reply, next) => {
      refuseForeignOrigin(request, deps.allowedOrigins);
      next();
    });

    const curation = { log: deps.log, newId: deps.newId };

    scope.post(STAFF_CURATION_PATH, async (request, reply) => {
      const { principal, at } = await requireStaff(request, deps);
      const statement = statementOf(request.body);
      const result = await createStatement(
        curation,
        principal,
        statement,
        context(principal, request, at),
      );
      return send(reply, 201, principal, result);
    });

    scope.get(`${STAFF_CURATION_PATH}/:id`, async (request: IdRequest, reply) => {
      const { principal } = await requireStaff(request, deps);
      const result = await readStatement(curation, principal, entryIdOf(request));
      return send(reply, 200, principal, result);
    });

    scope.put(`${STAFF_CURATION_PATH}/:id`, async (request: IdRequest, reply) => {
      const { principal, at } = await requireStaff(request, deps);
      const body = objectOf(request.body);
      const result = await editStatement(
        curation,
        principal,
        entryIdOf(request),
        expectedOf(body),
        statementOf(body['statement']),
        context(principal, request, at),
      );
      return send(reply, 200, principal, result);
    });

    scope.post(`${STAFF_CURATION_PATH}/:id/submit`, async (request: IdRequest, reply) => {
      const { principal, at } = await requireStaff(request, deps);
      const result = await submitStatement(
        curation,
        principal,
        entryIdOf(request),
        context(principal, request, at),
      );
      return send(reply, 200, principal, result);
    });

    scope.post(`${STAFF_CURATION_PATH}/:id/review`, async (request: IdRequest, reply) => {
      const { principal, at } = await requireStaff(request, deps);
      const body = objectOf(request.body);
      const verdict = body['verdict'];
      if (verdict !== 'approve' && verdict !== 'reject') throw new ProblemError(INVALID_BODY);
      const result = await reviewStatement(
        curation,
        principal,
        entryIdOf(request),
        expectedOf(body),
        verdict,
        context(principal, request, at),
      );
      return send(reply, 200, principal, result);
    });

    scope.post(`${STAFF_CURATION_PATH}/:id/corrections`, async (request: IdRequest, reply) => {
      const { principal, at } = await requireStaff(request, deps);
      const result = await openCorrection(
        curation,
        principal,
        entryIdOf(request),
        statementOf(request.body),
        context(principal, request, at),
      );
      return send(reply, 201, principal, result);
    });

    done();
  });
}

async function requireStaff(
  request: FastifyRequest,
  deps: Pick<StaffCurationRouteDeps, 'authenticate' | 'clock'>,
): Promise<{ readonly principal: StaffPrincipal; readonly at: EpochMs }> {
  const at = deps.clock.now();
  const principal = await deps.authenticate(request.headers.cookie, at);
  if (principal === null) throw new ProblemError(STAFF_NOT_SIGNED_IN);
  return { principal, at };
}

function context(principal: StaffPrincipal, request: FastifyRequest, at: EpochMs) {
  return { actorId: principal.staffId, ip: request.ip, at };
}

function entryIdOf(request: IdRequest): string {
  const id = request.params.id;
  // Entry ids are uuids (026); anything else names no statement.
  if (!UUID.test(id)) throw new ProblemError(STATEMENT_NOT_FOUND);
  return id;
}

function objectOf(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProblemError(INVALID_BODY);
  }
  return body as Record<string, unknown>;
}

function statementOf(body: unknown): CuratedStatementDraft {
  const statement = parseCuratedStatementDraft(body);
  if (statement === null) throw new ProblemError(INVALID_BODY);
  return statement;
}

function expectedOf(body: Record<string, unknown>): { version: number; editSeq: number } {
  const version = body['version'];
  const editSeq = body['edit_seq'];
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    typeof editSeq !== 'number' ||
    !Number.isInteger(editSeq)
  ) {
    throw new ProblemError(INVALID_BODY);
  }
  return { version, editSeq };
}

function send(
  reply: FastifyReply,
  status: number,
  principal: StaffPrincipal,
  result: CurationResult<CuratedStatementVersion>,
): FastifyReply {
  if (result.kind === 'refused') throw new ProblemError(CURATION_REFUSALS[result.reason]);
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .send(wireOf(result.value, principal));
}

/** The staff view of a version. Staff ids stay ids; names are the member store's. */
export function wireOf(value: CuratedStatementVersion, principal: StaffPrincipal) {
  return {
    entry_id: value.entryId,
    version: value.version,
    status: value.status,
    edit_seq: value.editSeq,
    corrects: value.corrects,
    statement: value.statement,
    contributor_ids: value.contributorIds,
    /** Whether the asker wrote this version — the form hides "approve" when true. */
    you_contributed: value.contributorIds.includes(principal.staffId),
    updated_at: isoFromEpochMs(value.updatedAt),
    published_at: value.publishedAt === null ? null : isoFromEpochMs(value.publishedAt),
  };
}
