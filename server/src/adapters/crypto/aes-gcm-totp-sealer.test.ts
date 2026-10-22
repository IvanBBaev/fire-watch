import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createAesGcmTotpSealer,
  StaffTotpSealerError,
  type StaffTotpKey,
} from './aes-gcm-totp-sealer.js';
import { createStaffTotpCodes } from './staff-ceremonies.js';
import { base32Decode, hotp, totpStep } from './totp.js';

const STAFF = '26262626-0000-4000-8000-000000000001';
const OTHER = '26262626-0000-4000-8000-000000000002';

function key(id: string): StaffTotpKey {
  return { id, key: randomBytes(32) };
}

const K1 = key('totp2026a');
const K2 = key('totp2026b');

describe('createAesGcmTotpSealer', () => {
  it('round-trips a secret and does not carry it in the clear', () => {
    const sealer = createAesGcmTotpSealer({ active: K1, retired: [] });
    const secret = new Uint8Array(randomBytes(20));
    const sealed = sealer.seal(STAFF, secret);
    expect(sealed.keyId).toBe('totp2026a');
    expect(sealed.ciphertext.length).toBe(12 + 20 + 16);
    expect(Buffer.from(sealed.ciphertext).includes(Buffer.from(secret))).toBe(false);
    expect(Buffer.from(sealer.open(STAFF, sealed)).equals(Buffer.from(secret))).toBe(true);
  });

  it('uses a fresh IV for every seal', () => {
    const sealer = createAesGcmTotpSealer({ active: K1, retired: [] });
    const secret = new Uint8Array(randomBytes(20));
    const a = sealer.seal(STAFF, secret);
    const b = sealer.seal(STAFF, secret);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("refuses a secret copied onto another member's row", () => {
    const sealer = createAesGcmTotpSealer({ active: K1, retired: [] });
    const sealed = sealer.seal(STAFF, new Uint8Array(randomBytes(20)));
    expect(() => sealer.open(OTHER, sealed)).toThrow(StaffTotpSealerError);
  });

  it('refuses a relabelled key id, a tampered tag and a wrong length', () => {
    const sealer = createAesGcmTotpSealer({ active: K1, retired: [K2] });
    const sealed = sealer.seal(STAFF, new Uint8Array(randomBytes(20)));
    expect(() => sealer.open(STAFF, { ...sealed, keyId: 'totp2026b' })).toThrow(
      'did not authenticate',
    );
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => sealer.open(STAFF, { ...sealed, ciphertext: tampered })).toThrow(
      'did not authenticate',
    );
    expect(() =>
      sealer.open(STAFF, { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 30) }),
    ).toThrow('wrong length');
    expect(() => sealer.open(STAFF, { ...sealed, keyId: 'unknown' })).toThrow('lacks');
  });

  it('opens a secret sealed under a key that has since been retired', () => {
    const old = createAesGcmTotpSealer({ active: K1, retired: [] });
    const sealed = old.seal(STAFF, new Uint8Array(randomBytes(20)));
    const rotated = createAesGcmTotpSealer({ active: K2, retired: [K1] });
    expect(rotated.open(STAFF, sealed).length).toBe(20);
    expect(rotated.seal(STAFF, new Uint8Array(randomBytes(20))).keyId).toBe('totp2026b');
  });

  it('validates the keyring, the staff id and the secret length', () => {
    expect(() =>
      createAesGcmTotpSealer({ active: { id: 'k', key: new Uint8Array(16) }, retired: [] }),
    ).toThrow('32 bytes');
    expect(() => createAesGcmTotpSealer({ active: { ...K1, id: 'bad id' }, retired: [] })).toThrow(
      'key id',
    );
    expect(() => createAesGcmTotpSealer({ active: K1, retired: [K1] })).toThrow('twice');
    const sealer = createAesGcmTotpSealer({ active: K1, retired: [] });
    expect(() => sealer.seal('x|y', new Uint8Array(20))).toThrow('uuid');
    expect(() => sealer.seal(STAFF, new Uint8Array(15))).toThrow('16 to 64');
    expect(() => sealer.seal(STAFF, new Uint8Array(65))).toThrow('16 to 64');
  });
});

describe('createStaffTotpCodes', () => {
  it('verifies a code against the sealed secret and keeps the replay guard', () => {
    const sealer = createAesGcmTotpSealer({ active: K1, retired: [] });
    const secret = new Uint8Array(randomBytes(20));
    const sealed = sealer.seal(STAFF, new Uint8Array(secret));
    const codes = createStaffTotpCodes(sealer, { issuer: 'Fire Watch' });
    const at = Date.UTC(2026, 9, 22, 8, 0, 0);
    const step = totpStep(at);
    const code = hotp(secret, step);
    const factor = { sealed, algorithm: 'sha1' as const, lastUsedStep: null };
    expect(codes.verify({ staffId: STAFF, factor, code, at })).toEqual({ kind: 'accepted', step });
    expect(
      codes.verify({ staffId: STAFF, factor: { ...factor, lastUsedStep: step }, code, at }),
    ).toEqual({ kind: 'refused', reason: 'replayed' });
    expect(codes.verify({ staffId: STAFF, factor, code: 'abc', at })).toEqual({
      kind: 'refused',
      reason: 'malformed',
    });
  });

  it('issues a sealed secret whose plain form matches what it shows once', () => {
    const sealer = createAesGcmTotpSealer({ active: K1, retired: [] });
    const codes = createStaffTotpCodes(sealer, { issuer: 'Fire Watch' });
    const issued = codes.issue({ staffId: STAFF, account: 'ana@example.org' });
    expect(issued.algorithm).toBe('sha1');
    expect(issued.sealed.keyId).toBe('totp2026a');
    expect(issued.sealed.ciphertext.length).toBe(12 + 20 + 16);
    const plain = base32Decode(issued.secret);
    expect(plain).not.toBeNull();
    expect(sealer.open(STAFF, issued.sealed)).toEqual(plain);
    expect(issued.otpauthUri).toMatch(/^otpauth:\/\/totp\/Fire%20Watch:ana%40example\.org\?/);
    expect(issued.otpauthUri).toContain(`secret=${issued.secret}`);
    // Bound to its member: another member's id does not open it.
    expect(() => sealer.open(OTHER, issued.sealed)).toThrow(StaffTotpSealerError);
    // A code made from the shown secret verifies against the sealed one.
    const at = Date.UTC(2026, 9, 22, 8, 0, 0);
    const factor = { sealed: issued.sealed, algorithm: 'sha1' as const, lastUsedStep: null };
    const code = hotp(plain ?? new Uint8Array(), totpStep(at));
    expect(codes.verify({ staffId: STAFF, factor, code, at }).kind).toBe('accepted');
  });

  it('refuses an issuer the otpauth label cannot carry', () => {
    const sealer = createAesGcmTotpSealer({ active: K1, retired: [] });
    expect(() => createStaffTotpCodes(sealer, { issuer: ' ' })).toThrow(TypeError);
    expect(() => createStaffTotpCodes(sealer, { issuer: 'Fire:Watch' })).toThrow(TypeError);
  });
});
