/**
 * The staff plane's second-factor ceremonies, bound to one relying party (TASKS I1; 05 C3).
 *
 * The core's staff flows (`core/staff/staff-session.ts`) cannot import `node:crypto`; they
 * see these ports instead. This module binds the relying party once so no flow can
 * verify against the wrong origin, and narrows the verifiers' verdicts to what the flows
 * act on.
 */

import type {
  StaffRecoveryCodes,
  StaffTotpCodes,
  StaffWebAuthnCeremonies,
} from '../../core/ports/staff-stores.js';
import type { StaffTotpSealer } from './aes-gcm-totp-sealer.js';
import { generateRecoveryCodes, hashRecoveryCode, verifyTotp } from './totp.js';
import {
  generateWebAuthnChallenge,
  verifyAssertion,
  verifyRegistration,
  type WebAuthnRelyingParty,
} from './webauthn.js';

export function createStaffWebAuthnCeremonies(
  rp: WebAuthnRelyingParty,
  random?: (bytes: number) => Uint8Array,
): StaffWebAuthnCeremonies {
  return {
    challenge: () =>
      random === undefined ? generateWebAuthnChallenge() : generateWebAuthnChallenge(random),

    verifyRegistration(input) {
      const verdict = verifyRegistration({ ...input, rp });
      if (verdict.kind === 'refused') return verdict;
      const { credentialId, publicKeyCose, algorithm, signCount, backupEligible } =
        verdict.credential;
      return {
        kind: 'accepted',
        credential: { credentialId, publicKeyCose, algorithm, signCount, backupEligible },
      };
    },

    verifyAssertion(input) {
      const verdict = verifyAssertion({ ...input, rp });
      if (verdict.kind === 'refused') return verdict;
      return { kind: 'accepted', signCount: verdict.signCount };
    },
  };
}

export function createStaffRecoveryCodes(
  random?: (bytes: number) => Uint8Array,
): StaffRecoveryCodes {
  return {
    issue: () => (random === undefined ? generateRecoveryCodes() : generateRecoveryCodes(random)),
    hash: hashRecoveryCode,
  };
}

/**
 * The TOTP check over a sealed secret: opens it for the one verification and drops it.
 * The step it returns is not stored here — the flow advances it with the store's CAS.
 */
export function createStaffTotpCodes(sealer: StaffTotpSealer): StaffTotpCodes {
  return {
    verify(input) {
      const secret = sealer.open(input.staffId, input.factor.sealed);
      try {
        return verifyTotp({
          secret,
          code: input.code,
          atMs: input.at,
          lastUsedStep: input.factor.lastUsedStep,
          algorithm: input.factor.algorithm,
        });
      } finally {
        secret.fill(0);
      }
    },
  };
}
