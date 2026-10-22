import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  hotp,
  normalizeRecoveryCode,
  otpauthUri,
  totpStep,
  verifyTotp,
  type TotpAlgorithm,
} from './totp.js';

const ascii = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'ascii'));
const SHA1_SECRET = ascii('12345678901234567890');

describe('RFC 4226 Appendix D: HOTP', () => {
  it('produces the ten published values', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expect(expected.map((_, counter) => hotp(SHA1_SECRET, counter))).toEqual(expected);
  });
});

describe('RFC 6238 Appendix B: TOTP, 8 digits', () => {
  const secrets: Record<TotpAlgorithm, Uint8Array> = {
    sha1: SHA1_SECRET,
    sha256: ascii('12345678901234567890123456789012'),
    sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const vectors: readonly [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  it.each(vectors)('at %i s', (seconds, sha1, sha256, sha512) => {
    const step = totpStep(seconds * 1000);
    expect(hotp(secrets.sha1, step, { digits: 8, algorithm: 'sha1' })).toBe(sha1);
    expect(hotp(secrets.sha256, step, { digits: 8, algorithm: 'sha256' })).toBe(sha256);
    expect(hotp(secrets.sha512, step, { digits: 8, algorithm: 'sha512' })).toBe(sha512);
  });
});

describe('verifyTotp', () => {
  const AT = 1_111_111_111_000;
  const now = totpStep(AT);
  const codeAt = (step: number): string => hotp(SHA1_SECRET, step);

  it('accepts the current code and returns its step', () => {
    expect(
      verifyTotp({ secret: SHA1_SECRET, code: codeAt(now), atMs: AT, lastUsedStep: null }),
    ).toEqual({ kind: 'accepted', step: now });
  });

  it('tolerates one step of drift either way, and no more', () => {
    for (const step of [now - 1, now + 1]) {
      expect(
        verifyTotp({ secret: SHA1_SECRET, code: codeAt(step), atMs: AT, lastUsedStep: null }),
      ).toEqual({ kind: 'accepted', step });
    }
    for (const step of [now - 2, now + 2]) {
      expect(
        verifyTotp({ secret: SHA1_SECRET, code: codeAt(step), atMs: AT, lastUsedStep: null }),
      ).toEqual({ kind: 'refused', reason: 'wrong_code' });
    }
  });

  it('refuses a code whose step was already used, and any earlier step', () => {
    expect(
      verifyTotp({ secret: SHA1_SECRET, code: codeAt(now), atMs: AT, lastUsedStep: now }),
    ).toEqual({ kind: 'refused', reason: 'replayed' });
    expect(
      verifyTotp({ secret: SHA1_SECRET, code: codeAt(now - 1), atMs: AT, lastUsedStep: now }),
    ).toEqual({ kind: 'refused', reason: 'replayed' });
    expect(
      verifyTotp({ secret: SHA1_SECRET, code: codeAt(now), atMs: AT, lastUsedStep: now - 1 }),
    ).toEqual({ kind: 'accepted', step: now });
  });

  it('refuses malformed input before computing anything', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 5x']) {
      expect(verifyTotp({ secret: SHA1_SECRET, code, atMs: AT, lastUsedStep: null })).toEqual({
        kind: 'refused',
        reason: 'malformed',
      });
    }
  });

  it('ignores spaces an app inserts for readability', () => {
    const spaced = `${codeAt(now).slice(0, 3)} ${codeAt(now).slice(3)}`;
    expect(
      verifyTotp({ secret: SHA1_SECRET, code: spaced, atMs: AT, lastUsedStep: null }).kind,
    ).toBe('accepted');
  });
});

describe('base32 (RFC 4648 §10)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('%j ↔ %s', (plain, encoded) => {
    expect(base32Encode(ascii(plain))).toBe(encoded);
    expect(Buffer.from(base32Decode(encoded) ?? []).toString('ascii')).toBe(plain);
  });

  it('decodes padded, lower-case and grouped input, and refuses other alphabets', () => {
    expect(Buffer.from(base32Decode('mzxw 6ytb-oi======') ?? []).toString()).toBe('foobar');
    expect(base32Decode('MZXW1')).toBeNull();
  });
});

describe('otpauthUri', () => {
  it('names the issuer twice, as the Key Uri Format asks, and carries the unpadded secret', () => {
    const uri = otpauthUri({
      issuer: 'Fire Watch',
      account: 'ed@example.org',
      secret: ascii('foobar'),
    });
    expect(uri).toBe(
      'otpauth://totp/Fire%20Watch:ed%40example.org?secret=MZXW6YTBOI&issuer=Fire+Watch&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('recovery codes', () => {
  it('issues ten distinct 80-bit codes, grouped for printing, stored only as hashes', () => {
    let seed = 0;
    const random = (bytes: number): Uint8Array =>
      new Uint8Array(Array.from({ length: bytes }, () => (seed++ * 37) & 0xff));
    const codes = generateRecoveryCodes(random);
    expect(codes).toHaveLength(10);
    expect(new Set(codes.map((code) => code.display)).size).toBe(10);
    for (const code of codes) {
      expect(code.display).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
      expect(code.hash).toEqual(hashRecoveryCode(code.display));
      expect(code.hash).toHaveLength(32);
    }
  });

  it('accepts a code however the member types it back', () => {
    const [code] = generateRecoveryCodes();
    if (code === undefined) throw new Error('no code');
    const typed = ` ${code.display.toLowerCase().replaceAll('-', ' ')} `;
    expect(hashRecoveryCode(typed)).toEqual(code.hash);
  });

  it('refuses anything that is not sixteen base32 characters', () => {
    for (const raw of ['', 'ABCD-EFGH-IJKL', 'ABCD-EFGH-IJKL-MNO1', 'ABCD-EFGH-IJKL-MNOPQ']) {
      expect(normalizeRecoveryCode(raw)).toBeNull();
      expect(hashRecoveryCode(raw)).toBeNull();
    }
  });
});
