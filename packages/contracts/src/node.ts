/**
 * The Node-only half of the contracts package: everything that needs a platform API.
 *
 * `detection_uid` has exactly one implementation (GLOSSARY §1b rule 5) and it lives
 * here. It is a separate entry point so the browser bundle can import the vocabulary
 * and the canonicalization rules without pulling `node:crypto` in.
 *
 * The webhook signature (TASKS V2-G2) lives here for the same reason: one HMAC that both
 * the sender and the documented verification recipe (docs/WEBHOOKS.md) run.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { detectionUidPreimage, type DetectionUidParts } from './detection-uid.js';
import {
  DEFAULT_REPLAY_WINDOW_SECONDS,
  isWithinReplayWindow,
  parseWebhookSignatureHeader,
  webhookSignedContent,
} from './webhook.js';

export function detectionUid(parts: DetectionUidParts): string {
  return createHash('sha256').update(detectionUidPreimage(parts), 'utf8').digest('hex');
}

/** The lowercase hex HMAC-SHA256 of `"<t>.<body>"` under `secret`. */
export function signWebhookPayload(secret: string, timestampSeconds: number, body: string): string {
  if (secret.length === 0) throw new RangeError('a webhook secret must not be empty');
  return createHmac('sha256', secret)
    .update(webhookSignedContent(timestampSeconds, body), 'utf8')
    .digest('hex');
}

export type WebhookVerification =
  | { readonly ok: true; readonly timestampSeconds: number }
  | { readonly ok: false; readonly reason: 'malformed' | 'stale' | 'mismatch' };

export interface VerifyWebhookInput {
  readonly secret: string;
  /** The raw `X-FireWatch-Signature` header value. */
  readonly header: string;
  /** The raw request body, exactly as received — never a re-serialised parse. */
  readonly body: string;
  readonly nowSeconds: number;
  readonly toleranceSeconds?: number;
}

/**
 * Verifies one delivery: a well-formed header, a timestamp inside the replay window, and
 * at least one `v1` signature equal (in constant time) to the HMAC of the body.
 */
export function verifyWebhookSignature(input: VerifyWebhookInput): WebhookVerification {
  const parsed = parseWebhookSignatureHeader(input.header);
  if (parsed === null) return { ok: false, reason: 'malformed' };
  const tolerance = input.toleranceSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;
  if (!isWithinReplayWindow(parsed.timestampSeconds, input.nowSeconds, tolerance)) {
    return { ok: false, reason: 'stale' };
  }
  const expected = Buffer.from(
    signWebhookPayload(input.secret, parsed.timestampSeconds, input.body),
    'hex',
  );
  const matches = parsed.signatures.some((candidate) =>
    timingSafeEqual(expected, Buffer.from(candidate, 'hex')),
  );
  return matches
    ? { ok: true, timestampSeconds: parsed.timestampSeconds }
    : { ok: false, reason: 'mismatch' };
}
