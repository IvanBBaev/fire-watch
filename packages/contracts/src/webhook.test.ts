import { describe, expect, it } from 'vitest';

import { signWebhookPayload, verifyWebhookSignature } from './node.js';
import {
  DEFAULT_REPLAY_WINDOW_SECONDS,
  formatWebhookSignatureHeader,
  isWithinReplayWindow,
  parseWebhookSignatureHeader,
  webhookSignedContent,
} from './webhook.js';

// Web Crypto, a global on both platforms: a `node:crypto` import here would break
// contracts-is-platform-neutral, which covers this package's tests too.
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Generated per run: never a real secret. */
const SECRET = toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));

/** An independent HMAC-SHA256, so the test does not check the signer against itself. */
async function referenceHmacHex(key: string, content: string): Promise<string> {
  const encoder = new TextEncoder();
  const imported = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await globalThis.crypto.subtle.sign('HMAC', imported, encoder.encode(content));
  return toHex(new Uint8Array(mac));
}
const T = 1_790_000_000;
const BODY = '{"version":"fire-watch.webhook.v1","type":"ping"}';

describe('webhook signature', () => {
  it('signs exactly "<t>.<body>" with HMAC-SHA256', async () => {
    expect(webhookSignedContent(T, BODY)).toBe(`${String(T)}.${BODY}`);
    const hex = signWebhookPayload(SECRET, T, BODY);
    expect(hex).toBe(await referenceHmacHex(SECRET, `${String(T)}.${BODY}`));
    expect(signWebhookPayload(SECRET, T + 1, BODY)).not.toBe(hex);
    expect(() => signWebhookPayload('', T, BODY)).toThrow(RangeError);
  });

  it('round-trips through the header and verifies', () => {
    const header = formatWebhookSignatureHeader(T, [signWebhookPayload(SECRET, T, BODY)]);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      verifyWebhookSignature({ secret: SECRET, header, body: BODY, nowSeconds: T + 10 }),
    ).toEqual({ ok: true, timestampSeconds: T });
  });

  it('rejects a changed body, a wrong secret, a stale timestamp and a malformed header', () => {
    const header = formatWebhookSignatureHeader(T, [signWebhookPayload(SECRET, T, BODY)]);
    const base = { secret: SECRET, header, body: BODY, nowSeconds: T };
    expect(verifyWebhookSignature({ ...base, body: `${BODY} ` })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyWebhookSignature({ ...base, secret: `${SECRET}x` }).ok).toBe(false);
    expect(
      verifyWebhookSignature({ ...base, nowSeconds: T + DEFAULT_REPLAY_WINDOW_SECONDS + 1 }),
    ).toEqual({ ok: false, reason: 'stale' });
    expect(verifyWebhookSignature({ ...base, header: 'v1=abc' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('accepts any of several v1 signatures and ignores unknown schemes', () => {
    const good = signWebhookPayload(SECRET, T, BODY);
    const other = signWebhookPayload(`${SECRET}-old`, T, BODY);
    const header = `t=${String(T)},v0=zzz,v1=${other},v1=${good}`;
    expect(verifyWebhookSignature({ secret: SECRET, header, body: BODY, nowSeconds: T }).ok).toBe(
      true,
    );
  });

  it('parses strictly', () => {
    const hex = 'a'.repeat(64);
    expect(parseWebhookSignatureHeader(`t=${String(T)},v1=${hex}`)).toEqual({
      timestampSeconds: T,
      signatures: [hex],
    });
    expect(parseWebhookSignatureHeader(`t=1,t=2,v1=${hex}`)).toBeNull();
    expect(parseWebhookSignatureHeader(`t=-1,v1=${hex}`)).toBeNull();
    expect(parseWebhookSignatureHeader(`t=1,v1=${'A'.repeat(64)}`)).toBeNull();
    expect(parseWebhookSignatureHeader('t=1')).toBeNull();
    expect(parseWebhookSignatureHeader('x'.repeat(2000))).toBeNull();
    expect(() => formatWebhookSignatureHeader(T, [])).toThrow(RangeError);
    expect(() => formatWebhookSignatureHeader(1.5, [hex])).toThrow(RangeError);
  });

  it('applies the replay window both ways', () => {
    expect(isWithinReplayWindow(T, T + 300)).toBe(true);
    expect(isWithinReplayWindow(T, T - 300)).toBe(true);
    expect(isWithinReplayWindow(T, T + 301)).toBe(false);
  });
});
