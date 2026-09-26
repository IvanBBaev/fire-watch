/**
 * The zone-centre cipher: AES-256-GCM under a service-held key (05 §5.3.2; ADR-004 D8).
 *
 * ## The byte layout, and why each part is there
 *
 *     ciphertext column = iv (12) ‖ encrypted centre (16) ‖ tag (16)   — 44 bytes
 *
 *   - **A fresh random 96-bit IV per seal.** GCM's one unforgiving rule is never to reuse
 *     an IV under a key; a random 96-bit IV keeps the collision odds negligible far past
 *     any number of zones this service will ever hold (NIST SP 800-38D §8.3's 2^32
 *     invocations per key). A counter would be tighter and would need state that survives
 *     restarts, which is a second thing to get wrong.
 *   - **The centre as two big-endian float64s.** Exact: the stored centre goes in and the
 *     same bits come out, so a coarsened centre stays on the grid through a round trip and a
 *     precise one loses nothing. Fixed width, so the ciphertext length says nothing about
 *     the coordinate — decimal text would leak digit counts.
 *   - **Associated data `fire-watch/zone-centre/v1|<zoneId>|<keyId>`.** Authenticated, not
 *     encrypted: binds the ciphertext to its row and its key, so a centre copied onto
 *     another zone, or relabelled with another key id, fails the tag check. The `v1` is the
 *     layout's version; a change to anything above is a new prefix, never an edit.
 *
 * ## Keys
 *
 * One active key seals; the active key and any retired keys open. That is the whole
 * rotation story this module owns: introduce a new active key, keep the old one as retired
 * until every row names the new one, then drop it. The re-encryption pass that moves rows
 * across is a job, not this module: `core/zones/rotate-zone-centre-keys.ts`, run by
 * `app/zone-key-rotation-cli.ts` (`pnpm --filter server zone-key-rotation`). Keys arrive as
 * raw bytes from `app/zones-config.ts`, which reads them from the environment the secret
 * manager fills — never from the database, which is exactly what 05 §5.3.2 rules out.
 *
 * Every failure message here is a literal. Nothing quotes a key, a plaintext, or the
 * underlying crypto error, whose text is not ours to vouch for.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Coordinate } from '../../core/clustering/geometry.js';
import type { SealedCentre, ZoneCentreCipher } from '../../core/ports/zone-centre-cipher.js';

export const ZONE_CENTRE_LAYOUT = 'fire-watch/zone-centre/v1';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PLAINTEXT_BYTES = 16;
export const SEALED_CENTRE_BYTES = IV_BYTES + PLAINTEXT_BYTES + TAG_BYTES;

/**
 * Key ids go into the associated data between `|` separators, so they are restricted to a
 * set that cannot contain one — otherwise `a|b` under key `c` and `a` under key `b|c`
 * would authenticate the same bytes.
 */
export const KEY_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface ZoneKey {
  readonly id: string;
  /** 32 raw bytes. */
  readonly key: Uint8Array;
}

export interface ZoneKeyring {
  readonly active: ZoneKey;
  /** Decrypt-only. May be empty. */
  readonly retired: readonly ZoneKey[];
}

/** Thrown for every open that fails; deliberately says nothing about why beyond the kind. */
export class ZoneCentreCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneCentreCipherError';
  }
}

export function createAesGcmZoneCipher(
  keyring: ZoneKeyring,
  options: { readonly randomIv?: (bytes: number) => Uint8Array } = {},
): ZoneCentreCipher {
  const keys = indexKeys(keyring);
  const active = keyring.active;
  const randomIv = options.randomIv ?? ((bytes: number) => randomBytes(bytes));

  return {
    seal(zoneId: string, centre: Coordinate): SealedCentre {
      assertZoneId(zoneId);
      const iv = randomIv(IV_BYTES);
      if (iv.length !== IV_BYTES) {
        throw new ZoneCentreCipherError('zone centre IV source returned the wrong length');
      }
      const cipher = createCipheriv(ALGORITHM, active.key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(associatedData(zoneId, active.id));
      const body = Buffer.concat([cipher.update(encodeCentre(centre)), cipher.final()]);
      const ciphertext = Buffer.concat([iv, body, cipher.getAuthTag()]);
      return { ciphertext: new Uint8Array(ciphertext), keyId: active.id };
    },

    open(zoneId: string, sealed: SealedCentre): Coordinate {
      assertZoneId(zoneId);
      const key = keys.get(sealed.keyId);
      if (key === undefined) {
        throw new ZoneCentreCipherError('zone centre is sealed under a key this process lacks');
      }
      if (sealed.ciphertext.length !== SEALED_CENTRE_BYTES) {
        throw new ZoneCentreCipherError('zone centre ciphertext has the wrong length');
      }
      const bytes = Buffer.from(sealed.ciphertext);
      const iv = bytes.subarray(0, IV_BYTES);
      const body = bytes.subarray(IV_BYTES, IV_BYTES + PLAINTEXT_BYTES);
      const tag = bytes.subarray(IV_BYTES + PLAINTEXT_BYTES);
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(associatedData(zoneId, sealed.keyId));
      decipher.setAuthTag(tag);
      let plaintext: Buffer;
      try {
        plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        // The crypto error is dropped on purpose: its text is not ours, and "unable to
        // authenticate data" is all it could say anyway.
        throw new ZoneCentreCipherError('zone centre ciphertext did not authenticate');
      }
      return decodeCentre(plaintext);
    },
  };
}

function indexKeys(keyring: ZoneKeyring): ReadonlyMap<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  for (const entry of [keyring.active, ...keyring.retired]) {
    if (!KEY_ID_RE.test(entry.id)) {
      throw new ZoneCentreCipherError('zone key id must match [A-Za-z0-9_.-]{1,64}');
    }
    if (entry.key.length !== KEY_BYTES) {
      throw new ZoneCentreCipherError(`zone key ${entry.id} must be ${KEY_BYTES} bytes`);
    }
    if (keys.has(entry.id)) {
      throw new ZoneCentreCipherError(`zone key id ${entry.id} appears twice in the keyring`);
    }
    keys.set(entry.id, entry.key);
  }
  return keys;
}

function associatedData(zoneId: string, keyId: string): Buffer {
  return Buffer.from(`${ZONE_CENTRE_LAYOUT}|${zoneId}|${keyId}`, 'utf8');
}

/** A zone id is a uuid; anything with a separator in it could forge the associated data. */
function assertZoneId(zoneId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(zoneId)) {
    throw new ZoneCentreCipherError('zone id must be a uuid');
  }
}

function encodeCentre(centre: Coordinate): Buffer {
  if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) {
    throw new ZoneCentreCipherError('zone centre must be finite');
  }
  const bytes = Buffer.alloc(PLAINTEXT_BYTES);
  bytes.writeDoubleBE(centre.lat, 0);
  bytes.writeDoubleBE(centre.lon, 8);
  return bytes;
}

function decodeCentre(bytes: Buffer): Coordinate {
  return { lat: bytes.readDoubleBE(0), lon: bytes.readDoubleBE(8) };
}
