import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createAesGcmWebhookSecretSealer,
  generateWebhookSigningSecret,
  WEBHOOK_SIGNING_PREFIX,
  WebhookSealerError,
  type WebhookSealKey,
} from './aes-gcm-webhook-secret-sealer.js';

const ENDPOINT = '35353535-0000-4000-8000-000000000001';
const OTHER = '35353535-0000-4000-8000-000000000002';

function key(id: string): WebhookSealKey {
  return { id, key: randomBytes(32) };
}

const K1 = key('webhook2026a');
const K2 = key('webhook2026b');

describe('generateWebhookSigningSecret', () => {
  it('draws the configured bytes and marks the secret with its prefix', () => {
    const secret = generateWebhookSigningSecret(32);
    expect(secret.startsWith(WEBHOOK_SIGNING_PREFIX)).toBe(true);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSigningSecret(32)).not.toBe(secret);
    expect(generateWebhookSigningSecret(16, (n) => new Uint8Array(n))).toBe(
      `whsec_${Buffer.alloc(16).toString('base64url')}`,
    );
    expect(() => generateWebhookSigningSecret(8)).toThrow(WebhookSealerError);
  });
});

describe('createAesGcmWebhookSecretSealer', () => {
  it('round-trips a secret and does not carry it in the clear', () => {
    const sealer = createAesGcmWebhookSecretSealer({ active: K1, retired: [] });
    const secret = generateWebhookSigningSecret(32);
    const sealed = sealer.seal(ENDPOINT, secret);
    expect(sealed.keyId).toBe('webhook2026a');
    expect(sealed.ciphertext.length).toBe(12 + secret.length + 16);
    expect(Buffer.from(sealed.ciphertext).includes(Buffer.from(secret))).toBe(false);
    expect(sealer.open(ENDPOINT, sealed)).toBe(secret);
  });

  it('fits the migration 035 length CHECK at both ends of the secret range', () => {
    const sealer = createAesGcmWebhookSecretSealer({ active: K1, retired: [] });
    expect(sealer.seal(ENDPOINT, 'a'.repeat(16)).ciphertext.length).toBe(44);
    expect(sealer.seal(ENDPOINT, 'a'.repeat(128)).ciphertext.length).toBe(156);
    expect(() => sealer.seal(ENDPOINT, 'a'.repeat(15))).toThrow('16 to 128');
    expect(() => sealer.seal(ENDPOINT, 'a'.repeat(129))).toThrow('16 to 128');
  });

  it('uses a fresh IV for every seal', () => {
    const sealer = createAesGcmWebhookSecretSealer({ active: K1, retired: [] });
    const secret = generateWebhookSigningSecret(32);
    const a = sealer.seal(ENDPOINT, secret);
    const b = sealer.seal(ENDPOINT, secret);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("refuses a secret copied onto another endpoint's row", () => {
    const sealer = createAesGcmWebhookSecretSealer({ active: K1, retired: [] });
    const sealed = sealer.seal(ENDPOINT, generateWebhookSigningSecret(32));
    expect(() => sealer.open(OTHER, sealed)).toThrow(WebhookSealerError);
  });

  it('refuses a relabelled key id, a tampered tag, a wrong length and an unknown key', () => {
    const sealer = createAesGcmWebhookSecretSealer({ active: K1, retired: [K2] });
    const sealed = sealer.seal(ENDPOINT, generateWebhookSigningSecret(32));
    expect(() => sealer.open(ENDPOINT, { ...sealed, keyId: 'webhook2026b' })).toThrow(
      'did not authenticate',
    );
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => sealer.open(ENDPOINT, { ...sealed, ciphertext: tampered })).toThrow(
      'did not authenticate',
    );
    expect(() =>
      sealer.open(ENDPOINT, { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 40) }),
    ).toThrow('wrong length');
    expect(() => sealer.open(ENDPOINT, { ...sealed, keyId: 'unknown' })).toThrow('lacks');
  });

  it('opens a secret sealed under a key that has since been retired', () => {
    const secret = generateWebhookSigningSecret(32);
    const sealed = createAesGcmWebhookSecretSealer({ active: K1, retired: [] }).seal(
      ENDPOINT,
      secret,
    );
    const rotated = createAesGcmWebhookSecretSealer({ active: K2, retired: [K1] });
    expect(rotated.open(ENDPOINT, sealed)).toBe(secret);
    expect(rotated.seal(ENDPOINT, secret).keyId).toBe('webhook2026b');
  });

  it('validates the keyring and the endpoint id', () => {
    expect(() =>
      createAesGcmWebhookSecretSealer({
        active: { id: 'k', key: new Uint8Array(16) },
        retired: [],
      }),
    ).toThrow('32 bytes');
    expect(() =>
      createAesGcmWebhookSecretSealer({ active: { ...K1, id: 'bad id' }, retired: [] }),
    ).toThrow('key id');
    expect(() => createAesGcmWebhookSecretSealer({ active: K1, retired: [K1] })).toThrow('twice');
    const sealer = createAesGcmWebhookSecretSealer({ active: K1, retired: [] });
    expect(() => sealer.seal('x|y', generateWebhookSigningSecret(32))).toThrow('uuid');
  });
});
