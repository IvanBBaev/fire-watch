/**
 * The staff session's flows (TASKS I1; 05 C3, §5.4.3; migration 029).
 *
 * Written against ports only: the stores ({@link StaffSessionStore}, {@link StaffStore}),
 * the token minter ({@link AuthTokens}) and the second-factor ceremonies, so the HTTP plane
 * (L-15) and a host CLI drive the same rules. Nothing here knows about cookies or routes;
 * a flow that grants a new bearer token returns it and the caller sets it.
 *
 * The lifecycle:
 *
 *   1. `startStaffSession` — after the primary sign-in (not built: it needs the founder's
 *      mail decision). The session is `pending_second_factor` and has no powers.
 *   2. `beginWebAuthn` stores a challenge on the session; `finishWebAuthnAssertion` takes
 *      it (once), verifies the assertion, advances the signature counter (the clone
 *      guard) and elevates the session with a fresh token. `useTotpCode` elevates with a
 *      TOTP code (RFC 6238, its step advanced by the store's CAS, the replay guard) and
 *      `useRecoveryCode` with a recovery code instead. Wrong codes count against the
 *      session; `STAFF_SESSION_POLICY.maxSecondFactorFailures` of them end it.
 *   3. A member with no second factor at all enrolls the first one from the pending
 *      session (`finishWebAuthnRegistration`, or `beginTotpEnrollment` then
 *      `finishTotpEnrollment`): that enrollment prints the recovery codes and elevates
 *      the session. Later factors need a verified session. A TOTP enrollment keeps the
 *      new secret sealed in the session's challenge slot (migration 031) until the member
 *      types a code from their app, and always prints a fresh recovery-code set.
 *   4. `authenticateStaffSession` reads the session on every request and slides its idle
 *      expiry; `signOutStaff` ends it.
 *
 * Removing a credential or the TOTP factor, changing a member and off-boarding one go
 * through `staff-session-policy.ts`'s decisions first, then the store, which re-checks
 * what only it can (the last factor).
 */

import type { AuthTokens } from '../ports/auth-stores.js';
import type { EpochMs } from '../ports/clock.js';
import type {
  StaffRecoveryCodes,
  StaffOffboardingCounts,
  StaffSessionStore,
  StaffStore,
  StaffTotpCodes,
  StaffWebAuthnCeremonies,
  StoredStaffSession,
} from '../ports/staff-stores.js';
import type { StaffPrincipal, StaffRole } from './staff-policy.js';
import {
  STAFF_SESSION_POLICY,
  challengeExpiry,
  decideCredentialRemoval,
  decideMemberChange,
  mayEnrollSecondFactor,
  newStaffSessionExpiries,
  slidStaffIdleExpiry,
  staffPrincipalOf,
  staffSessionState,
  usableChallenge,
  type ChallengeRefusal,
  type StaffSessionState,
  type StaffWebAuthnPurpose,
} from './staff-session-policy.js';

export interface StaffSessionDeps {
  readonly sessions: StaffSessionStore;
  readonly staff: StaffStore;
  readonly tokens: AuthTokens;
  readonly ceremonies: StaffWebAuthnCeremonies;
  readonly recoveryCodes: StaffRecoveryCodes;
}

/** Where the request came from and when; the audit rows' context. */
export interface StaffRequestContext {
  readonly at: EpochMs;
  readonly ip?: string;
}

const ipOf = (context: StaffRequestContext) => (context.ip === undefined ? {} : { ip: context.ip });

/** The idle expiry a session gets at the moment it passes its second factor. */
function elevatedIdleExpiry(session: StoredStaffSession, at: EpochMs): EpochMs {
  return Math.min(at + STAFF_SESSION_POLICY.idleMs, session.absoluteExpiresAt);
}

// ── Start and read ───────────────────────────────────────────────────────────────────

export async function startStaffSession(
  deps: Pick<StaffSessionDeps, 'sessions' | 'staff' | 'tokens'>,
  input: { readonly staffId: string; readonly uaFamily: string },
  context: StaffRequestContext,
): Promise<
  | { readonly kind: 'started'; readonly sessionId: string; readonly token: string }
  | { readonly kind: 'member_unavailable' }
> {
  const member = await deps.staff.findMember(input.staffId);
  if (member === null || member.disabled) return { kind: 'member_unavailable' };
  const minted = deps.tokens.mint();
  const sessionId = deps.tokens.newId();
  await deps.sessions.insert({
    id: sessionId,
    tokenHash: minted.hash,
    staffId: member.staffId,
    uaFamily: input.uaFamily,
    at: context.at,
    ...newStaffSessionExpiries(context.at),
  });
  return { kind: 'started', sessionId, token: minted.token };
}

export type StaffAuthentication =
  | {
      readonly kind: 'authenticated';
      readonly session: StoredStaffSession;
      readonly state: Extract<StaffSessionState, 'pending_second_factor' | 'verified'>;
      readonly principal: StaffPrincipal;
    }
  | { readonly kind: 'unauthenticated' };

/**
 * The per-request read: resolves the cookie's token to a live session and slides its idle
 * expiry. A pending session authenticates (it may finish its ceremony) but its principal
 * has no powers. Why a session is dead is not told apart: the caller clears the cookie.
 */
export async function authenticateStaffSession(
  deps: Pick<StaffSessionDeps, 'sessions' | 'tokens'>,
  token: string,
  at: EpochMs,
): Promise<StaffAuthentication> {
  const hash = deps.tokens.hash(token);
  if (hash === null) return { kind: 'unauthenticated' };
  const found = await deps.sessions.findByTokenHash(hash);
  if (found === null) return { kind: 'unauthenticated' };
  const state = staffSessionState(found, at);
  if (state !== 'pending_second_factor' && state !== 'verified') {
    return { kind: 'unauthenticated' };
  }
  const idleExpiresAt = slidStaffIdleExpiry(found, at);
  if (!(await deps.sessions.touch(found.id, at, idleExpiresAt))) {
    return { kind: 'unauthenticated' };
  }
  const session = { ...found, idleExpiresAt, lastSeenAt: Math.max(found.lastSeenAt, at) };
  return { kind: 'authenticated', session, state, principal: staffPrincipalOf(session, at) };
}

// ── WebAuthn ─────────────────────────────────────────────────────────────────────────

export type BeginWebAuthnResult =
  | {
      readonly kind: 'challenge';
      readonly challenge: Uint8Array;
      /** The member's credential ids: the assertion's allow-list, registration's exclude-list. */
      readonly credentialIds: readonly Uint8Array[];
    }
  | { readonly kind: 'refused'; readonly reason: 'not_allowed' | 'session_ended' };

/**
 * Issues the ceremony's challenge and stores it on the session, replacing any earlier
 * one. Authenticating is for a pending session; registering follows
 * `mayEnrollSecondFactor`.
 */
export async function beginWebAuthn(
  deps: Pick<StaffSessionDeps, 'sessions' | 'staff' | 'ceremonies'>,
  session: StoredStaffSession,
  purpose: StaffWebAuthnPurpose,
  at: EpochMs,
): Promise<BeginWebAuthnResult> {
  const state = staffSessionState(session, at);
  const credentials = await deps.staff.listWebAuthnCredentials(session.staffId);
  if (purpose === 'webauthn.authenticate') {
    if (state !== 'pending_second_factor' || credentials.length === 0) {
      return { kind: 'refused', reason: 'not_allowed' };
    }
  } else if (!mayEnrollSecondFactor(state, await deps.staff.countSecondFactors(session.staffId))) {
    return { kind: 'refused', reason: 'not_allowed' };
  }
  const challenge = deps.ceremonies.challenge();
  const stored = await deps.sessions.putChallenge(
    session.id,
    { purpose, challenge, expiresAt: challengeExpiry(at) },
    at,
  );
  if (!stored) return { kind: 'refused', reason: 'session_ended' };
  return {
    kind: 'challenge',
    challenge,
    credentialIds: credentials.map((credential) => credential.credentialId),
  };
}

export type SecondFactorRefusal =
  | ChallengeRefusal
  | 'not_allowed'
  | 'unknown_credential'
  | 'ceremony_refused'
  | 'counter_rejected'
  | 'credential_taken'
  | 'invalid_label'
  | 'invalid_code'
  | 'session_ended';

export type ElevationResult =
  | { readonly kind: 'verified'; readonly token: string }
  | { readonly kind: 'refused'; readonly reason: SecondFactorRefusal };

/** Elevates the session with a fresh token; `session_ended` when the CAS found it changed. */
async function elevate(
  deps: Pick<StaffSessionDeps, 'sessions' | 'tokens'>,
  session: StoredStaffSession,
  factor: {
    readonly method: 'webauthn' | 'totp' | 'recovery_code';
    readonly credentialId: Uint8Array | null;
  },
  context: StaffRequestContext,
): Promise<ElevationResult> {
  const minted = deps.tokens.mint();
  const marked = await deps.sessions.markSecondFactor(
    session.id,
    {
      method: factor.method,
      credentialId: factor.credentialId,
      newTokenHash: minted.hash,
      idleExpiresAt: elevatedIdleExpiry(session, context.at),
    },
    { at: context.at, ...ipOf(context) },
  );
  return marked
    ? { kind: 'verified', token: minted.token }
    : { kind: 'refused', reason: 'session_ended' };
}

export async function finishWebAuthnAssertion(
  deps: StaffSessionDeps,
  session: StoredStaffSession,
  response: {
    readonly credentialId: Uint8Array;
    readonly clientDataJSON: Uint8Array;
    readonly authenticatorData: Uint8Array;
    readonly signature: Uint8Array;
  },
  context: StaffRequestContext,
): Promise<ElevationResult> {
  // Taken first and unconditionally: a challenge is burnt by any answer, right or wrong.
  const taken = usableChallenge(
    await deps.sessions.takeChallenge(session.id),
    'webauthn.authenticate',
    context.at,
  );
  if (taken.kind !== 'usable') return { kind: 'refused', reason: taken.kind };
  if (staffSessionState(session, context.at) !== 'pending_second_factor') {
    return { kind: 'refused', reason: 'not_allowed' };
  }
  const credential = await deps.staff.findWebAuthnCredential(response.credentialId);
  if (credential === null || credential.staffId !== session.staffId) {
    return { kind: 'refused', reason: 'unknown_credential' };
  }
  const verdict = deps.ceremonies.verifyAssertion({
    clientDataJSON: response.clientDataJSON,
    authenticatorData: response.authenticatorData,
    signature: response.signature,
    expectedChallenge: taken.challenge,
    credential: { publicKeyCose: credential.publicKeyCose, signCount: credential.signCount },
  });
  if (verdict.kind !== 'accepted') return { kind: 'refused', reason: 'ceremony_refused' };
  const advanced = await deps.staff.advanceWebAuthnSignCount(
    credential.credentialId,
    verdict.signCount,
    context.at,
  );
  if (!advanced) return { kind: 'refused', reason: 'counter_rejected' };
  return elevate(
    deps,
    session,
    { method: 'webauthn', credentialId: credential.credentialId },
    context,
  );
}

export type RegistrationResult =
  | {
      readonly kind: 'enrolled';
      /**
       * Shown once: on a passkey enrollment only for the member's first factor (null
       * afterwards); on a TOTP enrollment always, since it replaces the set.
       */
      readonly recoveryCodes: readonly string[] | null;
      /** A fresh token when this enrollment elevated a pending session; null otherwise. */
      readonly token: string | null;
    }
  | { readonly kind: 'refused'; readonly reason: SecondFactorRefusal };

export async function finishWebAuthnRegistration(
  deps: StaffSessionDeps,
  session: StoredStaffSession,
  response: {
    readonly clientDataJSON: Uint8Array;
    readonly attestationObject: Uint8Array;
    readonly label: string;
  },
  context: StaffRequestContext,
): Promise<RegistrationResult> {
  const taken = usableChallenge(
    await deps.sessions.takeChallenge(session.id),
    'webauthn.register',
    context.at,
  );
  if (taken.kind !== 'usable') return { kind: 'refused', reason: taken.kind };
  const label = response.label.trim();
  if (label.length === 0 || label.length > 64) {
    return { kind: 'refused', reason: 'invalid_label' };
  }
  const state = staffSessionState(session, context.at);
  const existing = await deps.staff.countSecondFactors(session.staffId);
  if (!mayEnrollSecondFactor(state, existing)) return { kind: 'refused', reason: 'not_allowed' };
  const verdict = deps.ceremonies.verifyRegistration({
    clientDataJSON: response.clientDataJSON,
    attestationObject: response.attestationObject,
    expectedChallenge: taken.challenge,
  });
  if (verdict.kind !== 'accepted') return { kind: 'refused', reason: 'ceremony_refused' };
  const first = existing === 0;
  const codes = first ? deps.recoveryCodes.issue() : null;
  const enrolled = await deps.staff.enrollWebAuthnCredential(
    session.staffId,
    { ...verdict.credential, label },
    codes === null ? null : codes.map((code) => code.hash),
    { actorId: session.staffId, at: context.at, ...ipOf(context) },
  );
  if (enrolled.kind === 'credential_taken') {
    return { kind: 'refused', reason: 'credential_taken' };
  }
  const recoveryCodes = codes === null ? null : codes.map((code) => code.display);
  if (state === 'verified') return { kind: 'enrolled', recoveryCodes, token: null };
  const elevated = await elevate(
    deps,
    session,
    { method: 'webauthn', credentialId: verdict.credential.credentialId },
    context,
  );
  // The key is enrolled either way; a session that ended meanwhile signs in again with it.
  return {
    kind: 'enrolled',
    recoveryCodes,
    token: elevated.kind === 'verified' ? elevated.token : null,
  };
}

// ── Typed codes: TOTP and recovery ───────────────────────────────────────────────────

/**
 * Counts a wrong code against the session. A malformed one is not counted (it is a typo,
 * not a guess); everything that could be a guess is. `session_ended` when this one hit the
 * cap and the store revoked the session.
 */
async function refuseCode(
  deps: Pick<StaffSessionDeps, 'sessions'>,
  session: StoredStaffSession,
  context: StaffRequestContext,
): Promise<ElevationResult> {
  const counted = await deps.sessions.recordSecondFactorFailure(
    session.id,
    STAFF_SESSION_POLICY.maxSecondFactorFailures,
    { at: context.at, ...ipOf(context) },
  );
  if (counted === null || counted.revoked) return { kind: 'refused', reason: 'session_ended' };
  return { kind: 'refused', reason: 'invalid_code' };
}

/**
 * Elevates a pending session with the member's TOTP code. The verifier checks the code
 * against the sealed secret and the stored last step; the store's CAS then advances the
 * step, so of two requests racing with one code exactly one elevates.
 */
export async function useTotpCode(
  deps: Pick<StaffSessionDeps, 'sessions' | 'staff' | 'tokens'> & {
    readonly totp: StaffTotpCodes;
  },
  session: StoredStaffSession,
  code: string,
  context: StaffRequestContext,
): Promise<ElevationResult> {
  if (staffSessionState(session, context.at) !== 'pending_second_factor') {
    return { kind: 'refused', reason: 'not_allowed' };
  }
  const factor = await deps.staff.findTotpFactor(session.staffId);
  if (factor === null) return { kind: 'refused', reason: 'not_allowed' };
  const verdict = deps.totp.verify({
    staffId: session.staffId,
    factor,
    code,
    at: context.at,
  });
  if (verdict.kind === 'refused') {
    return verdict.reason === 'malformed'
      ? { kind: 'refused', reason: 'invalid_code' }
      : refuseCode(deps, session, context);
  }
  if (!(await deps.staff.advanceTotpStep(session.staffId, verdict.step))) {
    return refuseCode(deps, session, context);
  }
  return elevate(deps, session, { method: 'totp', credentialId: null }, context);
}

// ── TOTP enrollment ──────────────────────────────────────────────────────────────────

export type BeginTotpEnrollmentResult =
  | {
      readonly kind: 'secret';
      /** Base32, for typing into the app by hand. Shown once; never stored in the clear. */
      readonly secret: string;
      /** The `otpauth://` URI for the QR code. */
      readonly otpauthUri: string;
    }
  | { readonly kind: 'refused'; readonly reason: 'not_allowed' | 'session_ended' };

/**
 * Issues a TOTP secret for the member to add to their app. The secret is sealed and parked
 * in the session's challenge slot (replacing any pending ceremony) for the challenge's
 * lifetime; nothing is enrolled until `finishTotpEnrollment` sees a code made from it.
 * Allowed as `mayEnrollSecondFactor` says; on a verified session it re-enrolls the factor.
 */
export async function beginTotpEnrollment(
  deps: Pick<StaffSessionDeps, 'sessions' | 'staff'> & { readonly totp: StaffTotpCodes },
  session: StoredStaffSession,
  at: EpochMs,
): Promise<BeginTotpEnrollmentResult> {
  const state = staffSessionState(session, at);
  if (!mayEnrollSecondFactor(state, await deps.staff.countSecondFactors(session.staffId))) {
    return { kind: 'refused', reason: 'not_allowed' };
  }
  const member = await deps.staff.findMember(session.staffId);
  if (member === null || member.disabled) return { kind: 'refused', reason: 'session_ended' };
  const issued = deps.totp.issue({ staffId: session.staffId, account: member.email });
  const stored = await deps.sessions.putChallenge(
    session.id,
    {
      purpose: 'totp.enroll',
      challenge: issued.sealed.ciphertext,
      keyId: issued.sealed.keyId,
      expiresAt: challengeExpiry(at),
    },
    at,
  );
  if (!stored) return { kind: 'refused', reason: 'session_ended' };
  return { kind: 'secret', secret: issued.secret, otpauthUri: issued.otpauthUri };
}

/**
 * Confirms a pending TOTP enrollment with a code from the member's app, then enrolls the
 * factor, replaces the recovery codes (returned for printing, once) and — on a pending
 * session — elevates it. A wrong code puts the pending secret back with its original
 * expiry, so the member can retype; it is not counted against the session, because the
 * code proves possession of a secret the session itself was just handed, not the member's
 * standing factor. The confirming code's step is burnt, so it cannot sign in again.
 */
export async function finishTotpEnrollment(
  deps: Pick<StaffSessionDeps, 'sessions' | 'staff' | 'tokens' | 'recoveryCodes'> & {
    readonly totp: StaffTotpCodes;
  },
  session: StoredStaffSession,
  code: string,
  context: StaffRequestContext,
): Promise<RegistrationResult> {
  const pending = await deps.sessions.takeChallenge(session.id);
  const taken = usableChallenge(pending, 'totp.enroll', context.at);
  if (taken.kind !== 'usable') return { kind: 'refused', reason: taken.kind };
  if (pending === null || pending.purpose !== 'totp.enroll') {
    return { kind: 'refused', reason: 'wrong_purpose' };
  }
  const state = staffSessionState(session, context.at);
  if (!mayEnrollSecondFactor(state, await deps.staff.countSecondFactors(session.staffId))) {
    return { kind: 'refused', reason: 'not_allowed' };
  }
  const factor = {
    sealed: { ciphertext: pending.challenge, keyId: pending.keyId },
    algorithm: 'sha1' as const,
  };
  const verdict = deps.totp.verify({
    staffId: session.staffId,
    factor: { ...factor, lastUsedStep: null },
    code,
    at: context.at,
  });
  if (verdict.kind === 'refused') {
    const restored = await deps.sessions.putChallenge(session.id, pending, context.at);
    return { kind: 'refused', reason: restored ? 'invalid_code' : 'session_ended' };
  }
  const codes = deps.recoveryCodes.issue();
  await deps.staff.enrollTotp(
    session.staffId,
    factor,
    codes.map((issued) => issued.hash),
    { actorId: session.staffId, at: context.at, ...ipOf(context) },
  );
  // Burns the confirming code's step: enrolling reset the replay guard to "never used".
  await deps.staff.advanceTotpStep(session.staffId, verdict.step);
  const recoveryCodes = codes.map((issued) => issued.display);
  if (state === 'verified') return { kind: 'enrolled', recoveryCodes, token: null };
  const elevated = await elevate(deps, session, { method: 'totp', credentialId: null }, context);
  // The factor is enrolled either way; a session that ended meanwhile signs in again with it.
  return {
    kind: 'enrolled',
    recoveryCodes,
    token: elevated.kind === 'verified' ? elevated.token : null,
  };
}

export async function useRecoveryCode(
  deps: StaffSessionDeps,
  session: StoredStaffSession,
  rawCode: string,
  context: StaffRequestContext,
): Promise<ElevationResult> {
  if (staffSessionState(session, context.at) !== 'pending_second_factor') {
    return { kind: 'refused', reason: 'not_allowed' };
  }
  const hash = deps.recoveryCodes.hash(rawCode);
  if (hash === null) return { kind: 'refused', reason: 'invalid_code' };
  const consumed = await deps.staff.consumeRecoveryCode(session.staffId, hash, {
    at: context.at,
    ...ipOf(context),
  });
  if (!consumed) return refuseCode(deps, session, context);
  return elevate(deps, session, { method: 'recovery_code', credentialId: null }, context);
}

// ── Credential removal, member changes, sign-out ─────────────────────────────────────

export type StaffChangeResult<Done> =
  | Done
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'second_factor_missing'
        | 'not_permitted'
        | 'self_change'
        | 'not_found'
        | 'last_second_factor';
    };

export async function removeWebAuthnCredential(
  deps: Pick<StaffSessionDeps, 'staff'>,
  actor: StaffPrincipal,
  target: { readonly staffId: string; readonly credentialId: Uint8Array },
  context: StaffRequestContext,
): Promise<StaffChangeResult<{ readonly kind: 'removed'; readonly sessionsRevoked: number }>> {
  const decision = decideCredentialRemoval(actor, target.staffId);
  if (decision.kind === 'refused') return decision;
  const removed = await deps.staff.removeWebAuthnCredential(target.staffId, target.credentialId, {
    actorId: actor.staffId,
    at: context.at,
    ...ipOf(context),
  });
  return removed.kind === 'removed' ? removed : { kind: 'refused', reason: removed.kind };
}

/** Removes the member's TOTP factor under the same rule as a WebAuthn credential. */
export async function removeStaffTotpFactor(
  deps: Pick<StaffSessionDeps, 'staff'>,
  actor: StaffPrincipal,
  target: { readonly staffId: string },
  context: StaffRequestContext,
): Promise<StaffChangeResult<{ readonly kind: 'removed'; readonly sessionsRevoked: number }>> {
  const decision = decideCredentialRemoval(actor, target.staffId);
  if (decision.kind === 'refused') return decision;
  const removed = await deps.staff.removeTotpFactor(target.staffId, {
    actorId: actor.staffId,
    at: context.at,
    ...ipOf(context),
  });
  return removed.kind === 'removed' ? removed : { kind: 'refused', reason: removed.kind };
}

/**
 * Off-boards a member (docs/runbooks/06-staff-offboarding.md): `staff.manage`, never on
 * oneself, like disabling. Unlike disabling it also works on an already disabled member,
 * so a member disabled in a hurry can be cleaned out afterwards.
 */
export async function offboardStaffMember(
  deps: Pick<StaffSessionDeps, 'staff'>,
  actor: StaffPrincipal,
  targetStaffId: string,
  context: StaffRequestContext,
): Promise<
  StaffChangeResult<
    | ({ readonly kind: 'offboarded' } & StaffOffboardingCounts)
    | { readonly kind: 'already_offboarded' }
  >
> {
  const decision = decideMemberChange(actor, targetStaffId);
  if (decision.kind === 'refused') return decision;
  const done = await deps.staff.offboardMember(targetStaffId, {
    actorId: actor.staffId,
    at: context.at,
    ...ipOf(context),
  });
  return done.kind === 'not_found' ? { kind: 'refused', reason: 'not_found' } : done;
}

export async function disableStaffMember(
  deps: Pick<StaffSessionDeps, 'staff'>,
  actor: StaffPrincipal,
  targetStaffId: string,
  context: StaffRequestContext,
): Promise<StaffChangeResult<{ readonly kind: 'disabled'; readonly sessionsRevoked: number }>> {
  const decision = decideMemberChange(actor, targetStaffId);
  if (decision.kind === 'refused') return decision;
  const disabled = await deps.staff.disableMember(targetStaffId, {
    actorId: actor.staffId,
    at: context.at,
    ...ipOf(context),
  });
  return disabled.kind === 'disabled' ? disabled : { kind: 'refused', reason: 'not_found' };
}

export async function setStaffRoles(
  deps: Pick<StaffSessionDeps, 'staff'>,
  actor: StaffPrincipal,
  target: { readonly staffId: string; readonly roles: readonly StaffRole[] },
  context: StaffRequestContext,
): Promise<StaffChangeResult<{ readonly kind: 'changed' | 'unchanged' }>> {
  const decision = decideMemberChange(actor, target.staffId);
  if (decision.kind === 'refused') return decision;
  const changed = await deps.staff.setRoles(target.staffId, target.roles, {
    actorId: actor.staffId,
    at: context.at,
    ...ipOf(context),
  });
  return changed.kind === 'not_found'
    ? { kind: 'refused', reason: 'not_found' }
    : { kind: changed.kind };
}

export async function signOutStaff(
  deps: Pick<StaffSessionDeps, 'sessions'>,
  sessionId: string,
  context: StaffRequestContext,
): Promise<boolean> {
  return deps.sessions.revoke(sessionId, { at: context.at, ...ipOf(context) });
}
