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
import {
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from './totp.js';
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
 * The TOTP issue and check over a sealed secret. `issue` makes a secret, seals it and hands
 * the plain form out once for the member's app; `verify` opens it for the one verification
 * and drops it. The step `verify` returns is not stored here — the flow advances it with
 * the store's CAS. `issuer` is the name the authenticator app lists the account under.
 */
export function createStaffTotpCodes(
  sealer: StaffTotpSealer,
  options: { readonly issuer: string; readonly random?: (bytes: number) => Uint8Array },
): StaffTotpCodes {
  const issuer = options.issuer.trim();
  if (issuer === '' || issuer.includes(':')) {
    // The otpauth label is `issuer:account`; a colon in the issuer would move the split.
    throw new TypeError('a TOTP issuer is non-empty and has no colon');
  }
  return {
    issue(input) {
      const secret =
        options.random === undefined ? generateTotpSecret() : generateTotpSecret(options.random);
      try {
        return {
          sealed: sealer.seal(input.staffId, secret),
          // Authenticator apps reliably support SHA-1 only; `otpauthUri` says SHA1.
          algorithm: 'sha1',
          secret: base32Encode(secret),
          otpauthUri: otpauthUri({ issuer, account: input.account, secret }),
        };
      } finally {
        secret.fill(0);
      }
    },

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
