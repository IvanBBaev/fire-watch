/**
 * `/api/v1/staff/session` — the staff session's own routes: the second-factor ceremonies,
 * the first-factor enrollment, "who am I" and sign-out (TASKS I1; 05 C3, §5.4.3).
 *
 *   * `GET /`                              — the session's state, roles and expiries.
 *   * `POST /webauthn/challenge`           — `{purpose: 'authenticate' | 'register'}`.
 *   * `POST /webauthn/assertion`           — sign in with a passkey (pending session).
 *   * `POST /webauthn/registration`        — enroll a passkey (`{label}` + the response).
 *   * `POST /totp`                         — sign in with a TOTP code (pending session).
 *   * `POST /totp/enrollment`              — issue a TOTP secret (shown once).
 *   * `POST /totp/enrollment/confirm`      — `{code}`: enroll it, print recovery codes.
 *   * `POST /recovery-code`                — sign in with a recovery code.
 *   * `POST /sign-out`                     — end the session; always clears the cookie.
 *
 * The decisions are `core/staff/staff-session.ts`'s; this module maps them to HTTP. Every
 * binary member (challenge, credential id, client data, authenticator data, signature,
 * attestation object) travels as unpadded base64url, the encoding `PublicKeyCredential`'s
 * JSON form uses.
 *
 * **The cookie is a port.** Its name and the host it is scoped to (a staff subdomain or a
 * path on the public one) are undecided (TASKS I1/L15), so the caller hands in a
 * {@link StaffSessionCookie}; {@link staffSessionCookieNamed} builds one for any name with
 * the public cookie's attributes. A flow that rotates the token (every elevation) sets the
 * new cookie; a session the store no longer accepts gets `not_signed_in` and a cleared
 * cookie. Not registered in `api.ts` yet, for the same reason as the curation routes, and
 * there is no primary staff sign-in to open a session (it needs the mail sender).
 *
 * Every answer is `no-store`: recovery codes and a TOTP secret are in some of them, and a
 * session's state is never something an intermediary should replay.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isoFromEpochMs, type Clock, type EpochMs } from '../../core/ports/clock.js';
import type { StaffTotpCodes, StoredStaffSession } from '../../core/ports/staff-stores.js';
import {
  authenticateStaffSession,
  beginTotpEnrollment,
  beginWebAuthn,
  finishTotpEnrollment,
  finishWebAuthnAssertion,
  finishWebAuthnRegistration,
  signOutStaff,
  useRecoveryCode,
  useTotpCode,
  type ElevationResult,
  type RegistrationResult,
  type SecondFactorRefusal,
  type StaffSessionDeps,
} from '../../core/staff/staff-session.js';
import { STAFF_SESSION_POLICY } from '../../core/staff/staff-session-policy.js';
import { INVALID_BODY, refuseForeignOrigin, stringMember } from './auth-route.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';

export const STAFF_SESSION_PATH = '/api/v1/staff/session';

/** Reads, sets and clears the staff session cookie; its name is the caller's decision. */
export interface StaffSessionCookie {
  read(header: string | undefined): string | undefined;
  /** `Set-Cookie` for a token whose session idles out at `expiresAt`. */
  set(token: string, expiresAt: EpochMs, at: EpochMs): string;
  clear(): string;
}

const ATTRIBUTES = 'HttpOnly; Secure; SameSite=Strict; Path=/';

/**
 * A staff cookie under `name`, with the public session cookie's rules (`session-cookie.ts`:
 * first duplicate wins, Max-Age tracks the row) but `SameSite=Strict`: nothing on the staff
 * plane is reached by following a link from elsewhere. Pick a `__Host-` name and the
 * browser also refuses it a `Domain`, so a sibling host can neither read nor shadow it.
 */
export function staffSessionCookieNamed(name: string): StaffSessionCookie {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('staff cookie name is not a token');
  return {
    read(header) {
      if (header === undefined) return undefined;
      for (const pair of header.split(';')) {
        const eq = pair.indexOf('=');
        if (eq === -1 || pair.slice(0, eq).trim() !== name) continue;
        const value = pair.slice(eq + 1).trim();
        return value === '' ? undefined : value;
      }
      return undefined;
    },
    set(token, expiresAt, at) {
      const maxAge = Math.max(0, Math.floor((expiresAt - at) / 1000));
      return `${name}=${token}; ${ATTRIBUTES}; Max-Age=${maxAge}`;
    },
    clear: () => `${name}=; ${ATTRIBUTES}; Max-Age=0`,
  };
}

/** Shared with `staff-members-route.ts`. */
export const STAFF_NOT_SIGNED_IN: CodedProblemSpec = {
  status: 401,
  title: 'Not signed in',
  detail: 'Sign in to the staff plane again.',
  code: 'not_signed_in',
};

const STEP_FORBIDDEN: CodedProblemSpec = {
  status: 403,
  title: 'Not permitted',
  detail: 'This step is not open to the session in its current state.',
  code: 'staff_forbidden',
};

const CHALLENGE_UNUSABLE: CodedProblemSpec = {
  status: 409,
  title: 'No usable challenge',
  detail: 'Start the step again: its challenge is missing, expired or for another step.',
  code: 'staff_challenge_unusable',
};

const SECOND_FACTOR_REFUSED: CodedProblemSpec = {
  status: 422,
  title: 'Second factor refused',
  detail: 'The security key or passkey did not prove the session.',
  code: 'staff_second_factor_refused',
};

const CODE_INVALID: CodedProblemSpec = {
  status: 422,
  title: 'Code not accepted',
  detail: 'The code is wrong, used or malformed. Repeated wrong codes end the session.',
  code: 'staff_code_invalid',
};

/**
 * The flows' refusals as the wire states them. `unknown_credential`, `ceremony_refused`
 * and `counter_rejected` share one code: telling an unknown key from a bad signature or a
 * possible clone helps a guesser, not the member, who retries or uses another factor
 * either way. Exported for the code-coverage test.
 */
export const STAFF_SECOND_FACTOR_REFUSALS: Readonly<Record<SecondFactorRefusal, CodedProblemSpec>> =
  {
    no_challenge: CHALLENGE_UNUSABLE,
    wrong_purpose: CHALLENGE_UNUSABLE,
    challenge_expired: CHALLENGE_UNUSABLE,
    not_allowed: STEP_FORBIDDEN,
    unknown_credential: SECOND_FACTOR_REFUSED,
    ceremony_refused: SECOND_FACTOR_REFUSED,
    counter_rejected: SECOND_FACTOR_REFUSED,
    credential_taken: {
      status: 409,
      title: 'Key already registered',
      detail: 'This security key or passkey is already registered on the staff plane.',
      code: 'staff_credential_taken',
    },
    invalid_label: {
      status: 422,
      title: 'Invalid key name',
      detail: 'Give the key a name of 1 to 64 characters.',
      code: 'staff_label_invalid',
    },
    invalid_code: CODE_INVALID,
    session_ended: STAFF_NOT_SIGNED_IN,
  };

export interface StaffSessionRouteDeps extends StaffSessionDeps {
  readonly totp: StaffTotpCodes;
  readonly cookie: StaffSessionCookie;
  readonly allowedOrigins: readonly string[];
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
}

/** The longest base64url member accepted: a 4 KiB attestation object, encoded. */
const MAX_B64 = 6000;
const MAX_CODE = 64;
const B64URL = /^[A-Za-z0-9_-]*$/;

interface Authenticated {
  readonly session: StoredStaffSession;
  readonly state: 'pending_second_factor' | 'verified';
  readonly at: EpochMs;
  readonly ip: string;
}

export function registerStaffSessionRoutes(
  app: FastifyInstance,
  deps: StaffSessionRouteDeps,
): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (request, reply, next) => {
      refuseForeignOrigin(request, deps.allowedOrigins);
      reply.header('cache-control', 'no-store');
      next();
    });

    const requireSession = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<Authenticated> => {
      const at = deps.clock.now();
      const token = deps.cookie.read(request.headers.cookie);
      if (token === undefined) throw signedOut(reply, deps.cookie);
      const found = await authenticateStaffSession(deps, token, at);
      if (found.kind !== 'authenticated') throw signedOut(reply, deps.cookie);
      // Max-Age follows the slid row, as on the public cookie.
      setCookie(reply, deps.cookie.set(token, found.session.idleExpiresAt, at));
      return { session: found.session, state: found.state, at, ip: request.ip };
    };

    scope.get(STAFF_SESSION_PATH, async (request, reply) => {
      const { session, state, at } = await requireSession(request, reply);
      return reply.code(200).send(sessionWire(session, state, at));
    });

    scope.post(`${STAFF_SESSION_PATH}/webauthn/challenge`, async (request, reply) => {
      const purpose = stringMember(request.body, 'purpose', 16);
      if (purpose !== 'authenticate' && purpose !== 'register') {
        throw new ProblemError(INVALID_BODY);
      }
      const { session, at } = await requireSession(request, reply);
      const begun = await beginWebAuthn(deps, session, `webauthn.${purpose}`, at);
      if (begun.kind === 'refused') throw refusal(reply, deps.cookie, begun.reason);
      return reply.code(200).send({
        challenge: b64(begun.challenge),
        credential_ids: begun.credentialIds.map(b64),
        timeout_ms: STAFF_SESSION_POLICY.challengeTtlMs,
      });
    });

    scope.post(`${STAFF_SESSION_PATH}/webauthn/assertion`, async (request, reply) => {
      const response = {
        credentialId: bytesMember(request.body, 'credential_id'),
        clientDataJSON: bytesMember(request.body, 'client_data_json'),
        authenticatorData: bytesMember(request.body, 'authenticator_data'),
        signature: bytesMember(request.body, 'signature'),
      };
      const { session, at, ip } = await requireSession(request, reply);
      const result = await finishWebAuthnAssertion(deps, session, response, { at, ip });
      return sendElevation(reply, deps.cookie, session, at, result);
    });

    scope.post(`${STAFF_SESSION_PATH}/webauthn/registration`, async (request, reply) => {
      const response = {
        clientDataJSON: bytesMember(request.body, 'client_data_json'),
        attestationObject: bytesMember(request.body, 'attestation_object'),
        label: stringMember(request.body, 'label', 256),
      };
      const { session, at, ip } = await requireSession(request, reply);
      const result = await finishWebAuthnRegistration(deps, session, response, { at, ip });
      return sendEnrollment(reply, deps.cookie, session, at, result);
    });

    scope.post(`${STAFF_SESSION_PATH}/totp`, async (request, reply) => {
      const code = stringMember(request.body, 'code', MAX_CODE);
      const { session, at, ip } = await requireSession(request, reply);
      const result = await useTotpCode(deps, session, code, { at, ip });
      return sendElevation(reply, deps.cookie, session, at, result);
    });

    scope.post(`${STAFF_SESSION_PATH}/totp/enrollment`, async (request, reply) => {
      const { session, at } = await requireSession(request, reply);
      const issued = await beginTotpEnrollment(deps, session, at);
      if (issued.kind === 'refused') throw refusal(reply, deps.cookie, issued.reason);
      return reply.code(200).send({
        secret: issued.secret,
        otpauth_uri: issued.otpauthUri,
        timeout_ms: STAFF_SESSION_POLICY.challengeTtlMs,
      });
    });

    scope.post(`${STAFF_SESSION_PATH}/totp/enrollment/confirm`, async (request, reply) => {
      const code = stringMember(request.body, 'code', MAX_CODE);
      const { session, at, ip } = await requireSession(request, reply);
      const result = await finishTotpEnrollment(deps, session, code, { at, ip });
      return sendEnrollment(reply, deps.cookie, session, at, result);
    });

    scope.post(`${STAFF_SESSION_PATH}/recovery-code`, async (request, reply) => {
      const code = stringMember(request.body, 'code', MAX_CODE);
      const { session, at, ip } = await requireSession(request, reply);
      const result = await useRecoveryCode(deps, session, code, { at, ip });
      return sendElevation(reply, deps.cookie, session, at, result);
    });

    scope.post(`${STAFF_SESSION_PATH}/sign-out`, async (request, reply) => {
      const at = deps.clock.now();
      const token = deps.cookie.read(request.headers.cookie);
      if (token !== undefined) {
        const found = await authenticateStaffSession(deps, token, at);
        if (found.kind === 'authenticated') {
          await signOutStaff(deps, found.session.id, { at, ip: request.ip });
        }
      }
      setCookie(reply, deps.cookie.clear());
      return reply.code(204).send();
    });

    done();
  });
}

/** The session as its own member sees it. No email, no token, no ids beyond the member's. */
function sessionWire(session: StoredStaffSession, state: Authenticated['state'], at: EpochMs) {
  return {
    state,
    staff_id: session.staffId,
    roles: session.roles,
    second_factor_method: session.secondFactorMethod,
    idle_expires_at: isoFromEpochMs(session.idleExpiresAt),
    absolute_expires_at: isoFromEpochMs(session.absoluteExpiresAt),
    checked_at: isoFromEpochMs(at),
  };
}

/** The idle expiry an elevation gives (`staff-session.ts` `elevatedIdleExpiry`). */
function elevatedExpiry(session: StoredStaffSession, at: EpochMs): EpochMs {
  return Math.min(at + STAFF_SESSION_POLICY.idleMs, session.absoluteExpiresAt);
}

function sendElevation(
  reply: FastifyReply,
  cookie: StaffSessionCookie,
  session: StoredStaffSession,
  at: EpochMs,
  result: ElevationResult,
): FastifyReply {
  if (result.kind === 'refused') throw refusal(reply, cookie, result.reason);
  setCookie(reply, cookie.set(result.token, elevatedExpiry(session, at), at));
  return reply.code(200).send({ state: 'verified' });
}

function sendEnrollment(
  reply: FastifyReply,
  cookie: StaffSessionCookie,
  session: StoredStaffSession,
  at: EpochMs,
  result: RegistrationResult,
): FastifyReply {
  if (result.kind === 'refused') throw refusal(reply, cookie, result.reason);
  if (result.token !== null) {
    setCookie(reply, cookie.set(result.token, elevatedExpiry(session, at), at));
  } else if (session.secondFactorAt === null) {
    // Enrolled, but the pending session ended meanwhile: sign in again with the new factor.
    setCookie(reply, cookie.clear());
  }
  return reply.code(201).send({
    recovery_codes: result.recoveryCodes,
    state: result.token !== null || session.secondFactorAt !== null ? 'verified' : 'signed_out',
  });
}

/** A refusal; a session that ended also loses its cookie. */
function refusal(
  reply: FastifyReply,
  cookie: StaffSessionCookie,
  reason: SecondFactorRefusal,
): ProblemError {
  if (reason === 'session_ended') return signedOut(reply, cookie);
  return new ProblemError(STAFF_SECOND_FACTOR_REFUSALS[reason]);
}

function signedOut(reply: FastifyReply, cookie: StaffSessionCookie): ProblemError {
  setCookie(reply, cookie.clear());
  return new ProblemError(STAFF_NOT_SIGNED_IN);
}

/**
 * Fastify appends repeated `set-cookie` headers; a flow that slid the cookie and then
 * rotated the token must send only the last one, or the browser briefly holds a dead token.
 */
function setCookie(reply: FastifyReply, value: string): void {
  reply.removeHeader('set-cookie');
  reply.header('set-cookie', value);
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** A non-empty base64url member, decoded, or a 400. */
function bytesMember(body: unknown, name: string): Uint8Array {
  const text = stringMember(body, name, MAX_B64);
  if (text === '' || !B64URL.test(text)) throw new ProblemError(INVALID_BODY);
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

/** Every refusal this module writes itself, beyond the table. For the code-coverage test. */
export const STAFF_SESSION_PROBLEMS: readonly CodedProblemSpec[] = [
  STAFF_NOT_SIGNED_IN,
  CHALLENGE_UNUSABLE,
  SECOND_FACTOR_REFUSED,
  CODE_INVALID,
];
