/**
 * The `email` channel — Amazon SES v2 `SendEmail`, signed with SigV4, one plain-text
 * message per outbox row.
 *
 * Email is the slow channel by design (04-sre §5: "push first, Telegram second, email
 * last") and the one whose provider limit is a *quota* rather than a rate: 1/s in the
 * sandbox, 14/s once production access is granted, raised on request (GATES L-6). The
 * bucket in front of this adapter runs at D6's 12/s; what this adapter adds is the
 * reading of SES's answer when the quota, not the bucket, is what said no.
 *
 * The table, from the SES v2 API reference's error list:
 *
 *   | error type                                  | outcome                    | why                              |
 *   |---------------------------------------------|----------------------------|----------------------------------|
 *   | 2xx `{MessageId}`                           | delivered                  | accepted for delivery            |
 *   | `TooManyRequestsException`                  | transient, channel paused  | per-second rate; wait a beat     |
 *   |                                             | `Retry-After` or 1 s       |                                  |
 *   | `LimitExceeded`, `SendingPaused`,           | transient, channel paused  | daily quota or account state;    |
 *   | `AccountSuspended`                          | for the quota backoff      | nothing shorter than minutes     |
 *   |                                             |                            | changes it, and the queue        |
 *   |                                             |                            | expires at 6 h anyway            |
 *   | `MessageRejected`, `BadRequest`,            | permanent · `keep`         | our message or our sandbox;      |
 *   | other 4xx                                   |                            | the address is fine              |
 *   | 401, 403 (signature, access denied),        | transient                  | *our* credentials or config —    |
 *   | `MailFromDomainNotVerified`, `NotFound`     |                            | never prune an address for it    |
 *   | 5xx, network                                | transient                  | retried until D6's 6 h expiry    |
 *
 * Nothing here ever returns `prune` for something SES said: SES accepts a syntactically
 * valid address it has never seen and only later learns it bounces. Bounces and
 * complaints arrive asynchronously through SNS (04-sre §5 "deliverability hygiene"), and
 * the handler that turns them into `prune` is not this adapter — it is the piece H5
 * leaves open and OPERATIONS names. The one `prune` this adapter does return is for a
 * stored address that is not an address at all, which no future event will fix.
 *
 * The secret access key is scrubbed from every error; the access key id is not a
 * secret but is scrubbed too, because a log line with half a credential is a log line
 * someone will grep for the other half.
 */

import type {
  AlertChannelAdapter,
  DeliveryOutcome,
  OutboundMessage,
} from '../../../../core/ports/alert-channel.js';
import { excerpt, providerRequest, retryAfterMs, type FetchLike } from '../provider-http.js';
import { signRequest, type AwsCredentials } from './sigv4.js';

export interface SesChannelOptions {
  readonly credentials: AwsCredentials;
  /** e.g. `eu-central-1` (04-sre §5). */
  readonly region: string;
  /** The verified sender, on the dedicated alerts subdomain (04-sre §5). */
  readonly fromAddress: string;
  /** SES configuration set, for SNS event publishing of bounces and complaints. */
  readonly configurationSetName?: string;
  readonly now: () => number;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Override for tests; production derives `https://email.<region>.amazonaws.com`. */
  readonly endpointUrl?: string;
  /** Pause after a per-second throttle with no `Retry-After`. */
  readonly throttleBackoffMs?: number;
  /** Pause after a quota or account-state refusal. */
  readonly quotaBackoffMs?: number;
}

export const DEFAULT_SES_TIMEOUT_MS = 15_000;
export const DEFAULT_SES_THROTTLE_BACKOFF_MS = 1_000;
export const DEFAULT_SES_QUOTA_BACKOFF_MS = 5 * 60_000;
export const SES_SEND_PATH = '/v2/email/outbound-emails';

/** The subset of the SES v2 `SendEmail` request this adapter fills. */
export interface SesSendEmailRequest {
  readonly FromEmailAddress: string;
  readonly Destination: { readonly ToAddresses: readonly string[] };
  readonly Content: {
    readonly Simple: {
      readonly Subject: { readonly Data: string; readonly Charset: 'UTF-8' };
      readonly Body: { readonly Text: { readonly Data: string; readonly Charset: 'UTF-8' } };
      /**
       * SES v2 `Message.Headers` — custom headers on a Simple message. Only
       * `Content-Language` is set, from `OutboundMessage.locale`, so a mail client knows
       * which language the already-rendered copy is in (spell-check, translation offers,
       * screen-reader voice).
       */
      readonly Headers: readonly { readonly Name: string; readonly Value: string }[];
    };
  };
  readonly ConfigurationSetName?: string;
}

/**
 * SES's error envelope: the type from the `x-amzn-errortype` header (sometimes
 * `Name:http://internal.amazon.com/coral/...`; the name is kept) or the JSON body's
 * `__type`, and the human-readable `message`. `rawBody` is already redacted.
 */
function parseErrorEnvelope(
  headers: Headers,
  rawBody: string,
): { readonly type: string | null; readonly message: string | null } {
  let bodyType: string | null = null;
  let message: string | null = null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed === 'object' && parsed !== null) {
      const envelope = parsed as { __type?: unknown; message?: unknown };
      if (typeof envelope.__type === 'string') bodyType = envelope.__type;
      if (typeof envelope.message === 'string' && envelope.message.length > 0) {
        message = excerpt(envelope.message);
      }
    }
  } catch {
    // Not JSON; the caller falls back to the body excerpt.
  }
  const rawType = headers.get('x-amzn-errortype') ?? bodyType;
  if (rawType === null) return { type: null, message };
  const [name = ''] = rawType.split(':');
  const type = name.replace(/Exception$/, '');
  return { type: type.length > 0 ? type : null, message };
}

const CREDENTIAL_ERRORS = new Set([
  'AccessDenied',
  'InvalidSignature',
  'SignatureDoesNotMatch',
  'UnrecognizedClient',
  'IncompleteSignature',
  'ExpiredToken',
  'InvalidClientTokenId',
  'MailFromDomainNotVerified',
  'NotFound',
]);
const QUOTA_ERRORS = new Set(['LimitExceeded', 'SendingPaused', 'AccountSuspended']);

export function createSesChannel(options: SesChannelOptions): AlertChannelAdapter {
  if (!isEmailAddress(options.fromAddress)) {
    throw new RangeError('SES from address is not an email address');
  }
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(options.region)) {
    throw new RangeError('SES region must look like eu-central-1');
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SES_TIMEOUT_MS;
  const throttleBackoffMs = options.throttleBackoffMs ?? DEFAULT_SES_THROTTLE_BACKOFF_MS;
  const quotaBackoffMs = options.quotaBackoffMs ?? DEFAULT_SES_QUOTA_BACKOFF_MS;
  const url = new URL(
    SES_SEND_PATH,
    options.endpointUrl ?? `https://email.${options.region}.amazonaws.com`,
  );
  const redact = [options.credentials.secretAccessKey, options.credentials.accessKeyId];

  let pausedUntil: number | null = null;

  return {
    channel: 'email',
    async deliver(message: OutboundMessage): Promise<DeliveryOutcome> {
      if (message.channel !== 'email') {
        // Inside an `async` function this is a rejection, not a synchronous throw.
        throw new TypeError(`email channel received a message routed to ${message.channel}`);
      }

      if (!isEmailAddress(message.endpoint)) {
        return {
          kind: 'permanent',
          error: 'email address unusable: not an email address',
          subscription: 'prune',
        };
      }

      const now = options.now();
      if (pausedUntil !== null) {
        if (now < pausedUntil) {
          return {
            kind: 'transient',
            error: `ses backing off for ${String(pausedUntil - now)} ms`,
          };
        }
        pausedUntil = null;
      }

      const body = JSON.stringify(sendEmailRequest(message, options));
      const headers = signRequest(
        { method: 'POST', url, headers: { 'content-type': 'application/json' }, body },
        { credentials: options.credentials, region: options.region, service: 'ses', now },
      );

      const result = await providerRequest({
        fetch: doFetch,
        url: url.href,
        method: 'POST',
        headers,
        body,
        timeoutMs,
        redact,
      });

      if (result.status === null) {
        return { kind: 'transient', error: `ses request failed: ${result.error}` };
      }
      const { status } = result;
      const { type: errorType, message: errorMessage } = parseErrorEnvelope(
        result.headers,
        result.rawBody,
      );
      const reason = describeReason(errorType, errorMessage ?? result.body);

      if (status >= 200 && status < 300) {
        return { kind: 'delivered', providerAckAt: options.now() };
      }
      if (status === 429 || errorType === 'TooManyRequests') {
        const backoff = retryAfterMs(result.headers, now) ?? throttleBackoffMs;
        pausedUntil = now + backoff;
        return {
          kind: 'transient',
          error: `ses throttled; backing off ${String(backoff)} ms${reason}`,
        };
      }
      if (errorType !== null && QUOTA_ERRORS.has(errorType)) {
        pausedUntil = now + quotaBackoffMs;
        return {
          kind: 'transient',
          error: `ses ${errorType}; backing off ${String(quotaBackoffMs)} ms${reason}`,
        };
      }
      if (
        status === 401 ||
        status === 403 ||
        (errorType !== null && CREDENTIAL_ERRORS.has(errorType))
      ) {
        return {
          kind: 'transient',
          error: `ses refused our credentials or configuration (${String(status)})${reason}`,
        };
      }
      if (status >= 400 && status < 500) {
        return {
          kind: 'permanent',
          error: `ses returned ${String(status)}${reason}`,
          subscription: 'keep',
        };
      }
      return { kind: 'transient', error: `ses returned ${String(status)}${reason}` };
    },
  };
}

/**
 * Subject is the title; the text body is body, deep link, footer, blank-line separated;
 * `Content-Language` is the row's stored locale (RFC 3282 — `bg` and `en` are already
 * valid language tags, so the value passes through unchanged).
 */
function sendEmailRequest(
  message: OutboundMessage,
  options: SesChannelOptions,
): SesSendEmailRequest {
  const { title, body, footer, url } = message.rendered;
  const text = [body, url, footer].filter((part) => part !== null && part.length > 0).join('\n\n');
  return {
    FromEmailAddress: options.fromAddress,
    Destination: { ToAddresses: [message.endpoint] },
    Content: {
      Simple: {
        Subject: { Data: title, Charset: 'UTF-8' },
        Body: { Text: { Data: text, Charset: 'UTF-8' } },
        Headers: [{ Name: 'Content-Language', Value: message.locale }],
      },
    },
    ...(options.configurationSetName !== undefined
      ? { ConfigurationSetName: options.configurationSetName }
      : {}),
  };
}

/** `: <ErrorType>: <message>` — whichever of the two SES gave us, or nothing. */
function describeReason(errorType: string | null, text: string): string {
  const parts = [errorType, text].filter((part) => part !== null && part.length > 0);
  return parts.length > 0 ? `: ${parts.join(': ')}` : '';
}

/**
 * Enough of RFC 5322 to reject what SES would reject with a 400 anyway, and what a
 * corrupted row would carry: one `@`, no whitespace, a dotted domain.
 */
function isEmailAddress(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) && text.length <= 254;
}
