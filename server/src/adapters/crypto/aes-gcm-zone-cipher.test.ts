import { randomBytes } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { coarsenCentre } from '../../core/zones/zone-geometry.js';
import {
  createAesGcmZoneCipher,
  SEALED_CENTRE_BYTES,
  ZoneCentreCipherError,
  type ZoneKey,
} from './aes-gcm-zone-cipher.js';

const ZONE = '22222222-0000-4000-8000-000000000001';
const OTHER_ZONE = '22222222-0000-4000-8000-000000000002';
const CENTRE = { lat: 42.695, lon: 23.325 };

function key(id: string): ZoneKey {
  return { id, key: randomBytes(32) };
}

const K1 = key('k2026a');
const K2 = key('k2026b');

/** The byte patterns a leaked row must not contain: the doubles, and the decimal text. */
function plaintextFingerprints(centre: { lat: number; lon: number }): Buffer[] {
  const lat = Buffer.alloc(8);
  const lon = Buffer.alloc(8);
  lat.writeDoubleBE(centre.lat);
  lon.writeDoubleBE(centre.lon);
  const latLe = Buffer.from(lat).reverse();
  const lonLe = Buffer.from(lon).reverse();
  return [lat, lon, latLe, lonLe, Buffer.from(String(centre.lat)), Buffer.from(String(centre.lon))];
}

describe('sealing', () => {
  it('round-trips the stored centre bit for bit, so a coarsened centre stays on the grid', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 39, max: 46, noNaN: true }),
        fc.double({ min: 20, max: 31, noNaN: true }),
        (lat, lon) => {
          const cipher = createAesGcmZoneCipher({ active: K1, retired: [] });
          const centre = coarsenCentre({ lat, lon });
          expect(cipher.open(ZONE, cipher.seal(ZONE, centre))).toEqual(centre);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('writes a fixed-length ciphertext containing neither the doubles nor the digits', () => {
    const sealed = createAesGcmZoneCipher({ active: K1, retired: [] }).seal(ZONE, CENTRE);
    expect(sealed.ciphertext).toHaveLength(SEALED_CENTRE_BYTES);
    const bytes = Buffer.from(sealed.ciphertext);
    for (const fingerprint of plaintextFingerprints(CENTRE)) {
      expect(bytes.includes(fingerprint)).toBe(false);
    }
  });

  it('seals the same centre differently every time, so equal zones are not linkable', () => {
    const cipher = createAesGcmZoneCipher({ active: K1, retired: [] });
    const a = Buffer.from(cipher.seal(ZONE, CENTRE).ciphertext);
    const b = Buffer.from(cipher.seal(ZONE, CENTRE).ciphertext);
    expect(a.equals(b)).toBe(false);
  });

  it('names the active key, which is what makes rotation possible', () => {
    expect(createAesGcmZoneCipher({ active: K2, retired: [K1] }).seal(ZONE, CENTRE).keyId).toBe(
      'k2026b',
    );
  });
});

describe('opening', () => {
  const cipher = createAesGcmZoneCipher({ active: K1, retired: [] });

  it('refuses a ciphertext copied onto another zone', () => {
    const sealed = cipher.seal(ZONE, CENTRE);
    expect(() => cipher.open(OTHER_ZONE, sealed)).toThrow(ZoneCentreCipherError);
  });

  it('refuses a ciphertext relabelled with another key id', () => {
    const both = createAesGcmZoneCipher({ active: K1, retired: [K2] });
    const sealed = both.seal(ZONE, CENTRE);
    expect(() => both.open(ZONE, { ...sealed, keyId: K2.id })).toThrow(/did not authenticate/);
  });

  it('refuses any single flipped bit', () => {
    const sealed = cipher.seal(ZONE, CENTRE);
    for (let index = 0; index < sealed.ciphertext.length; index += 1) {
      const tampered = new Uint8Array(sealed.ciphertext);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expect(() => cipher.open(ZONE, { ...sealed, ciphertext: tampered })).toThrow(
        ZoneCentreCipherError,
      );
    }
  });

  it('opens rows sealed under a retired key, and only under keys it holds', () => {
    const old = createAesGcmZoneCipher({ active: K1, retired: [] }).seal(ZONE, CENTRE);
    expect(createAesGcmZoneCipher({ active: K2, retired: [K1] }).open(ZONE, old)).toEqual(CENTRE);
    expect(() => createAesGcmZoneCipher({ active: K2, retired: [] }).open(ZONE, old)).toThrow(
      /key this process lacks/,
    );
  });

  it('refuses a truncated ciphertext before touching the cipher', () => {
    const sealed = cipher.seal(ZONE, CENTRE);
    expect(() =>
      cipher.open(ZONE, { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 40) }),
    ).toThrow(/wrong length/);
  });

  it('never quotes a coordinate or a key in a failure', () => {
    const sealed = cipher.seal(ZONE, CENTRE);
    try {
      cipher.open(OTHER_ZONE, sealed);
    } catch (error) {
      const text = String(error);
      expect(text).not.toMatch(/42\.69|23\.32/);
      expect(text).not.toContain(Buffer.from(K1.key).toString('base64'));
    }
  });
});

describe('the keyring', () => {
  it('refuses a key of the wrong size', () => {
    expect(() =>
      createAesGcmZoneCipher({ active: { id: 'short', key: randomBytes(16) }, retired: [] }),
    ).toThrow(/32 bytes/);
  });

  it('refuses a key id that could collide inside the associated data', () => {
    expect(() =>
      createAesGcmZoneCipher({ active: { id: 'a|b', key: randomBytes(32) }, retired: [] }),
    ).toThrow(/key id/);
  });

  it('refuses one id for two keys, which would make opening a guess', () => {
    expect(() =>
      createAesGcmZoneCipher({ active: K1, retired: [{ id: K1.id, key: randomBytes(32) }] }),
    ).toThrow(/appears twice/);
  });

  it('refuses a zone id that is not a uuid', () => {
    expect(() => cipher().seal('zone|k2026a', CENTRE)).toThrow(/uuid/);
  });
});

function cipher() {
  return createAesGcmZoneCipher({ active: K1, retired: [] });
}
