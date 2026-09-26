import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { VAPID_TOKEN_TTL_MS, createVapidSigner, vapidAudience } from './vapid.js';

/** A throwaway P-256 pair in the raw base64url form the env carries. */
function freshKeys(): { publicKey: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  return {
    publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url'),
    privateKey: jwk.d ?? '',
  };
}

const NOW = 1_758_200_000_000; // 2025-09-18T12:53:20Z, arbitrary
const SUBJECT = 'mailto:alerts@example.invalid';

function parseAuthorization(header: string) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  if (match === null) throw new Error(`not a VAPID header: ${header}`);
  const [, token = '', k = ''] = match;
  const [h = '', c = '', s = ''] = token.split('.');
  return {
    token,
    k,
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>,
    signingInput: `${h}.${c}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

describe('createVapidSigner', () => {
  it('produces an ES256 JWT a push service can verify against the public key', () => {
    const keys = freshKeys();
    const signer = createVapidSigner({ ...keys, subject: SUBJECT });
    const parsed = parseAuthorization(signer.authorizationFor('https://fcm.googleapis.com', NOW));

    expect(parsed.header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(parsed.claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor((NOW + VAPID_TOKEN_TTL_MS) / 1000),
      sub: SUBJECT,
    });
    expect(parsed.k).toBe(keys.publicKey);
    // JWS signatures are r || s, 64 bytes — the DER form would be 70–72 and rejected.
    expect(parsed.signature.length).toBe(64);

    const raw = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(parsed.signingInput, 'utf8'),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        parsed.signature,
      ),
    ).toBe(true);
  });

  it('keeps the token under RFC 8292 §2 24-hour cap', () => {
    expect(VAPID_TOKEN_TTL_MS).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('reuses a token per audience while it is fresh and reissues once it is half spent', () => {
    const signer = createVapidSigner({ ...freshKeys(), subject: SUBJECT });
    const a1 = signer.authorizationFor('https://fcm.googleapis.com', NOW);
    const a2 = signer.authorizationFor('https://fcm.googleapis.com', NOW + 3_600_000);
    const b1 = signer.authorizationFor('https://updates.push.services.mozilla.com', NOW);
    const a3 = signer.authorizationFor('https://fcm.googleapis.com', NOW + 7 * 3_600_000);

    expect(a2).toBe(a1);
    expect(b1).not.toBe(a1);
    expect(parseAuthorization(b1).claims['aud']).toBe('https://updates.push.services.mozilla.com');
    expect(a3).not.toBe(a1);
    expect(parseAuthorization(a3).claims['exp']).toBe(
      Math.floor((NOW + 7 * 3_600_000 + VAPID_TOKEN_TTL_MS) / 1000),
    );
  });

  it('rejects a public key that is not the private key’s, at construction', () => {
    const a = freshKeys();
    const b = freshKeys();
    expect(() =>
      createVapidSigner({ publicKey: a.publicKey, privateKey: b.privateKey, subject: SUBJECT }),
    ).toThrow(/does not belong/);
  });

  it('rejects keys of the wrong shape and a subject that is not a contact', () => {
    const keys = freshKeys();
    expect(() =>
      createVapidSigner({ ...keys, privateKey: keys.privateKey.slice(4), subject: SUBJECT }),
    ).toThrow(/32 bytes/);
    expect(() =>
      createVapidSigner({ ...keys, publicKey: keys.publicKey.slice(2), subject: SUBJECT }),
    ).toThrow(/65-byte/);
    expect(() =>
      createVapidSigner({ ...keys, publicKey: 'not+base64url/', subject: SUBJECT }),
    ).toThrow(/base64url/);
    expect(() => createVapidSigner({ ...keys, subject: 'alerts@example.invalid' })).toThrow(
      /subject/,
    );
    expect(() => createVapidSigner({ ...keys, subject: 'http://example.invalid' })).toThrow(
      /subject/,
    );
    expect(() => createVapidSigner({ ...keys, subject: 'https://example.invalid' })).not.toThrow();
  });

  it('never exposes the private key on the signer', () => {
    const keys = freshKeys();
    const signer = createVapidSigner({ ...keys, subject: SUBJECT });
    expect(JSON.stringify(signer)).not.toContain(keys.privateKey);
    expect(Object.keys(signer)).toEqual(['publicKey', 'authorizationFor']);
  });
});

describe('vapidAudience', () => {
  it('is the origin of the endpoint and nothing more', () => {
    expect(vapidAudience('https://fcm.googleapis.com/fcm/send/abc:def?x=1')).toBe(
      'https://fcm.googleapis.com',
    );
    expect(vapidAudience('https://web.push.apple.com:443/QWxs')).toBe('https://web.push.apple.com');
  });

  it('throws on something that is not a URL — the adapter turns that into permanent', () => {
    expect(() => vapidAudience('not a url')).toThrow();
  });
});
