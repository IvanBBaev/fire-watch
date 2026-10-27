/**
 * Signed webhooks (TASKS V2-G2; docs/WEBHOOKS.md): the payload an integrator receives and
 * the signature header that proves it came from Fire Watch.
 *
 * ## Why it lives in contracts
 *
 * The server writes these bytes and a third party verifies them. The shape and the
 * signing rule are a published interface, so they are versioned here beside the other
 * shared vocabulary rather than inside the channel adapter. The HMAC itself needs
 * `node:crypto` and lives in `@fire-watch/contracts/node`; everything here is
 * platform-neutral.
 *
 * ## The signature
 *
 * `X-FireWatch-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
 *
 * The timestamp is inside the signed content, so a captured request cannot be replayed
 * with a fresh `t`; a receiver rejects a `t` further than {@link DEFAULT_REPLAY_WINDOW_SECONDS}
 * from its own clock and de-duplicates on `delivery_id`. A header may carry more than one
 * `v1=` (reserved for a rotation overlap); a receiver accepts if any of them matches.
 *
 * ## Versioning
 *
 * `version` names the shape. Adding an optional field keeps `v1`; renaming, removing or
 * changing the meaning of a field is a new version, announced before it ships.
 */

/** The payload shape this module describes. */
export const WEBHOOK_PAYLOAD_VERSION = 'fire-watch.webhook.v1';

/** The request header carrying the signature. HTTP header names are case-insensitive. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-FireWatch-Signature';

/** The signature scheme tag inside the header. */
export const WEBHOOK_SIGNATURE_SCHEME = 'v1';

/** How far a receiver should let `t` drift from its own clock, either way. */
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

/**
 * The hazard every Fire Watch event is. A field rather than an assumption so that a
 * receiver aggregating several feeds can route on it, and so a second hazard is additive.
 */
export const WEBHOOK_HAZARD = 'wildfire';

export const WEBHOOK_PAYLOAD_TYPES = ['alert', 'ping'] as const;
export type WebhookPayloadType = (typeof WEBHOOK_PAYLOAD_TYPES)[number];

/** One owed credit, rendered for the `api` surface of the credits registry. */
export interface WebhookAttribution {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly href?: string;
}

/** The event an alert is about, as of the decision. */
export interface WebhookEvent {
  /** The public event id (`fw-YYYY-xxxxx`). */
  readonly id: string;
  /**
   * The event page on the public site — the same deep link the other channels carry.
   * `null` only when the alert's template carries none (the digest).
   */
  readonly permalink: string | null;
  readonly hazard: typeof WEBHOOK_HAZARD;
  /** The score bucket (`unverified` | `likely` | `confirmed`); never the raw score. */
  readonly severity: string;
  /** The lifecycle state at decision time. */
  readonly status: string;
  readonly started_at: string;
  readonly last_detection_at: string;
}

/** The alert as the other channels render it. */
export interface WebhookAlert {
  /** The decision type (`new_event`, `escalation`, …). */
  readonly type: string;
  readonly decided_at: string;
  readonly locale: string;
  readonly title: string;
  readonly body: string;
  /** The mandatory footer (FOOTER_REQUIREMENTS); a receiver that shows the alert shows it. */
  readonly footer: string;
}

interface WebhookEnvelope {
  readonly version: typeof WEBHOOK_PAYLOAD_VERSION;
  /**
   * Stable across retries of the same delivery: the idempotency key. A receiver that has
   * seen it acknowledges and does nothing.
   */
  readonly delivery_id: string;
  /** When this attempt was signed (equals the header's `t`, as ISO-8601). */
  readonly sent_at: string;
  readonly attribution: readonly WebhookAttribution[];
}

export interface WebhookAlertPayload extends WebhookEnvelope {
  readonly type: 'alert';
  readonly alert: WebhookAlert;
  readonly event: WebhookEvent;
}

/** What the test-ping route sends: no event, so a receiver can wire its verifier first. */
export interface WebhookPingPayload extends WebhookEnvelope {
  readonly type: 'ping';
  readonly endpoint_id: string;
}

export type WebhookPayload = WebhookAlertPayload | WebhookPingPayload;

/** The exact bytes the HMAC covers: the timestamp, a dot, the raw request body. */
export function webhookSignedContent(timestampSeconds: number, body: string): string {
  assertTimestamp(timestampSeconds);
  return `${String(timestampSeconds)}.${body}`;
}

/** The header value for one timestamp and one or more hex signatures. */
export function formatWebhookSignatureHeader(
  timestampSeconds: number,
  signatures: readonly string[],
): string {
  assertTimestamp(timestampSeconds);
  if (signatures.length === 0) throw new RangeError('a signature header needs a signature');
  for (const signature of signatures) {
    if (!HEX_SHA256_RE.test(signature)) {
      throw new RangeError('a v1 signature is 64 lowercase hex characters');
    }
  }
  return [
    `t=${String(timestampSeconds)}`,
    ...signatures.map((s) => `${WEBHOOK_SIGNATURE_SCHEME}=${s}`),
  ].join(',');
}

export interface ParsedWebhookSignature {
  readonly timestampSeconds: number;
  /** Every `v1=` value, lowercase hex. Unknown schemes are ignored, not rejected. */
  readonly signatures: readonly string[];
}

/** Parses a header value; `null` when it is not a well-formed v1 header. */
export function parseWebhookSignatureHeader(header: string): ParsedWebhookSignature | null {
  if (header.length > MAX_HEADER_CHARS) return null;
  let timestampSeconds: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (timestampSeconds !== null || !/^\d{1,12}$/.test(value)) return null;
      timestampSeconds = Number(value);
    } else if (key === WEBHOOK_SIGNATURE_SCHEME) {
      if (!HEX_SHA256_RE.test(value)) return null;
      signatures.push(value);
    }
  }
  if (timestampSeconds === null || signatures.length === 0) return null;
  return { timestampSeconds, signatures };
}

/** Whether `t` is within `toleranceSeconds` of `nowSeconds`, either way. */
export function isWithinReplayWindow(
  timestampSeconds: number,
  nowSeconds: number,
  toleranceSeconds: number = DEFAULT_REPLAY_WINDOW_SECONDS,
): boolean {
  return Math.abs(nowSeconds - timestampSeconds) <= toleranceSeconds;
}

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_HEADER_CHARS = 1024;

function assertTimestamp(timestampSeconds: number): void {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new RangeError('a webhook timestamp is a non-negative integer of unix seconds');
  }
}
