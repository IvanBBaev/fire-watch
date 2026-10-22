/**
 * The staff TOTP secret's seal: AES-256-GCM under a service-held key (TASKS I1; 05 C3;
 * migration 026's `staff_totp_factors.secret_ciphertext`).
 *
 * The same construction as the zone-centre cipher (`aes-gcm-zone-cipher.ts`), for a
 * different plaintext:
 *
 *     secret_ciphertext = iv (12) ‖ encrypted secret (16–64) ‖ tag (16)
 *
 *   - **A fresh random 96-bit IV per seal**, for the reason the zone cipher gives.
 *   - **Associated data `fire-watch/staff-totp/v1|<staffId>|<keyId>`** binds the
 *     ciphertext to its member and its key: a secret copied onto another member's row, or
 *     relabelled with another key id, fails the tag check. A different layout is a new
 *     prefix, never an edit.
 *
 * The secret is not fixed-width (RFC 4226 asks for at least 128 bits; `generateTotpSecret`
 * makes 160), so the ciphertext length tells its length — which is public anyway: every
 * authenticator app shows it.
 *
 * One active key seals; the active key and any retired keys open. Keys arrive as raw bytes
 * from the host's secret store, never from the database. Every failure message is a
 * literal; nothing quotes a key, a secret, or the underlying crypto error.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { SealedSecret } from '../../core/ports/staff-stores.js';
import { KEY_ID_RE } from './aes-gcm-zone-cipher.js';

export const STAFF_TOTP_LAYOUT = 'fire-watch/staff-totp/v1';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const MIN_TOTP_SECRET_BYTES = 16;
export const MAX_TOTP_SECRET_BYTES = 64;

export interface StaffTotpKey {
  readonly id: string;
  /** 32 raw bytes. */
  readonly key: Uint8Array;
}

export interface StaffTotpKeyring {
  readonly active: StaffTotpKey;
  /** Decrypt-only. May be empty. */
  readonly retired: readonly StaffTotpKey[];
}

export interface StaffTotpSealer {
  seal(staffId: string, secret: Uint8Array): SealedSecret;
  /** Throws {@link StaffTotpSealerError} when the secret cannot be opened. */
  open(staffId: string, sealed: SealedSecret): Uint8Array;
}

/** Thrown for every failure; deliberately says nothing beyond the kind. */
export class StaffTotpSealerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffTotpSealerError';
  }
}

export function createAesGcmTotpSealer(
  keyring: StaffTotpKeyring,
  options: { readonly randomIv?: (bytes: number) => Uint8Array } = {},
): StaffTotpSealer {
  const keys = indexKeys(keyring);
  const active = keyring.active;
  const randomIv = options.randomIv ?? ((bytes: number) => randomBytes(bytes));

  return {
    seal(staffId, secret) {
      assertStaffId(staffId);
      if (secret.length < MIN_TOTP_SECRET_BYTES || secret.length > MAX_TOTP_SECRET_BYTES) {
        throw new StaffTotpSealerError('a TOTP secret is 16 to 64 bytes');
      }
      const iv = randomIv(IV_BYTES);
      if (iv.length !== IV_BYTES) {
        throw new StaffTotpSealerError('TOTP seal IV source returned the wrong length');
      }
      const cipher = createCipheriv(ALGORITHM, active.key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(associatedData(staffId, active.id));
      const body = Buffer.concat([cipher.update(secret), cipher.final()]);
      const ciphertext = Buffer.concat([iv, body, cipher.getAuthTag()]);
      return { ciphertext: new Uint8Array(ciphertext), keyId: active.id };
    },

    open(staffId, sealed) {
      assertStaffId(staffId);
      const key = keys.get(sealed.keyId);
      if (key === undefined) {
        throw new StaffTotpSealerError('TOTP secret is sealed under a key this process lacks');
      }
      const length = sealed.ciphertext.length - IV_BYTES - TAG_BYTES;
      if (length < MIN_TOTP_SECRET_BYTES || length > MAX_TOTP_SECRET_BYTES) {
        throw new StaffTotpSealerError('TOTP secret ciphertext has the wrong length');
      }
      const bytes = Buffer.from(sealed.ciphertext);
      const iv = bytes.subarray(0, IV_BYTES);
      const body = bytes.subarray(IV_BYTES, IV_BYTES + length);
      const tag = bytes.subarray(IV_BYTES + length);
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(associatedData(staffId, sealed.keyId));
      decipher.setAuthTag(tag);
      try {
        return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
      } catch {
        // The crypto error is dropped on purpose: its text is not ours.
        throw new StaffTotpSealerError('TOTP secret ciphertext did not authenticate');
      }
    },
  };
}

function indexKeys(keyring: StaffTotpKeyring): ReadonlyMap<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  for (const entry of [keyring.active, ...keyring.retired]) {
    if (!KEY_ID_RE.test(entry.id)) {
      throw new StaffTotpSealerError('TOTP key id must match [A-Za-z0-9_.-]{1,64}');
    }
    if (entry.key.length !== KEY_BYTES) {
      throw new StaffTotpSealerError(`TOTP key ${entry.id} must be ${KEY_BYTES} bytes`);
    }
    if (keys.has(entry.id)) {
      throw new StaffTotpSealerError(`TOTP key id ${entry.id} appears twice in the keyring`);
    }
    keys.set(entry.id, entry.key);
  }
  return keys;
}

function associatedData(staffId: string, keyId: string): Buffer {
  return Buffer.from(`${STAFF_TOTP_LAYOUT}|${staffId}|${keyId}`, 'utf8');
}

/** A staff id is a uuid; anything with a separator in it could forge the associated data. */
function assertStaffId(staffId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(staffId)) {
    throw new StaffTotpSealerError('staff id must be a uuid');
  }
}
