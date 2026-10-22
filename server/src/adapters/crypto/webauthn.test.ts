import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  base64UrlDecode,
  base64UrlEncode,
  decodeCborOnce,
  generateWebAuthnChallenge,
  importCosePublicKey,
  parseAuthenticatorData,
  signCountAdvances,
  verifyAssertion,
  verifyRegistration,
  WEBAUTHN_ALGORITHMS,
  type CborValue,
  type WebAuthnRelyingParty,
} from './webauthn.js';

// ── a minimal CBOR encoder, the inverse of the decoder's subset ──────────────────────

type Encodable =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | readonly Encodable[]
  | ReadonlyMap<number | string, Encodable>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

function cbor(value: Encodable): Buffer {
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    const entries = value as ReadonlyMap<number | string, Encodable>;
    for (const [k, v] of entries) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  const items = value as readonly Encodable[];
  return Buffer.concat([head(4, items.length), ...items.map(cbor)]);
}

// ── an in-test authenticator ──────────────────────────────────────────────────────────

const RP: WebAuthnRelyingParty = {
  rpId: 'staff.example.org',
  origins: ['https://staff.example.org'],
  userVerification: 'required',
};
const CHALLENGE = new Uint8Array(32).fill(7);
const CREDENTIAL_ID = new Uint8Array(16).fill(0xc1);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();

type Kind = 'ES256' | 'EdDSA' | 'RS256';

function keyPair(kind: Kind): { privateKey: KeyObject; cose: Buffer } {
  if (kind === 'ES256') {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = cbor(
      new Map<number, Encodable>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? '', 'base64url')],
        [-3, Buffer.from(jwk.y ?? '', 'base64url')],
      ]),
    );
    return { privateKey, cose };
  }
  if (kind === 'EdDSA') {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = cbor(
      new Map<number, Encodable>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, Buffer.from(jwk.x ?? '', 'base64url')],
      ]),
    );
    return { privateKey, cose };
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = cbor(
    new Map<number, Encodable>([
      [1, 3],
      [3, -257],
      [-1, Buffer.from(jwk.n ?? '', 'base64url')],
      [-2, Buffer.from(jwk.e ?? '', 'base64url')],
    ]),
  );
  return { privateKey, cose };
}

const KEYS = { ES256: keyPair('ES256'), EdDSA: keyPair('EdDSA'), RS256: keyPair('RS256') };

function authData(options: {
  readonly rpId?: string;
  readonly flags?: number;
  readonly signCount?: number;
  readonly attested?: { readonly cose: Uint8Array; readonly id?: Uint8Array };
  readonly extensions?: Encodable;
}): Buffer {
  let flags = options.flags ?? 0x01 | 0x04;
  if (options.attested) flags |= 0x40;
  if (options.extensions !== undefined) flags |= 0x80;
  const fixed = Buffer.alloc(37);
  sha256(Buffer.from(options.rpId ?? RP.rpId)).copy(fixed, 0);
  fixed[32] = flags;
  fixed.writeUInt32BE(options.signCount ?? 0, 33);
  const parts: Buffer[] = [fixed];
  if (options.attested) {
    const id = options.attested.id ?? CREDENTIAL_ID;
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    parts.push(Buffer.alloc(16), length, Buffer.from(id), Buffer.from(options.attested.cose));
  }
  if (options.extensions !== undefined) parts.push(cbor(options.extensions));
  return Buffer.concat(parts);
}

function clientData(fields: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: base64UrlEncode(CHALLENGE),
      origin: RP.origins[0],
      crossOrigin: false,
      ...fields,
    }),
  );
}

function attestation(auth: Buffer, fmt = 'none', attStmt = new Map<string, Encodable>()) {
  return cbor(
    new Map<string, Encodable>([
      ['fmt', fmt],
      ['attStmt', attStmt],
      ['authData', auth],
    ]),
  );
}

function register(overrides: { clientDataJSON?: Buffer; attestationObject?: Buffer } = {}) {
  return verifyRegistration({
    clientDataJSON: overrides.clientDataJSON ?? clientData(),
    attestationObject:
      overrides.attestationObject ?? attestation(authData({ attested: { cose: KEYS.ES256.cose } })),
    expectedChallenge: CHALLENGE,
    rp: RP,
  });
}

function assertWith(
  kind: Kind,
  options: {
    readonly signCount?: number;
    readonly stored?: number;
    readonly flags?: number;
    readonly clientData?: Buffer;
    readonly rp?: WebAuthnRelyingParty;
    readonly tamper?: (signature: Buffer) => Buffer;
  } = {},
) {
  const { privateKey, cose } = KEYS[kind];
  const auth = authData({
    signCount: options.signCount ?? 5,
    ...(options.flags === undefined ? {} : { flags: options.flags }),
  });
  const client = options.clientData ?? clientData({ type: 'webauthn.get' });
  const signed = Buffer.concat([auth, sha256(client)]);
  const signature = sign(kind === 'EdDSA' ? null : 'sha256', signed, privateKey);
  return verifyAssertion({
    clientDataJSON: client,
    authenticatorData: auth,
    signature: options.tamper ? options.tamper(signature) : signature,
    expectedChallenge: CHALLENGE,
    rp: options.rp ?? RP,
    credential: { publicKeyCose: cose, signCount: options.stored ?? 4 },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────────────

describe('decodeCborOnce', () => {
  it('reads RFC 8949 Appendix A examples in the CTAP2 subset', () => {
    const hex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
    expect(decodeCborOnce(hex('00'))).toBe(0);
    expect(decodeCborOnce(hex('1903e8'))).toBe(1000);
    expect(decodeCborOnce(hex('1a000f4240'))).toBe(1000000);
    expect(decodeCborOnce(hex('1bffffffffffffffff'))).toBe(18446744073709551615n);
    expect(decodeCborOnce(hex('3863'))).toBe(-100);
    expect(decodeCborOnce(hex('6449455446'))).toBe('IETF');
    expect(decodeCborOnce(hex('4401020304'))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(decodeCborOnce(hex('83010203'))).toEqual([1, 2, 3]);
    expect(decodeCborOnce(hex('a201020304'))).toEqual(
      new Map<number, CborValue>([
        [1, 2],
        [3, 4],
      ]),
    );
    expect(decodeCborOnce(hex('f4'))).toBe(false);
    expect(decodeCborOnce(hex('f6'))).toBe(null);
  });

  it('refuses indefinite lengths, tags, floats, duplicate keys, bad UTF-8 and trailing bytes', () => {
    const hex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
    expect(decodeCborOnce(hex('9f01ff'))).toBeNull(); // indefinite array
    expect(decodeCborOnce(hex('c11a514b67b0'))).toBeNull(); // tag 1
    expect(decodeCborOnce(hex('f93c00'))).toBeNull(); // half float
    expect(decodeCborOnce(hex('a201020103'))).toBeNull(); // key 1 twice
    expect(decodeCborOnce(hex('62c328'))).toBeNull(); // invalid UTF-8
    expect(decodeCborOnce(hex('0000'))).toBeNull(); // trailing byte
    expect(decodeCborOnce(hex('5a00000005'))).toBeNull(); // truncated bytes
    expect(decodeCborOnce(hex(''))).toBeNull();
    const deep = new Uint8Array(40).fill(0x81);
    expect(decodeCborOnce(deep)).toBeNull();
  });
});

describe('base64url and challenges', () => {
  it('round-trips and refuses padding or foreign characters', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x10]);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    expect(base64UrlDecode('+/8=')).toBeNull();
    expect(base64UrlDecode('a')).toBeNull();
  });

  it('draws 32 random bytes for a challenge', () => {
    const challenge = generateWebAuthnChallenge((n) => new Uint8Array(n).fill(9));
    expect(challenge).toEqual(new Uint8Array(32).fill(9));
  });
});

describe('parseAuthenticatorData', () => {
  it('reads flags, counter, attested credential and extensions', () => {
    const parsed = parseAuthenticatorData(
      authData({
        flags: 0x01 | 0x04 | 0x08 | 0x10,
        signCount: 0x01020304,
        attested: { cose: KEYS.EdDSA.cose },
        extensions: new Map<string, Encodable>([['credProtect', 2]]),
      }),
    );
    expect(parsed?.flags).toEqual({
      userPresent: true,
      userVerified: true,
      backupEligible: true,
      backedUp: true,
    });
    expect(parsed?.signCount).toBe(0x01020304);
    expect(parsed?.attestedCredential?.credentialId).toEqual(CREDENTIAL_ID);
    expect(parsed?.attestedCredential?.publicKeyCose).toEqual(new Uint8Array(KEYS.EdDSA.cose));
  });

  it('refuses short data, BS without BE, an empty credential id and trailing bytes', () => {
    expect(parseAuthenticatorData(new Uint8Array(36))).toBeNull();
    expect(parseAuthenticatorData(authData({ flags: 0x01 | 0x10 }))).toBeNull();
    expect(
      parseAuthenticatorData(
        authData({ attested: { cose: KEYS.ES256.cose, id: new Uint8Array() } }),
      ),
    ).toBeNull();
    expect(parseAuthenticatorData(Buffer.concat([authData({}), Buffer.from([0])]))).toBeNull();
  });
});

describe('importCosePublicKey', () => {
  it('imports the three supported algorithms', () => {
    expect(importCosePublicKey(KEYS.ES256.cose)?.algorithm).toBe(WEBAUTHN_ALGORITHMS.ES256);
    expect(importCosePublicKey(KEYS.EdDSA.cose)?.algorithm).toBe(WEBAUTHN_ALGORITHMS.EdDSA);
    expect(importCosePublicKey(KEYS.RS256.cose)?.algorithm).toBe(WEBAUTHN_ALGORITHMS.RS256);
  });

  it('refuses another algorithm, a point off the curve, a mismatched kty and short RSA', () => {
    const es384 = cbor(
      new Map<number, Encodable>([
        [1, 2],
        [3, -35],
        [-1, 2],
      ]),
    );
    expect(importCosePublicKey(es384)).toBeNull();
    const offCurve = cbor(
      new Map<number, Encodable>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(32).fill(1)],
        [-3, new Uint8Array(32).fill(2)],
      ]),
    );
    expect(importCosePublicKey(offCurve)).toBeNull();
    const decoded = decodeCborOnce(KEYS.EdDSA.cose) as Map<number, Encodable>;
    expect(importCosePublicKey(cbor(new Map([...decoded, [1, 2]])))).toBeNull();
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const jwk = publicKey.export({ format: 'jwk' });
    const shortRsa = cbor(
      new Map<number, Encodable>([
        [1, 3],
        [3, -257],
        [-1, Buffer.from(jwk.n ?? '', 'base64url')],
        [-2, Buffer.from(jwk.e ?? '', 'base64url')],
      ]),
    );
    expect(importCosePublicKey(shortRsa)).toBeNull();
  });
});

describe('verifyRegistration', () => {
  it('accepts a none-attestation credential and returns what the store keeps', () => {
    const verdict = register({
      attestationObject: attestation(
        authData({ flags: 0x01 | 0x04 | 0x08, signCount: 0, attested: { cose: KEYS.ES256.cose } }),
      ),
    });
    expect(verdict).toEqual({
      kind: 'accepted',
      credential: {
        credentialId: CREDENTIAL_ID,
        publicKeyCose: new Uint8Array(KEYS.ES256.cose),
        algorithm: -7,
        signCount: 0,
        backupEligible: true,
        userVerified: true,
      },
    });
  });

  it.each([
    ['wrong_ceremony', { clientDataJSON: clientData({ type: 'webauthn.get' }) }],
    [
      'challenge_mismatch',
      { clientDataJSON: clientData({ challenge: base64UrlEncode(new Uint8Array(32)) }) },
    ],
    ['origin_mismatch', { clientDataJSON: clientData({ origin: 'https://evil.example' }) }],
    ['cross_origin', { clientDataJSON: clientData({ crossOrigin: true }) }],
    ['malformed', { clientDataJSON: Buffer.from('not json') }],
    ['malformed', { clientDataJSON: clientData({ challenge: 'a+b=' }) }],
    [
      'rp_id_mismatch',
      {
        attestationObject: attestation(
          authData({ rpId: 'example.org', attested: { cose: KEYS.ES256.cose } }),
        ),
      },
    ],
    [
      'user_not_present',
      {
        attestationObject: attestation(
          authData({ flags: 0x04, attested: { cose: KEYS.ES256.cose } }),
        ),
      },
    ],
    [
      'user_not_verified',
      {
        attestationObject: attestation(
          authData({ flags: 0x01, attested: { cose: KEYS.ES256.cose } }),
        ),
      },
    ],
    [
      'unsupported_attestation',
      {
        attestationObject: attestation(
          authData({ attested: { cose: KEYS.ES256.cose } }),
          'packed',
          new Map<string, Encodable>([['alg', -7]]),
        ),
      },
    ],
    [
      'unsupported_attestation',
      {
        attestationObject: attestation(
          authData({ attested: { cose: KEYS.ES256.cose } }),
          'none',
          new Map<string, Encodable>([['x', 1]]),
        ),
      },
    ],
    [
      'unsupported_algorithm',
      {
        attestationObject: attestation(
          authData({
            attested: {
              cose: cbor(
                new Map<number, Encodable>([
                  [1, 2],
                  [3, -35],
                ]),
              ),
            },
          }),
        ),
      },
    ],
    ['malformed', { attestationObject: attestation(authData({})) }],
  ] as const)('refuses %s', (reason, overrides) => {
    expect(register(overrides)).toEqual({ kind: 'refused', reason });
  });
});

describe('verifyAssertion', () => {
  it.each(['ES256', 'EdDSA', 'RS256'] as const)('accepts a valid %s assertion', (kind) => {
    expect(assertWith(kind)).toEqual({
      kind: 'accepted',
      signCount: 5,
      userVerified: true,
      backedUp: false,
    });
  });

  it('accepts presence alone when user verification is only preferred', () => {
    const verdict = assertWith('ES256', {
      flags: 0x01,
      rp: { ...RP, userVerification: 'preferred' },
    });
    expect(verdict.kind).toBe('accepted');
    expect(assertWith('ES256', { flags: 0x01 })).toEqual({
      kind: 'refused',
      reason: 'user_not_verified',
    });
  });

  it('refuses a tampered signature, a create ceremony, another origin and a replayed counter', () => {
    const flip = (s: Buffer) => {
      const copy = Buffer.from(s);
      copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 1;
      return copy;
    };
    expect(assertWith('ES256', { tamper: flip })).toEqual({
      kind: 'refused',
      reason: 'bad_signature',
    });
    expect(assertWith('EdDSA', { tamper: flip })).toEqual({
      kind: 'refused',
      reason: 'bad_signature',
    });
    expect(assertWith('RS256', { tamper: flip })).toEqual({
      kind: 'refused',
      reason: 'bad_signature',
    });
    expect(assertWith('ES256', { clientData: clientData() })).toEqual({
      kind: 'refused',
      reason: 'wrong_ceremony',
    });
    expect(
      assertWith('ES256', {
        clientData: clientData({ type: 'webauthn.get', origin: 'https://example.org' }),
      }),
    ).toEqual({ kind: 'refused', reason: 'origin_mismatch' });
    expect(assertWith('ES256', { signCount: 4, stored: 4 })).toEqual({
      kind: 'refused',
      reason: 'counter_regressed',
    });
  });

  it('accepts a synced passkey that reports a zero counter while the stored one is zero', () => {
    expect(assertWith('EdDSA', { signCount: 0, stored: 0 }).kind).toBe('accepted');
    expect(assertWith('EdDSA', { signCount: 0, stored: 3 })).toEqual({
      kind: 'refused',
      reason: 'counter_regressed',
    });
  });

  it('refuses authenticator data that carries an attested credential', () => {
    const { privateKey, cose } = KEYS.ES256;
    const auth = authData({ signCount: 9, attested: { cose } });
    const client = clientData({ type: 'webauthn.get' });
    const signature = sign('sha256', Buffer.concat([auth, sha256(client)]), privateKey);
    expect(
      verifyAssertion({
        clientDataJSON: client,
        authenticatorData: auth,
        signature,
        expectedChallenge: CHALLENGE,
        rp: RP,
        credential: { publicKeyCose: cose, signCount: 0 },
      }),
    ).toEqual({ kind: 'refused', reason: 'malformed' });
  });
});

describe('signCountAdvances', () => {
  it('follows §6.1.1', () => {
    expect(signCountAdvances(0, 0)).toBe(true);
    expect(signCountAdvances(0, 1)).toBe(true);
    expect(signCountAdvances(5, 6)).toBe(true);
    expect(signCountAdvances(5, 5)).toBe(false);
    expect(signCountAdvances(5, 0)).toBe(false);
  });
});
