import { createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signWebhookPayload, verifyWebhookSignature } from './node.js';
import {
  DEFAULT_REPLAY_WINDOW_SECONDS,
  formatWebhookSignatureHeader,
  isWithinReplayWindow,
  parseWebhookSignatureHeader,
  webhookSignedContent,
} from './webhook.js';

/** Generated per run: never a real secret. */
const SECRET = randomBytes(32).toString('base64url');
const T = 1_790_000_000;
const BODY = '{"version":"fire-watch.webhook.v1","type":"ping"}';

describe('webhook signature', () => {
  it('signs exactly "<t>.<body>" with HMAC-SHA256', () => {
    expect(webhookSignedContent(T, BODY)).toBe(`${String(T)}.${BODY}`);
    const hex = signWebhookPayload(SECRET, T, BODY);
    expect(hex).toBe(
      createHmac('sha256', SECRET)
        .update(`${String(T)}.${BODY}`)
        .digest('hex'),
    );
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
