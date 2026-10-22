/**
 * TOTP and recovery codes for the staff plane's second factor (TASKS I1; 05 C3, §5.4.3).
 *
 * 05 makes 2FA mandatory for staff — WebAuthn preferred, **TOTP fallback**, recovery codes
 * printed at enrollment, no SMS. This module is the arithmetic for the latter two; it holds
 * no state. Where a secret and the last accepted step live (sealed at rest, like zone
 * centres) is the staff store's job.
 *
 * * **TOTP** is RFC 6238 over RFC 4226's HOTP: HMAC of the 30-second step counter, dynamic
 *   truncation, 6 digits. SHA-1 is the default because it is the only algorithm every
 *   authenticator app honours; the test pins RFC 6238 Appendix B's vectors for all three.
 * * **Replay**: a code is accepted for one step at most once. {@link verifyTotp} takes the
 *   last step the member used and refuses any step at or before it, so a shoulder-surfed
 *   code is dead the moment its owner has used it — RFC 6238 §5.2's "MUST NOT accept the
 *   second attempt".
 * * **Clock drift**: ±1 step (RFC 6238 §5.2's recommended single backward step, and one
 *   forward for a phone that runs ahead).
 * * **Recovery codes**: ten, 80 bits each, shown once and stored as SHA-256 only. 80 random
 *   bits leave nothing for a slow hash to protect (see `auth-tokens.ts`), and a plain hash
 *   keeps the lookup an index equality.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export const TOTP_POLICY = {
  stepSeconds: 30,
  digits: 6,
  /** Steps accepted either side of the current one. */
  driftSteps: 1,
  /** RFC 4226 §4 R6 asks for at least 128 bits; 160 is the RFC's SHA-1 example length. */
  secretBytes: 20,
  recoveryCodeCount: 10,
  recoveryCodeBytes: 10,
} as const;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** Case-insensitive; spaces, dashes and `=` padding ignored. Null on any other character. */
export function base32Decode(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) return null;
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** RFC 6238's T: whole steps since the Unix epoch. */
export function totpStep(atMs: number, stepSeconds: number = TOTP_POLICY.stepSeconds): number {
  return Math.floor(atMs / 1000 / stepSeconds);
}

/** RFC 4226 HOTP of `counter`, zero-padded to `digits`. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  options: { readonly digits?: number; readonly algorithm?: TotpAlgorithm } = {},
): string {
  const digits = options.digits ?? TOTP_POLICY.digits;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(options.algorithm ?? 'sha1', secret)
    .update(message)
    .digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export type TotpVerdict =
  | { readonly kind: 'accepted'; readonly step: number }
  | { readonly kind: 'refused'; readonly reason: 'malformed' | 'wrong_code' | 'replayed' };

/**
 * Checks `code` against the steps around `atMs`. On acceptance the caller must persist the
 * returned step as the member's new `lastUsedStep` in the same transaction that starts the
 * 2FA'd session, or the replay guard is only advisory.
 */
export function verifyTotp(input: {
  readonly secret: Uint8Array;
  readonly code: string;
  readonly atMs: number;
  /** The highest step this member has had accepted; null before the first use. */
  readonly lastUsedStep: number | null;
  readonly digits?: number;
  readonly algorithm?: TotpAlgorithm;
}): TotpVerdict {
  const digits = input.digits ?? TOTP_POLICY.digits;
  const code = input.code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return { kind: 'refused', reason: 'malformed' };
  const now = totpStep(input.atMs);
  let matched: number | null = null;
  // Every candidate is computed and compared, so timing does not reveal which step matched.
  for (let step = now - TOTP_POLICY.driftSteps; step <= now + TOTP_POLICY.driftSteps; step++) {
    const expected = hotp(input.secret, step, { digits, algorithm: input.algorithm ?? 'sha1' });
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code)) && matched === null) {
      matched = step;
    }
  }
  if (matched === null) return { kind: 'refused', reason: 'wrong_code' };
  if (input.lastUsedStep !== null && matched <= input.lastUsedStep) {
    return { kind: 'refused', reason: 'replayed' };
  }
  return { kind: 'accepted', step: matched };
}

export function generateTotpSecret(
  random: (bytes: number) => Uint8Array = randomBytes,
): Uint8Array {
  return new Uint8Array(random(TOTP_POLICY.secretBytes));
}

/**
 * The `otpauth://` URI an authenticator app scans (Google Authenticator's Key Uri Format).
 * Issuer and account are percent-encoded; the secret goes unpadded.
 */
export function otpauthUri(input: {
  readonly issuer: string;
  readonly account: string;
  readonly secret: Uint8Array;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(input.secret),
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_POLICY.digits),
    period: String(TOTP_POLICY.stepSeconds),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ── Recovery codes ───────────────────────────────────────────────────────────────────

export interface RecoveryCode {
  /** Shown to the member once, as `XXXX-XXXX-XXXX-XXXX`. */
  readonly display: string;
  /** What is stored: SHA-256 of the normalized code. */
  readonly hash: Uint8Array;
}

/** Upper-case base32 without separators, or null when it cannot be a recovery code. */
export function normalizeRecoveryCode(raw: string): string | null {
  const clean = raw.replace(/[\s-]/g, '').toUpperCase();
  const length = Math.ceil((TOTP_POLICY.recoveryCodeBytes * 8) / 5);
  return new RegExp(`^[A-Z2-7]{${length}}$`).test(clean) ? clean : null;
}

export function hashRecoveryCode(raw: string): Uint8Array | null {
  const normalized = normalizeRecoveryCode(raw);
  if (normalized === null) return null;
  return new Uint8Array(createHash('sha256').update(normalized, 'utf8').digest());
}

export function generateRecoveryCodes(
  random: (bytes: number) => Uint8Array = randomBytes,
): readonly RecoveryCode[] {
  return Array.from({ length: TOTP_POLICY.recoveryCodeCount }, () => {
    const code = base32Encode(random(TOTP_POLICY.recoveryCodeBytes));
    const hash = hashRecoveryCode(code);
    if (hash === null) throw new Error('generated recovery code failed its own shape check');
    return { display: code.match(/.{1,4}/g)?.join('-') ?? code, hash };
  });
}
