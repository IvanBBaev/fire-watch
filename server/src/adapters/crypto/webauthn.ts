/**
 * WebAuthn (passkey / security key) verification for the staff plane's second factor
 * (TASKS I1; 05 C3, §5.4.3).
 *
 * 05 makes 2FA mandatory for staff with **WebAuthn preferred** and TOTP as the fallback
 * (`totp.ts`). This module is the relying party's half of W3C WebAuthn Level 3 §7.1
 * (registering a credential) and §7.2 (verifying an assertion). Like `totp.ts` it holds
 * no state: the challenge a ceremony was started with, the stored public key and the last
 * signature counter are the caller's, and the staff store repeats the counter check as a
 * compare-and-set so two racing assertions cannot both win.
 *
 * Scope, on purpose:
 *
 * * **Attestation `none` only.** The staff plane asks authenticators for no attestation
 *   (`attestation: "none"`, the WebAuthn default). Who made the authenticator is not what
 *   the second factor proves — possession of the private key is — and checking attestation
 *   chains would mean shipping and maintaining a root-certificate set. Any other format is
 *   refused rather than accepted unverified.
 * * **Three algorithms**: ES256 (−7), EdDSA/Ed25519 (−8) and RS256 (−257) — the set every
 *   platform and roaming authenticator in use offers. Anything else is refused.
 * * **CBOR**: a strict decoder for the subset CTAP2 emits (definite lengths, integer or
 *   text map keys, no tags, no floats). Duplicate map keys and trailing bytes are refused.
 *
 * Every comparison of a value the client sent with one the server holds (challenge,
 * RP ID hash) is constant-time, though none of them is secret after the ceremony.
 */

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export const WEBAUTHN_POLICY = {
  /** §13.4.3: at least 16 bytes; 32 matches the magic-link and session tokens. */
  challengeBytes: 32,
  /** §6.1: credential IDs are at most 1023 bytes. */
  maxCredentialIdBytes: 1023,
  /** The smallest RSA modulus accepted for RS256. */
  minRsaModulusBits: 2048,
  maxCborDepth: 16,
} as const;

/** COSE algorithm identifiers (IANA "COSE Algorithms"). */
export const WEBAUTHN_ALGORITHMS = { ES256: -7, EdDSA: -8, RS256: -257 } as const;
export type WebAuthnAlgorithm = (typeof WEBAUTHN_ALGORITHMS)[keyof typeof WEBAUTHN_ALGORITHMS];
const SUPPORTED_ALGORITHMS: readonly number[] = Object.values(WEBAUTHN_ALGORITHMS);

export function isWebAuthnAlgorithm(value: unknown): value is WebAuthnAlgorithm {
  return typeof value === 'number' && SUPPORTED_ALGORITHMS.includes(value);
}

// ── base64url ────────────────────────────────────────────────────────────────────────

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Null on anything outside the unpadded base64url alphabet. */
export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

export function generateWebAuthnChallenge(
  random: (bytes: number) => Uint8Array = randomBytes,
): Uint8Array {
  return new Uint8Array(random(WEBAUTHN_POLICY.challengeBytes));
}

// ── CBOR (RFC 8949, the CTAP2 subset) ────────────────────────────────────────────────

export type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | Uint8Array
  | readonly CborValue[]
  | ReadonlyMap<number | string, CborValue>;

class CborError extends Error {}

/**
 * Decodes one CBOR item starting at `offset` and returns it with the offset just past it.
 * Throws on anything outside the subset; {@link decodeCborOnce} is the non-throwing door.
 */
export function decodeCbor(
  bytes: Uint8Array,
  offset = 0,
  depth = 0,
): { readonly value: CborValue; readonly end: number } {
  if (depth > WEBAUTHN_POLICY.maxCborDepth) throw new CborError('nested too deep');
  const initial = byteAt(bytes, offset);
  const major = initial >> 5;
  const info = initial & 0x1f;
  let cursor = offset + 1;

  if (major === 7) {
    if (info === 20) return { value: false, end: cursor };
    if (info === 21) return { value: true, end: cursor };
    if (info === 22) return { value: null, end: cursor };
    throw new CborError('unsupported simple value or float');
  }

  let argument: bigint;
  if (info < 24) {
    argument = BigInt(info);
  } else if (info <= 27) {
    const size = 1 << (info - 24);
    if (cursor + size > bytes.length) throw new CborError('truncated argument');
    argument = 0n;
    for (let i = 0; i < size; i++) argument = (argument << 8n) | BigInt(bytes[cursor + i] ?? 0);
    cursor += size;
  } else {
    throw new CborError('indefinite length or reserved additional information');
  }

  switch (major) {
    case 0:
      return { value: smallest(argument), end: cursor };
    case 1:
      return { value: smallest(-1n - argument), end: cursor };
    case 2:
    case 3: {
      const length = lengthOf(argument);
      if (cursor + length > bytes.length) throw new CborError('truncated string');
      const slice = copyOf(bytes, cursor, cursor + length);
      cursor += length;
      if (major === 2) return { value: slice, end: cursor };
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(slice);
      } catch {
        throw new CborError('text is not UTF-8');
      }
      return { value: text, end: cursor };
    }
    case 4: {
      const items: CborValue[] = [];
      for (let i = 0, n = lengthOf(argument); i < n; i++) {
        const item = decodeCbor(bytes, cursor, depth + 1);
        items.push(item.value);
        cursor = item.end;
      }
      return { value: items, end: cursor };
    }
    case 5: {
      const map = new Map<number | string, CborValue>();
      for (let i = 0, n = lengthOf(argument); i < n; i++) {
        const key = decodeCbor(bytes, cursor, depth + 1);
        if (typeof key.value !== 'number' && typeof key.value !== 'string') {
          throw new CborError('map key is neither an integer nor text');
        }
        if (map.has(key.value)) throw new CborError('duplicate map key');
        const item = decodeCbor(bytes, key.end, depth + 1);
        map.set(key.value, item.value);
        cursor = item.end;
      }
      return { value: map, end: cursor };
    }
    default:
      throw new CborError('tags are not supported');
  }
}

/** One complete item and nothing after it, or null. */
export function decodeCborOnce(bytes: Uint8Array): CborValue | null {
  try {
    const { value, end } = decodeCbor(bytes);
    return end === bytes.length ? value : null;
  } catch (error) {
    if (error instanceof CborError) return null;
    throw error;
  }
}

function byteAt(bytes: Uint8Array, offset: number): number {
  const byte = bytes[offset];
  if (byte === undefined) throw new CborError('truncated item');
  return byte;
}

function smallest(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

function lengthOf(argument: bigint): number {
  // Anything past the input is caught as truncation; this only keeps the number exact.
  if (argument > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('length out of range');
  return Number(argument);
}

function isMap(value: CborValue | undefined): value is ReadonlyMap<number | string, CborValue> {
  return value instanceof Map;
}

// ── authenticator data (§6.1) ─────────────────────────────────────────────────────────

export interface AuthenticatorFlags {
  /** UP: a human touched the authenticator. */
  readonly userPresent: boolean;
  /** UV: the authenticator verified who that human is (PIN, biometric). */
  readonly userVerified: boolean;
  /** BE: the credential may be synced (a multi-device passkey). */
  readonly backupEligible: boolean;
  /** BS: the credential is currently backed up. */
  readonly backedUp: boolean;
}

export interface AttestedCredential {
  readonly aaguid: Uint8Array;
  readonly credentialId: Uint8Array;
  /** The COSE_Key exactly as the authenticator encoded it; what the store keeps. */
  readonly publicKeyCose: Uint8Array;
}

export interface AuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly flags: AuthenticatorFlags;
  readonly signCount: number;
  readonly attestedCredential: AttestedCredential | null;
}

const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;

/** Null when the bytes are not well-formed authenticator data. */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData | null {
  if (bytes.length < 37) return null;
  const flagsByte = bytes[32] ?? 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signCount = view.getUint32(33);
  const flags: AuthenticatorFlags = {
    userPresent: (flagsByte & FLAG.UP) !== 0,
    userVerified: (flagsByte & FLAG.UV) !== 0,
    backupEligible: (flagsByte & FLAG.BE) !== 0,
    backedUp: (flagsByte & FLAG.BS) !== 0,
  };
  // §6.1.3: BS without BE is an invalid combination.
  if (flags.backedUp && !flags.backupEligible) return null;
  let cursor = 37;
  let attestedCredential: AttestedCredential | null = null;
  try {
    if ((flagsByte & FLAG.AT) !== 0) {
      if (cursor + 18 > bytes.length) return null;
      const aaguid = copyOf(bytes, cursor, cursor + 16);
      const idLength = view.getUint16(cursor + 16);
      cursor += 18;
      if (idLength === 0 || idLength > WEBAUTHN_POLICY.maxCredentialIdBytes) return null;
      if (cursor + idLength > bytes.length) return null;
      const credentialId = copyOf(bytes, cursor, cursor + idLength);
      cursor += idLength;
      const key = decodeCbor(bytes, cursor);
      if (!isMap(key.value)) return null;
      attestedCredential = { aaguid, credentialId, publicKeyCose: copyOf(bytes, cursor, key.end) };
      cursor = key.end;
    }
    if ((flagsByte & FLAG.ED) !== 0) {
      const extensions = decodeCbor(bytes, cursor);
      if (!isMap(extensions.value)) return null;
      cursor = extensions.end;
    }
  } catch (error) {
    if (error instanceof CborError) return null;
    throw error;
  }
  if (cursor !== bytes.length) return null;
  return { rpIdHash: copyOf(bytes, 0, 32), flags, signCount, attestedCredential };
}

// ── COSE keys (RFC 9052/9053) ─────────────────────────────────────────────────────────

export interface CosePublicKey {
  readonly algorithm: WebAuthnAlgorithm;
  readonly key: KeyObject;
}

/** Null for a key this module cannot or will not verify with. */
export function importCosePublicKey(cose: Uint8Array): CosePublicKey | null {
  const map = decodeCborOnce(cose);
  if (!isMap(map)) return null;
  const kty = map.get(1);
  const alg = map.get(3);
  if (!isWebAuthnAlgorithm(alg)) return null;
  const b64 = (value: CborValue | undefined): string | null =>
    value instanceof Uint8Array ? Buffer.from(value).toString('base64url') : null;
  try {
    if (alg === WEBAUTHN_ALGORITHMS.ES256) {
      const x = map.get(-2);
      const y = map.get(-3);
      if (kty !== 2 || map.get(-1) !== 1) return null;
      if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) return null;
      if (x.length !== 32 || y.length !== 32) return null;
      const key = createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: b64(x) ?? '', y: b64(y) ?? '' },
        format: 'jwk',
      });
      return { algorithm: alg, key };
    }
    if (alg === WEBAUTHN_ALGORITHMS.EdDSA) {
      const x = map.get(-2);
      if (kty !== 1 || map.get(-1) !== 6) return null;
      if (!(x instanceof Uint8Array) || x.length !== 32) return null;
      const key = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: b64(x) ?? '' },
        format: 'jwk',
      });
      return { algorithm: alg, key };
    }
    const n = map.get(-1);
    const e = map.get(-2);
    if (kty !== 3 || !(n instanceof Uint8Array) || !(e instanceof Uint8Array)) return null;
    const key = createPublicKey({
      key: { kty: 'RSA', n: b64(n) ?? '', e: b64(e) ?? '' },
      format: 'jwk',
    });
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < WEBAUTHN_POLICY.minRsaModulusBits) return null;
    return { algorithm: alg, key };
  } catch {
    // createPublicKey refuses a point off the curve or a malformed modulus.
    return null;
  }
}

function verifySignature(
  publicKey: CosePublicKey,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    if (publicKey.algorithm === WEBAUTHN_ALGORITHMS.EdDSA) {
      return verify(null, data, publicKey.key, signature);
    }
    // ES256 signatures are ASN.1 DER (§6.5.6), node's default `dsaEncoding`; RS256 is
    // RSASSA-PKCS1-v1_5, node's default RSA padding.
    return verify('sha256', data, publicKey.key, signature);
  } catch {
    return false;
  }
}

// ── ceremonies (§7.1, §7.2) ───────────────────────────────────────────────────────────

/** What the relying party expects, fixed per deployment. */
export interface WebAuthnRelyingParty {
  /** The RP ID: the staff host's registrable domain, e.g. `staff.example.org`. */
  readonly rpId: string;
  /** Exact origins the staff app is served from, e.g. `https://staff.example.org`. */
  readonly origins: readonly string[];
  /**
   * `required` refuses an authenticator that did not verify the user (no PIN or
   * biometric). `preferred` accepts presence alone — a bare security key is still a
   * possession factor on top of the first one.
   */
  readonly userVerification: 'required' | 'preferred';
}

export type WebAuthnRefusal =
  | 'malformed'
  | 'wrong_ceremony'
  | 'challenge_mismatch'
  | 'origin_mismatch'
  | 'cross_origin'
  | 'rp_id_mismatch'
  | 'user_not_present'
  | 'user_not_verified'
  | 'unsupported_attestation'
  | 'unsupported_algorithm'
  | 'bad_signature'
  | 'counter_regressed';

export interface RegisteredCredential {
  readonly credentialId: Uint8Array;
  readonly publicKeyCose: Uint8Array;
  readonly algorithm: WebAuthnAlgorithm;
  readonly signCount: number;
  readonly backupEligible: boolean;
  readonly userVerified: boolean;
}

export type RegistrationVerdict =
  | { readonly kind: 'accepted'; readonly credential: RegisteredCredential }
  | { readonly kind: 'refused'; readonly reason: WebAuthnRefusal };

export type AssertionVerdict =
  | {
      readonly kind: 'accepted';
      /** Persist with the store's compare-and-set, or the clone check is advisory. */
      readonly signCount: number;
      readonly userVerified: boolean;
      readonly backedUp: boolean;
    }
  | { readonly kind: 'refused'; readonly reason: WebAuthnRefusal };

const refused = (reason: WebAuthnRefusal) => ({ kind: 'refused', reason }) as const;

/** §7.1 steps 5–14 / §7.2 steps 10–15: the collected client data. */
function checkClientData(
  clientDataJSON: Uint8Array,
  type: 'webauthn.create' | 'webauthn.get',
  expectedChallenge: Uint8Array,
  rp: WebAuthnRelyingParty,
): WebAuthnRefusal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataJSON));
  } catch {
    return 'malformed';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'malformed';
  const data = parsed as {
    readonly type?: unknown;
    readonly challenge?: unknown;
    readonly origin?: unknown;
    readonly crossOrigin?: unknown;
    readonly topOrigin?: unknown;
  };
  if (typeof data.type !== 'string' || typeof data.challenge !== 'string') return 'malformed';
  if (typeof data.origin !== 'string') return 'malformed';
  if (data.type !== type) return 'wrong_ceremony';
  const challenge = base64UrlDecode(data.challenge);
  if (challenge === null) return 'malformed';
  if (!sameBytes(challenge, expectedChallenge)) return 'challenge_mismatch';
  if (!rp.origins.includes(data.origin)) return 'origin_mismatch';
  // The staff app is never embedded in another site's iframe.
  if (data.crossOrigin === true || data.topOrigin !== undefined) return 'cross_origin';
  return null;
}

function checkAuthenticatorData(
  authData: AuthenticatorData,
  rp: WebAuthnRelyingParty,
): WebAuthnRefusal | null {
  if (!sameBytes(authData.rpIdHash, sha256(new TextEncoder().encode(rp.rpId)))) {
    return 'rp_id_mismatch';
  }
  if (!authData.flags.userPresent) return 'user_not_present';
  if (rp.userVerification === 'required' && !authData.flags.userVerified) {
    return 'user_not_verified';
  }
  return null;
}

/** §7.1: verifies `navigator.credentials.create()`'s response for a new credential. */
export function verifyRegistration(input: {
  readonly clientDataJSON: Uint8Array;
  readonly attestationObject: Uint8Array;
  readonly expectedChallenge: Uint8Array;
  readonly rp: WebAuthnRelyingParty;
}): RegistrationVerdict {
  const clientProblem = checkClientData(
    input.clientDataJSON,
    'webauthn.create',
    input.expectedChallenge,
    input.rp,
  );
  if (clientProblem !== null) return refused(clientProblem);

  const attestation = decodeCborOnce(input.attestationObject);
  if (!isMap(attestation)) return refused('malformed');
  const fmt = attestation.get('fmt');
  const attStmt = attestation.get('attStmt');
  const rawAuthData = attestation.get('authData');
  if (typeof fmt !== 'string' || !isMap(attStmt) || !(rawAuthData instanceof Uint8Array)) {
    return refused('malformed');
  }
  if (fmt !== 'none' || attStmt.size !== 0) return refused('unsupported_attestation');

  const authData = parseAuthenticatorData(rawAuthData);
  if (authData === null) return refused('malformed');
  const authProblem = checkAuthenticatorData(authData, input.rp);
  if (authProblem !== null) return refused(authProblem);
  const attested = authData.attestedCredential;
  if (attested === null) return refused('malformed');

  const publicKey = importCosePublicKey(attested.publicKeyCose);
  if (publicKey === null) return refused('unsupported_algorithm');

  return {
    kind: 'accepted',
    credential: {
      credentialId: attested.credentialId,
      publicKeyCose: attested.publicKeyCose,
      algorithm: publicKey.algorithm,
      signCount: authData.signCount,
      backupEligible: authData.flags.backupEligible,
      userVerified: authData.flags.userVerified,
    },
  };
}

/**
 * §6.1.1's signature counter rule: when either side is non-zero the new count must be
 * strictly greater, otherwise the authenticator may have been cloned. Synced passkeys
 * report 0 forever, which is allowed exactly while the stored count is 0 too.
 */
export function signCountAdvances(stored: number, received: number): boolean {
  if (stored === 0 && received === 0) return true;
  return received > stored;
}

/** §7.2: verifies `navigator.credentials.get()`'s response against a stored credential. */
export function verifyAssertion(input: {
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly signature: Uint8Array;
  readonly expectedChallenge: Uint8Array;
  readonly rp: WebAuthnRelyingParty;
  readonly credential: { readonly publicKeyCose: Uint8Array; readonly signCount: number };
}): AssertionVerdict {
  const clientProblem = checkClientData(
    input.clientDataJSON,
    'webauthn.get',
    input.expectedChallenge,
    input.rp,
  );
  if (clientProblem !== null) return refused(clientProblem);

  const authData = parseAuthenticatorData(input.authenticatorData);
  // An assertion carries no attested credential data (§6.1: AT is set only by create).
  if (authData === null || authData.attestedCredential !== null) return refused('malformed');
  const authProblem = checkAuthenticatorData(authData, input.rp);
  if (authProblem !== null) return refused(authProblem);

  const publicKey = importCosePublicKey(input.credential.publicKeyCose);
  if (publicKey === null) return refused('unsupported_algorithm');
  const signed = Buffer.concat([input.authenticatorData, sha256(input.clientDataJSON)]);
  if (!verifySignature(publicKey, signed, input.signature)) return refused('bad_signature');

  if (!signCountAdvances(input.credential.signCount, authData.signCount)) {
    return refused('counter_regressed');
  }
  return {
    kind: 'accepted',
    signCount: authData.signCount,
    userVerified: authData.flags.userVerified,
    backedUp: authData.flags.backedUp,
  };
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A plain Uint8Array copy, so a Buffer input never leaks Buffer outputs. */
function copyOf(bytes: Uint8Array, start: number, end: number): Uint8Array {
  return Uint8Array.from(bytes.subarray(start, end));
}
