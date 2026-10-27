/**
 * `/api/v1/staff/members/:staffId` — second-factor removal and member changes on the staff
 * plane (TASKS I1; 05 §5.4.3; docs/runbooks/06-staff-offboarding.md).
 *
 *   * `DELETE /:staffId/webauthn/:credentialId` — remove a passkey (base64url id).
 *   * `DELETE /:staffId/totp`                   — remove the TOTP factor.
 *   * `POST /:staffId/disable`                  — disable a member, ending their sessions.
 *   * `POST /:staffId/offboard`                 — runbook 06 §3: take everything away.
 *   * `POST /:staffId/readmit`                  — `{roles}`: runbook 06 §3.3.
 *   * `PUT /:staffId/roles`                     — `{roles}`: replace the role set.
 *
 * Who may do what is `staff-session-policy.ts`'s (`decideCredentialRemoval`,
 * `decideMemberChange`): a member removes their own factors, an admin past their second
 * factor everything, and nobody changes their own membership. The store re-checks what
 * only it can (the last second factor). Who is asking comes from the same
 * {@link StaffAuthenticator} port as the curation routes, so these routes are registered
 * with them once the staff cookie and host are decided.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Clock } from '../../core/ports/clock.js';
import type { StaffStore } from '../../core/ports/staff-stores.js';
import { isStaffRole, type StaffPrincipal, type StaffRole } from '../../core/staff/staff-policy.js';
import {
  disableStaffMember,
  offboardStaffMember,
  readmitStaffMember,
  removeStaffTotpFactor,
  removeWebAuthnCredential,
  setStaffRoles,
  type StaffChangeResult,
  type StaffRequestContext,
} from '../../core/staff/staff-session.js';
import { INVALID_BODY, refuseForeignOrigin } from './auth-route.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';
import type { StaffAuthenticator } from './staff-curation-route.js';
import { STAFF_NOT_SIGNED_IN } from './staff-session-route.js';

export const STAFF_MEMBERS_PATH = '/api/v1/staff/members';

type Refused = Extract<StaffChangeResult<never>, { kind: 'refused' }>;
type Refusal = Refused['reason'];

const FORBIDDEN: CodedProblemSpec = {
  status: 403,
  title: 'Not permitted',
  detail: 'This needs the member themselves or an admin, past their second factor.',
  code: 'staff_forbidden',
};

const MEMBER_NOT_FOUND: CodedProblemSpec = {
  status: 404,
  title: 'Member not found',
  detail: 'There is no live staff member with this id.',
  code: 'staff_member_not_found',
};

const FACTOR_NOT_FOUND: CodedProblemSpec = {
  status: 404,
  title: 'Factor not found',
  detail: 'The member holds no such second factor.',
  code: 'staff_factor_not_found',
};

/** The refusals shared by every route here; `not_found` is per route. */
const REFUSALS: Readonly<Record<Exclude<Refusal, 'not_found'>, CodedProblemSpec>> = {
  second_factor_missing: FORBIDDEN,
  not_permitted: FORBIDDEN,
  self_change: {
    status: 403,
    title: 'Not on yourself',
    detail: 'A second admin changes or off-boards your own membership.',
    code: 'staff_self_change',
  },
  last_second_factor: {
    status: 409,
    title: 'Last second factor',
    detail: 'Enroll another second factor before removing this one.',
    code: 'staff_last_second_factor',
  },
  already_live: {
    status: 409,
    title: 'Member is live',
    detail: 'Only an off-boarded member is re-admitted.',
    code: 'staff_member_live',
  },
  not_offboarded: {
    status: 409,
    title: 'Not off-boarded',
    detail: 'Off-board the member first, so no old factor comes back.',
    code: 'staff_member_not_offboarded',
  },
};

/** Every refusal this module writes. For the code-coverage test. */
export const STAFF_MEMBERS_PROBLEMS: readonly CodedProblemSpec[] = [
  STAFF_NOT_SIGNED_IN,
  MEMBER_NOT_FOUND,
  FACTOR_NOT_FOUND,
  ...Object.values(REFUSALS),
];

export interface StaffMembersRouteDeps {
  readonly authenticate: StaffAuthenticator;
  readonly staff: StaffStore;
  readonly allowedOrigins: readonly string[];
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]{1,1366}$/;

type MemberRequest = FastifyRequest<{ Params: { staffId: string } }>;
type CredentialRequest = FastifyRequest<{ Params: { staffId: string; credentialId: string } }>;

export function registerStaffMembersRoutes(
  app: FastifyInstance,
  deps: StaffMembersRouteDeps,
): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (request, reply, next) => {
      refuseForeignOrigin(request, deps.allowedOrigins);
      reply.header('cache-control', 'no-store');
      next();
    });

    const member = `${STAFF_MEMBERS_PATH}/:staffId`;

    scope.delete(`${member}/webauthn/:credentialId`, async (request: CredentialRequest, reply) => {
      const staffId = staffIdOf(request, FACTOR_NOT_FOUND);
      const encoded = request.params.credentialId;
      if (!B64URL.test(encoded)) throw new ProblemError(FACTOR_NOT_FOUND);
      const credentialId = new Uint8Array(Buffer.from(encoded, 'base64url'));
      const { actor, context } = await requireStaff(request, deps);
      const result = await removeWebAuthnCredential(
        deps,
        actor,
        { staffId, credentialId },
        context,
      );
      return send(reply, result, FACTOR_NOT_FOUND, (done) => ({
        sessions_revoked: done.sessionsRevoked,
      }));
    });

    scope.delete(`${member}/totp`, async (request: MemberRequest, reply) => {
      const staffId = staffIdOf(request, FACTOR_NOT_FOUND);
      const { actor, context } = await requireStaff(request, deps);
      const result = await removeStaffTotpFactor(deps, actor, { staffId }, context);
      return send(reply, result, FACTOR_NOT_FOUND, (done) => ({
        sessions_revoked: done.sessionsRevoked,
      }));
    });

    scope.post(`${member}/disable`, async (request: MemberRequest, reply) => {
      const staffId = staffIdOf(request, MEMBER_NOT_FOUND);
      const { actor, context } = await requireStaff(request, deps);
      const result = await disableStaffMember(deps, actor, staffId, context);
      return send(reply, result, MEMBER_NOT_FOUND, (done) => ({
        sessions_revoked: done.sessionsRevoked,
      }));
    });

    scope.post(`${member}/offboard`, async (request: MemberRequest, reply) => {
      const staffId = staffIdOf(request, MEMBER_NOT_FOUND);
      const { actor, context } = await requireStaff(request, deps);
      const result = await offboardStaffMember(deps, actor, staffId, context);
      return send(reply, result, MEMBER_NOT_FOUND, (done) =>
        done.kind === 'already_offboarded'
          ? { offboarded: false }
          : {
              offboarded: true,
              was_live: done.wasLive,
              sessions_revoked: done.sessionsRevoked,
              webauthn_removed: done.webauthnRemoved,
              totp_removed: done.totpRemoved,
              recovery_codes_removed: done.recoveryCodesRemoved,
              roles_removed: done.rolesRemoved,
            },
      );
    });

    scope.post(`${member}/readmit`, async (request: MemberRequest, reply) => {
      const staffId = staffIdOf(request, MEMBER_NOT_FOUND);
      const roles = rolesOf(request.body);
      const { actor, context } = await requireStaff(request, deps);
      const result = await readmitStaffMember(deps, actor, { staffId, roles }, context);
      return send(reply, result, MEMBER_NOT_FOUND, () => ({ readmitted: true }));
    });

    scope.put(`${member}/roles`, async (request: MemberRequest, reply) => {
      const staffId = staffIdOf(request, MEMBER_NOT_FOUND);
      const roles = rolesOf(request.body);
      const { actor, context } = await requireStaff(request, deps);
      const result = await setStaffRoles(deps, actor, { staffId, roles }, context);
      return send(reply, result, MEMBER_NOT_FOUND, (done) => ({
        changed: done.kind === 'changed',
      }));
    });

    done();
  });
}

async function requireStaff(
  request: FastifyRequest,
  deps: Pick<StaffMembersRouteDeps, 'authenticate' | 'clock'>,
): Promise<{ readonly actor: StaffPrincipal; readonly context: StaffRequestContext }> {
  const at = deps.clock.now();
  const actor = await deps.authenticate(request.headers.cookie, at);
  if (actor === null) throw new ProblemError(STAFF_NOT_SIGNED_IN);
  return { actor, context: { at, ip: request.ip } };
}

/** Member ids are uuids (026); anything else names nobody. */
function staffIdOf(request: MemberRequest, notFound: CodedProblemSpec): string {
  const id = request.params.staffId;
  if (!UUID.test(id)) throw new ProblemError(notFound);
  return id;
}

/** `{roles}`: a duplicate-free list of known roles; empty is allowed (no powers). */
function rolesOf(body: unknown): readonly StaffRole[] {
  const roles =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['roles'] : null;
  if (!Array.isArray(roles) || !roles.every(isStaffRole) || new Set(roles).size !== roles.length) {
    throw new ProblemError(INVALID_BODY);
  }
  return roles;
}

function send<Done extends { readonly kind: string }>(
  reply: FastifyReply,
  result: StaffChangeResult<Done>,
  notFound: CodedProblemSpec,
  wire: (done: Done) => Record<string, unknown>,
): FastifyReply {
  if (isRefused(result)) {
    throw new ProblemError(result.reason === 'not_found' ? notFound : REFUSALS[result.reason]);
  }
  return reply.code(200).send(wire(result));
}

function isRefused<Done extends { readonly kind: string }>(
  result: StaffChangeResult<Done>,
): result is Refused {
  return result.kind === 'refused';
}
