/**
 * The `push` channel — RFC 8030 over a browser's push subscription, VAPID-signed and
 * RFC 8291-encrypted.
 *
 * This is the channel the product is built around (08 §5.4.3, IP: "ship web push +
 * Telegram first"), and the one with the most ways for a healthy request to come back
 * with a status that is really about the subscription, not about us. The table this
 * adapter encodes, from 04-sre §5 and 08 §5.4.3:
 *
 *   | status         | outcome                 | why                                            |
 *   |----------------|-------------------------|------------------------------------------------|
 *   | 2xx            | delivered               | the push service accepted it for delivery      |
 *   | 404, 410       | permanent · `reprompt`  | subscription gone; the app re-prompts on visit |
 *   | 401, 403       | transient               | *our* VAPID credentials — never prune the      |
 *   |                |                         | audience for our own auth failure              |
 *   | 413            | permanent · `keep`      | our payload, their limit; the subscription is  |
 *   |                |                         | fine and a smaller alert would go through      |
 *   | 429            | transient, host paused  | back off that push-service host, not the queue |
 *   | other 4xx      | permanent · `keep`      | rejected, cause unknown, subscription intact   |
 *   | 5xx, network   | transient               | the queue retries until D6's 6 h expiry        |
 *
 * `reprompt` and not `prune` for 404/410 because the user asked for alerts and the
 * browser silently replaced or dropped the subscription; a silent unsubscribe here is
 * the failure mode 08 §5.4.3 names.
 *
 * The payload is the rendered copy as JSON — title, body, footer, deep link — small
 * enough for a lock screen and already through the D7 lint. The service worker shows
 * it as-is; 08 §5.4.3's note about SW-side localisation would need a template key on
 * {@link OutboundMessage}, which is an H6 decision and not taken here.
 */

import type {
  AlertChannelAdapter,
  DeliveryOutcome,
  OutboundMessage,
} from '../../../../core/ports/alert-channel.js';
import { providerRequest, retryAfterMs, type FetchLike } from '../provider-http.js';
import { MAX_PUSH_PLAINTEXT_BYTES, encryptForSubscription } from './encrypt.js';
import { createVapidSigner, fromBase64url, type VapidKeys } from './vapid.js';

export interface WebPushChannelOptions {
  readonly vapid: VapidKeys;
  readonly now: () => number;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Pause applied to a host that answered 429 without a usable `Retry-After`. */
  readonly defaultBackoffMs?: number;
}

export interface WebPushChannel extends AlertChannelAdapter {
  /** For the public-key route the client subscribes with. */
  readonly vapidPublicKey: string;
}

/** What the browser's `PushSubscription.toJSON()` gives us and the DB stores verbatim. */
export interface PushSubscriptionJson {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** What the service worker receives after decryption. */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly footer: string;
  readonly url: string | null;
  readonly outboxId: string;
}

export const DEFAULT_PUSH_TIMEOUT_MS = 10_000;
export const DEFAULT_PUSH_BACKOFF_MS = 60_000;

export function createWebPushChannel(options: WebPushChannelOptions): WebPushChannel {
  const signer = createVapidSigner(options.vapid);
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
  const defaultBackoffMs = options.defaultBackoffMs ?? DEFAULT_PUSH_BACKOFF_MS;
  // Only the private key is a secret worth scrubbing from errors; the endpoint is a
  // capability URL but it is also the row's own handle, and the provider's error text
  // never contains it.
  const redact = [options.vapid.privateKey];

  const pausedUntil = new Map<string, number>();

  return {
    channel: 'push',
    vapidPublicKey: signer.publicKey,
    async deliver(message: OutboundMessage): Promise<DeliveryOutcome> {
      if (message.channel !== 'push') {
        // Inside an `async` function this is a rejection, not a synchronous throw.
        throw new TypeError(`web push channel received a message routed to ${message.channel}`);
      }

      const subscription = parseSubscription(message.endpoint);
      if (subscription.kind === 'permanent') return subscription;

      const audience = subscription.audience;
      const now = options.now();
      const paused = pausedUntil.get(audience);
      if (paused !== undefined) {
        if (now < paused) {
          return {
            kind: 'transient',
            error: `push host ${audience} backing off for ${String(paused - now)} ms`,
          };
        }
        pausedUntil.delete(audience);
      }

      const payload: PushPayload = { ...message.rendered, outboxId: message.outboxId };
      const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
      if (plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) {
        return {
          kind: 'permanent',
          error: `push payload is ${String(plaintext.length)} bytes; the cap is ${String(MAX_PUSH_PLAINTEXT_BYTES)}`,
          subscription: 'keep',
        };
      }
      let body: Buffer;
      try {
        body = encryptForSubscription(plaintext, subscription.keys);
      } catch (error) {
        // A key that decodes but is not on the curve: the subscription is unusable.
        return {
          kind: 'permanent',
          error: `push subscription keys rejected: ${error instanceof Error ? error.message : String(error)}`,
          subscription: 'reprompt',
        };
      }

      const result = await providerRequest({
        fetch: doFetch,
        url: subscription.endpoint,
        method: 'POST',
        headers: {
          authorization: signer.authorizationFor(audience, now),
          'content-type': 'application/octet-stream',
          'content-encoding': 'aes128gcm',
          'content-length': String(body.length),
          ttl: String(message.ttlSeconds),
          // RFC 8030 §5.3: `high` is for "time-sensitive alerts" and wakes a device on
          // low battery. A wildfire alert is the example the RFC had in mind.
          urgency: 'high',
        },
        body,
        timeoutMs,
        redact,
      });

      if (result.status === null) {
        return { kind: 'transient', error: `push request failed: ${result.error}` };
      }
      const { status } = result;
      const detail = result.body.length > 0 ? `: ${result.body}` : '';
      if (status >= 200 && status < 300) {
        return { kind: 'delivered', providerAckAt: options.now() };
      }
      if (status === 404 || status === 410) {
        return {
          kind: 'permanent',
          error: `push service returned ${String(status)}${detail}`,
          subscription: 'reprompt',
        };
      }
      if (status === 429) {
        const backoff = retryAfterMs(result.headers, now) ?? defaultBackoffMs;
        pausedUntil.set(audience, now + backoff);
        return {
          kind: 'transient',
          error: `push host ${audience} returned 429; backing off ${String(backoff)} ms${detail}`,
        };
      }
      if (status === 401 || status === 403) {
        return {
          kind: 'transient',
          error: `push service refused our VAPID credentials (${String(status)})${detail}`,
        };
      }
      if (status >= 400 && status < 500) {
        return {
          kind: 'permanent',
          error: `push service returned ${String(status)}${detail}`,
          subscription: 'keep',
        };
      }
      return { kind: 'transient', error: `push service returned ${String(status)}${detail}` };
    },
  };
}

type ParsedSubscription =
  | {
      readonly kind: 'ok';
      readonly endpoint: string;
      readonly audience: string;
      readonly keys: { readonly p256dh: Buffer; readonly auth: Buffer };
    }
  | Extract<DeliveryOutcome, { kind: 'permanent' }>;

/**
 * The stored subscription, checked for exactly what the wire needs. Anything that fails
 * here is `permanent` + `reprompt`: a subscription that cannot be addressed will never
 * become addressable, and the user who created it still wants alerts.
 */
function parseSubscription(endpoint: string): ParsedSubscription {
  const unusable = (why: string): ParsedSubscription => ({
    kind: 'permanent',
    error: `push subscription unusable: ${why}`,
    subscription: 'reprompt',
  });
  let json: unknown;
  try {
    json = JSON.parse(endpoint);
  } catch {
    return unusable('not JSON');
  }
  if (!isSubscriptionJson(json)) return unusable('missing endpoint or keys');
  let audience: string;
  try {
    const url = new URL(json.endpoint);
    if (url.protocol !== 'https:') return unusable('endpoint is not https');
    audience = url.origin;
  } catch {
    return unusable('endpoint is not a URL');
  }
  let p256dh: Buffer;
  let auth: Buffer;
  try {
    p256dh = fromBase64url(json.keys.p256dh);
    auth = fromBase64url(json.keys.auth);
  } catch {
    return unusable('keys are not base64url');
  }
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) return unusable('p256dh is not a P-256 point');
  if (auth.length !== 16) return unusable('auth is not 16 bytes');
  return { kind: 'ok', endpoint: json.endpoint, audience, keys: { p256dh, auth } };
}

function isSubscriptionJson(value: unknown): value is PushSubscriptionJson {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { endpoint?: unknown; keys?: unknown };
  if (typeof candidate.endpoint !== 'string') return false;
  if (typeof candidate.keys !== 'object' || candidate.keys === null) return false;
  const keys = candidate.keys as { p256dh?: unknown; auth?: unknown };
  return typeof keys.p256dh === 'string' && typeof keys.auth === 'string';
}
