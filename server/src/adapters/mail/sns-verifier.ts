/**
 * Proof that a POST to the SES feedback hook came from Amazon SNS, for our topic, recently
 * — the gate in front of `core/alerts/email-feedback.ts`, which revokes channels and must
 * therefore never act on a body anyone could have written.
 *
 * SNS signs each message with an RSA key whose certificate it publishes, and names the
 * certificate in the message itself (AWS SNS developer guide, "Verifying the signatures of
 * Amazon SNS messages"). That makes the certificate URL the attack surface: a forged
 * message naming a certificate the forger controls verifies perfectly. So the URL is
 * checked before it is fetched, and the checks are the ones AWS prescribes:
 *
 *   * **`https:` only**, and the host must be `sns.<region>.amazonaws.com` — matched as a
 *     whole against {@link SNS_HOST_RE}, not as a suffix, so `sns.evil.amazonaws.com.example`
 *     and `attacker-sns.us-east-1.amazonaws.com` both fail. The path must end in `.pem`.
 *     No port, no credentials in the URL. Redirects are refused, so an allowed host cannot
 *     bounce the fetch somewhere that is not.
 *   * **The canonical string** is the listed fields as `Name\nvalue\n` pairs in byte order
 *     of the names — for a `Notification`: Message, MessageId, Subject (only when present),
 *     Timestamp, TopicArn, Type; for `SubscriptionConfirmation` and
 *     `UnsubscribeConfirmation`: Message, MessageId, SubscribeURL, Timestamp, Token,
 *     TopicArn, Type. The signature covers field *values*, not the HTTP body bytes, so a
 *     body re-serialized by a parser still verifies.
 *   * **`SignatureVersion` 1 is SHA1withRSA, 2 is SHA256withRSA.** Both are accepted
 *     because the version is a per-topic setting the founder may not have changed; v1 is
 *     SNS's default. Anything else is refused rather than guessed at.
 *
 * Two checks are ours, beyond AWS's list. **The topic**: a signature proves SNS sent the
 * message, not that it was sent to us — anyone can create a topic, subscribe our URL and
 * publish a bounce for an address they want silenced. A `TopicArn` other than the
 * configured one is refused before any certificate is fetched. **The age**: a captured
 * message stays validly signed forever, so a `Timestamp` more than an hour old is refused
 * as a replay (SNS's HTTP retry policy gives up well inside that), and one more than
 * {@link MAX_FUTURE_SKEW_MS} in the future is refused as nonsense.
 *
 * Certificates are cached by URL for the process lifetime, bounded at
 * {@link MAX_CACHED_CERTS} — SNS rotates them rarely and every message of a topic names
 * the same one, so after the first message a verification is a local RSA check. A failed
 * fetch is not cached. An expired certificate is refused, and evicted so a renewal at the
 * same URL is picked up.
 *
 * `SubscriptionConfirmation` is the one message that makes us fetch a URL from the body:
 * confirming it is what starts the flow of feedback. It is confirmed only after the same
 * signature, topic and age checks pass, and only if `SubscribeURL` passes the same host
 * rule as the certificate. `UnsubscribeConfirmation` is verified and then left alone —
 * re-subscribing on our own would undo an operator's deliberate unsubscribe.
 *
 * `fetch` and `now` are injected: the tests sign with a key they generate, and the clock
 * is the caller's.
 */

import { createVerify, X509Certificate } from 'node:crypto';

import type { EpochMs } from '../../core/ports/clock.js';

/**
 * The certificate and confirmation fetches. Declared here rather than taken from the
 * channels' `provider-http.ts`: this module receives notifications and sends none, so it
 * stays outside ADR-004 D1's gateway boundary (`only-the-gateway-sends`).
 */
export type FetchLike = typeof globalThis.fetch;

/** AWS's own pattern for SNS endpoints, anchored at both ends. */
export const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com$/u;
/** The replay guard. */
export const MAX_MESSAGE_AGE_MS = 3_600_000;
/** A clock a few minutes off is ordinary; a message from tomorrow is not. */
export const MAX_FUTURE_SKEW_MS = 300_000;
export const MAX_CACHED_CERTS = 16;
/** A PEM certificate is a couple of kilobytes; this is generous and still bounded. */
const MAX_CERT_BYTES = 16_384;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export type SnsMessageType =
  'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';

/** The parsed envelope — every field the canonical string or the caller needs. */
export interface SnsEnvelope {
  readonly type: SnsMessageType;
  readonly messageId: string;
  readonly topicArn: string;
  readonly message: string;
  readonly timestamp: string;
  readonly signatureVersion: '1' | '2';
  readonly signature: string;
  readonly signingCertUrl: string;
  /** Notification only, and optional there. */
  readonly subject?: string;
  /** The two confirmation types only. */
  readonly subscribeUrl?: string;
  readonly token?: string;
}

/** Why a message was refused — a closed vocabulary, safe to log. */
export type SnsRejection =
  | 'malformed'
  | 'unsupported_type'
  | 'unsupported_signature_version'
  | 'wrong_topic'
  | 'stale'
  | 'from_the_future'
  | 'bad_cert_url'
  | 'cert_unavailable'
  | 'cert_expired'
  | 'bad_signature';

export type SnsVerification =
  | { readonly ok: true; readonly envelope: SnsEnvelope }
  | { readonly ok: false; readonly reason: SnsRejection };

export type SubscriptionConfirmationResult = 'confirmed' | 'bad_subscribe_url' | 'failed';

export interface SnsVerifierOptions {
  /** The one topic this hook accepts (`FIRE_WATCH_SES_FEEDBACK_TOPIC_ARN`). */
  readonly topicArn: string;
  readonly fetch: FetchLike;
  readonly fetchTimeoutMs?: number;
}

export interface SnsVerifier {
  /** Parses and verifies a request body (a string, or what a JSON parser made of one). */
  verify(body: unknown, now: EpochMs): Promise<SnsVerification>;
  /** GETs a verified `SubscriptionConfirmation`'s `SubscribeURL`, if its host is SNS's. */
  confirmSubscription(envelope: SnsEnvelope): Promise<SubscriptionConfirmationResult>;
}

export function createSnsVerifier(options: SnsVerifierOptions): SnsVerifier {
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const certs = new Map<string, X509Certificate>();

  async function certificate(url: string): Promise<X509Certificate | null> {
    const cached = certs.get(url);
    if (cached !== undefined) return cached;
    let pem: string;
    try {
      const response = await options.fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      pem = await response.text();
    } catch {
      return null;
    }
    if (pem.length > MAX_CERT_BYTES) return null;
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch {
      return null;
    }
    if (certs.size >= MAX_CACHED_CERTS) {
      // Oldest first: Map iterates in insertion order.
      const oldest = certs.keys().next().value;
      if (oldest !== undefined) certs.delete(oldest);
    }
    certs.set(url, cert);
    return cert;
  }

  return {
    async verify(body, now) {
      const parsed = parseSnsEnvelope(body);
      if (typeof parsed === 'string') return { ok: false, reason: parsed };
      const envelope = parsed;

      // Cheapest refusals first: nothing below costs a network round trip until the
      // certificate, and a message for someone else's topic never gets that far.
      if (envelope.topicArn !== options.topicArn) return { ok: false, reason: 'wrong_topic' };
      const sentAt = Date.parse(envelope.timestamp);
      if (!Number.isFinite(sentAt)) return { ok: false, reason: 'malformed' };
      if (now - sentAt > MAX_MESSAGE_AGE_MS) return { ok: false, reason: 'stale' };
      if (sentAt - now > MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'from_the_future' };
      if (!isSnsUrl(envelope.signingCertUrl, { pem: true })) {
        return { ok: false, reason: 'bad_cert_url' };
      }

      const cert = await certificate(envelope.signingCertUrl);
      if (cert === null) return { ok: false, reason: 'cert_unavailable' };
      if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
        certs.delete(envelope.signingCertUrl);
        return { ok: false, reason: 'cert_expired' };
      }

      const verifier = createVerify(envelope.signatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
      verifier.update(canonicalSnsString(envelope), 'utf8');
      let valid: boolean;
      try {
        valid = verifier.verify(cert.publicKey, envelope.signature, 'base64');
      } catch {
        valid = false;
      }
      return valid ? { ok: true, envelope } : { ok: false, reason: 'bad_signature' };
    },

    async confirmSubscription(envelope) {
      const url = envelope.subscribeUrl;
      if (
        envelope.type !== 'SubscriptionConfirmation' ||
        url === undefined ||
        !isSnsUrl(url, { pem: false })
      ) {
        return 'bad_subscribe_url';
      }
      try {
        const response = await options.fetch(url, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        // The body is an XML receipt with the subscription ARN; nothing in it is needed.
        await response.body?.cancel();
        return response.ok ? 'confirmed' : 'failed';
      } catch {
        return 'failed';
      }
    },
  };
}

/** The string SNS signed, per message type. Exported for the tests' signer. */
export function canonicalSnsString(envelope: SnsEnvelope): string {
  const pairs: [string, string | undefined][] =
    envelope.type === 'Notification'
      ? [
          ['Message', envelope.message],
          ['MessageId', envelope.messageId],
          ['Subject', envelope.subject],
          ['Timestamp', envelope.timestamp],
          ['TopicArn', envelope.topicArn],
          ['Type', envelope.type],
        ]
      : [
          ['Message', envelope.message],
          ['MessageId', envelope.messageId],
          ['SubscribeURL', envelope.subscribeUrl],
          ['Timestamp', envelope.timestamp],
          ['Token', envelope.token],
          ['TopicArn', envelope.topicArn],
          ['Type', envelope.type],
        ];
  let canonical = '';
  for (const [name, value] of pairs) {
    if (value !== undefined) canonical += `${name}\n${value}\n`;
  }
  return canonical;
}

/**
 * Whether `raw` is an `https:` URL on an SNS host, with no port or credentials, and —
 * for a certificate — a `.pem` path. Exported because the rule is the security boundary
 * and deserves its own table of cases.
 */
export function isSnsUrl(raw: string, options: { readonly pem: boolean }): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    SNS_HOST_RE.test(url.hostname) &&
    (!options.pem || url.pathname.endsWith('.pem'))
  );
}

/** The envelope, or the rejection that names what was wrong with it. */
export function parseSnsEnvelope(body: unknown): SnsEnvelope | SnsRejection {
  let value: unknown = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      return 'malformed';
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'malformed';
  const record = value as Record<string, unknown>;
  const text = (name: string): string | undefined =>
    typeof record[name] === 'string' ? record[name] : undefined;

  const type = text('Type');
  if (type === undefined) return 'malformed';
  if (
    type !== 'Notification' &&
    type !== 'SubscriptionConfirmation' &&
    type !== 'UnsubscribeConfirmation'
  ) {
    return 'unsupported_type';
  }
  const version = text('SignatureVersion');
  if (version !== '1' && version !== '2') return 'unsupported_signature_version';

  const messageId = text('MessageId');
  const topicArn = text('TopicArn');
  const message = text('Message');
  const timestamp = text('Timestamp');
  const signature = text('Signature');
  const signingCertUrl = text('SigningCertURL');
  if (
    messageId === undefined ||
    topicArn === undefined ||
    message === undefined ||
    timestamp === undefined ||
    signature === undefined ||
    signingCertUrl === undefined
  ) {
    return 'malformed';
  }
  const common = {
    type,
    messageId,
    topicArn,
    message,
    timestamp,
    signatureVersion: version,
    signature,
    signingCertUrl,
  } as const;

  if (type === 'Notification') {
    const subject = text('Subject');
    return subject === undefined ? common : { ...common, subject };
  }
  const subscribeUrl = text('SubscribeURL');
  const token = text('Token');
  if (subscribeUrl === undefined || token === undefined) return 'malformed';
  return { ...common, subscribeUrl, token };
}
