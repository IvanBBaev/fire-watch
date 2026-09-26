import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAX_PUSH_BODY_BYTES,
  MAX_PUSH_PLAINTEXT_BYTES,
  encryptForSubscription,
} from './encrypt.js';

const b64u = (text: string): Buffer => Buffer.from(text, 'base64url');

/**
 * RFC 8291 Appendix A, verbatim. If this vector ever fails, no browser will decrypt a
 * single alert, and the failure would otherwise be visible only on a physical device
 * (GATES L-5).
 */
const VECTOR = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: b64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'),
  uaPublic: b64u(
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  ),
  auth: b64u('BTBZMqHH6r4Tts7J_aSIgg'),
  asPrivate: b64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  asPublic: b64u(
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ),
  salt: b64u('DGv6ra1nlYgDCS1FRnbzlw'),
  body: b64u(
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  ),
};

/**
 * The receiving side, written from the RFCs independently of `encrypt.ts` — what a
 * browser does with the body. Round-tripping through it is what lets the random-key
 * production path be tested at all.
 */
function decryptAsBrowser(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey(null, 'uncompressed');
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
  // Strip the delimiter and any zero padding after it.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  expect(padded[end]).toBe(0x02);
  return padded.subarray(0, end);
}

describe('encryptForSubscription', () => {
  it('reproduces RFC 8291 Appendix A byte for byte', () => {
    const body = encryptForSubscription(
      Buffer.from(VECTOR.plaintext, 'utf8'),
      { p256dh: VECTOR.uaPublic, auth: VECTOR.auth },
      { salt: VECTOR.salt, ephemeralPrivateKey: VECTOR.asPrivate },
    );
    expect(body.toString('base64url')).toBe(VECTOR.body.toString('base64url'));
    expect(body.subarray(21, 86).equals(VECTOR.asPublic)).toBe(true);
  });

  it('round-trips through a browser-side decryption with random salt and key', () => {
    const plaintext = Buffer.from(
      JSON.stringify({ title: 'Пожар до Ракитово', body: 'x', footer: 'y', url: '/event/1' }),
      'utf8',
    );
    const first = encryptForSubscription(plaintext, { p256dh: VECTOR.uaPublic, auth: VECTOR.auth });
    const second = encryptForSubscription(plaintext, {
      p256dh: VECTOR.uaPublic,
      auth: VECTOR.auth,
    });

    expect(decryptAsBrowser(first, VECTOR.uaPrivate, VECTOR.auth).equals(plaintext)).toBe(true);
    expect(decryptAsBrowser(second, VECTOR.uaPrivate, VECTOR.auth).equals(plaintext)).toBe(true);
    // A fresh salt and ephemeral key per message: two encryptions of one alert differ.
    expect(first.equals(second)).toBe(false);
  });

  it('fits exactly the largest allowed plaintext into the 4096-byte body cap', () => {
    const plaintext = Buffer.alloc(MAX_PUSH_PLAINTEXT_BYTES, 0x41);
    const body = encryptForSubscription(plaintext, { p256dh: VECTOR.uaPublic, auth: VECTOR.auth });
    expect(body.length).toBe(MAX_PUSH_BODY_BYTES);
    expect(decryptAsBrowser(body, VECTOR.uaPrivate, VECTOR.auth).equals(plaintext)).toBe(true);
  });

  it('refuses a plaintext one byte over the cap before touching the network', () => {
    const plaintext = Buffer.alloc(MAX_PUSH_PLAINTEXT_BYTES + 1, 0x41);
    expect(() =>
      encryptForSubscription(plaintext, { p256dh: VECTOR.uaPublic, auth: VECTOR.auth }),
    ).toThrow(RangeError);
  });

  it('refuses malformed subscription keys', () => {
    const plaintext = Buffer.from('x');
    expect(() =>
      encryptForSubscription(plaintext, { p256dh: VECTOR.uaPublic.subarray(1), auth: VECTOR.auth }),
    ).toThrow(/p256dh/);
    expect(() =>
      encryptForSubscription(plaintext, { p256dh: VECTOR.uaPublic, auth: VECTOR.auth.subarray(1) }),
    ).toThrow(/auth/);
    // A point that is not on the curve is rejected by the ECDH itself, not silently used.
    const offCurve = Buffer.from(VECTOR.uaPublic);
    offCurve[10] = (offCurve[10] ?? 0) ^ 0xff;
    expect(() =>
      encryptForSubscription(plaintext, { p256dh: offCurve, auth: VECTOR.auth }),
    ).toThrow();
  });
});
