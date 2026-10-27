/**
 * The webhook signing secret's seal: AES-256-GCM under a service-held key (TASKS V2-G2;
 * migration 035's `webhook_endpoints.secret_ciphertext`).
 *
 * **Why encrypted and not hashed.** A sign-in token or a confirmation token is only ever
 * compared, so the repo stores its SHA-256. A webhook secret is a key: every delivery
 * recomputes `HMAC-SHA256(secret, t.body)`, so the server must get the plaintext back. The
 * comparable secret in this repo is the staff TOTP seed (migration 026), which has the same
 * need, and this is its construction (`aes-gcm-totp-sealer.ts`) for a different plaintext:
 *
 *     secret_ciphertext = iv (12) ‖ encrypted secret (16–128) ‖ tag (16)
 *
 *   - **A fresh random 96-bit IV per seal.**
 *   - **Associated data `fire-watch/webhook-secret/v1|<endpointId>|<keyId>`** binds the
 *     ciphertext to its endpoint and its key: a secret copied onto another endpoint's row,
 *     or relabelled with another key id, fails the tag check.
 *
 * A database dump without the key (`FIRE_WATCH_WEBHOOK_KEY`, `app/webhooks-config.ts`)
 * holds no usable secret. One active key seals; the active key and any retired keys open.
 * Every failure message is a literal; nothing quotes a key, a secret or the crypto error.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { SealedSecret, WebhookSecretSealer } from '../../core/ports/webhook-store.js';
import { KEY_ID_RE } from './aes-gcm-zone-cipher.js';

export const WEBHOOK_SEAL_LAYOUT = 'fire-watch/webhook-secret/v1';
/** Starts every signing secret, so an integrator can tell it from their other credentials. */
export const WEBHOOK_SIGNING_PREFIX = 'whsec_';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const MIN_WEBHOOK_SIGNING_BYTES = 16;
export const MAX_WEBHOOK_SIGNING_BYTES = 128;

export interface WebhookSealKey {
  readonly id: string;
  /** 32 raw bytes. */
  readonly key: Uint8Array;
}

export interface WebhookSealKeyring {
  readonly active: WebhookSealKey;
  /** Decrypt-only. May be empty. */
  readonly retired: readonly WebhookSealKey[];
}

/** Thrown for every failure; deliberately says nothing beyond the kind. */
export class WebhookSealerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSealerError';
  }
}

/** A new signing secret: the prefix and `bytes` random bytes, base64url. */
export function generateWebhookSigningSecret(
  bytes: number,
  random: (n: number) => Uint8Array = (n) => randomBytes(n),
): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) {
    throw new WebhookSealerError('a webhook signing secret draws 16 to 64 random bytes');
  }
  return `${WEBHOOK_SIGNING_PREFIX}${Buffer.from(random(bytes)).toString('base64url')}`;
}

export function createAesGcmWebhookSecretSealer(
  keyring: WebhookSealKeyring,
  options: { readonly randomIv?: (bytes: number) => Uint8Array } = {},
): WebhookSecretSealer {
  const keys = indexKeys(keyring);
  const active = keyring.active;
  const randomIv = options.randomIv ?? ((bytes: number) => randomBytes(bytes));

  return {
    seal(endpointId, plaintext) {
      assertEndpointId(endpointId);
      const plain = Buffer.from(plaintext, 'utf8');
      if (plain.length < MIN_WEBHOOK_SIGNING_BYTES || plain.length > MAX_WEBHOOK_SIGNING_BYTES) {
        throw new WebhookSealerError('a webhook signing secret is 16 to 128 bytes');
      }
      const iv = randomIv(IV_BYTES);
      if (iv.length !== IV_BYTES) {
        throw new WebhookSealerError('webhook seal IV source returned the wrong length');
      }
      const cipher = createCipheriv(ALGORITHM, active.key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(associatedData(endpointId, active.id));
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      const ciphertext = Buffer.concat([iv, body, cipher.getAuthTag()]);
      return { ciphertext: new Uint8Array(ciphertext), keyId: active.id };
    },

    open(endpointId, sealed: SealedSecret) {
      assertEndpointId(endpointId);
      const key = keys.get(sealed.keyId);
      if (key === undefined) {
        throw new WebhookSealerError(
          'webhook signing secret is sealed under a key this process lacks',
        );
      }
      const length = sealed.ciphertext.length - IV_BYTES - TAG_BYTES;
      if (length < MIN_WEBHOOK_SIGNING_BYTES || length > MAX_WEBHOOK_SIGNING_BYTES) {
        throw new WebhookSealerError('webhook seal ciphertext has the wrong length');
      }
      const bytes = Buffer.from(sealed.ciphertext);
      const iv = bytes.subarray(0, IV_BYTES);
      const body = bytes.subarray(IV_BYTES, IV_BYTES + length);
      const tag = bytes.subarray(IV_BYTES + length);
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(associatedData(endpointId, sealed.keyId));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        // The crypto error is dropped on purpose: its text is not ours.
        throw new WebhookSealerError('webhook seal ciphertext did not authenticate');
      }
    },
  };
}

function indexKeys(keyring: WebhookSealKeyring): ReadonlyMap<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  for (const entry of [keyring.active, ...keyring.retired]) {
    if (!KEY_ID_RE.test(entry.id)) {
      throw new WebhookSealerError('webhook key id must match [A-Za-z0-9_.-]{1,64}');
    }
    if (entry.key.length !== KEY_BYTES) {
      throw new WebhookSealerError(`webhook key ${entry.id} must be ${KEY_BYTES} bytes`);
    }
    if (keys.has(entry.id)) {
      throw new WebhookSealerError(`webhook key id ${entry.id} appears twice in the keyring`);
    }
    keys.set(entry.id, entry.key);
  }
  return keys;
}

function associatedData(endpointId: string, keyId: string): Buffer {
  return Buffer.from(`${WEBHOOK_SEAL_LAYOUT}|${endpointId}|${keyId}`, 'utf8');
}

/** An endpoint id is a uuid; anything with a separator in it could forge the associated data. */
function assertEndpointId(endpointId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(endpointId)) {
    throw new WebhookSealerError('webhook endpoint id must be a uuid');
  }
}
