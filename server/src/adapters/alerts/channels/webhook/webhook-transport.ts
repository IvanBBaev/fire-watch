/**
 * One signed webhook POST (TASKS V2-G2; docs/WEBHOOKS.md): the SSRF guard, the signature
 * and the bounded request, shared by the alert channel and the owner's test ping.
 *
 * In order, for every attempt:
 *
 *   1. **The URL is validated again** (`validateWebhookUrl`). It was validated at
 *      registration; re-checking costs nothing and covers a rule tightened since.
 *   2. **The host is resolved and every address must be public** (`allAddressesPublic`):
 *      a name that resolved to a public address at registration and to `10.0.0.5` today
 *      is refused, before a socket is opened. A failed lookup is a retry, like any other
 *      network error; a private answer is `refused`, which is not retried.
 *   3. **The body is signed** — `X-FireWatch-Signature: t=<unix>,v1=<hex>` over
 *      `"<t>.<body>"` with the endpoint's secret.
 *   4. **One request, no redirects** (`providerRequest`, `redirect: 'error'`): a redirect
 *      could point the signed POST at an internal address the guard never checked.
 *
 * The secret is redacted from every error text, and so is the URL, whose path or query
 * may carry the receiver's own token; the error names the host only.
 *
 * Known limits, both in docs/WEBHOOKS.md: the guard and `fetch` resolve the name
 * separately (a DNS-rebinding window of one TTL), and the response body is read whole,
 * bounded only by the timeout.
 */

import { WEBHOOK_SIGNATURE_HEADER, formatWebhookSignatureHeader } from '@fire-watch/contracts';
import { signWebhookPayload } from '@fire-watch/contracts/node';

import type { HostResolver } from '../../../../core/ports/webhook-store.js';
import {
  allAddressesPublic,
  validateWebhookUrl,
  type WebhookUrlRules,
} from '../../../../core/webhooks/webhook-url.js';
import {
  classifyWebhookAttempt,
  type WebhookAttemptClass,
} from '../../../../core/webhooks/webhook-retry.js';
import { describeError, providerRequest, type FetchLike } from '../provider-http.js';

export const WEBHOOK_USER_AGENT = 'FireWatch-Webhook/1';

export interface WebhookTransportOptions {
  readonly resolver: HostResolver;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly rules: WebhookUrlRules;
  readonly fetch?: FetchLike;
}

export interface WebhookSendRequest {
  readonly url: string;
  readonly secret: string;
  /** The serialised payload: the exact bytes signed and sent. */
  readonly body: string;
  readonly deliveryId: string;
}

/** `refused`: the guard stopped the send before the network. */
export type WebhookSendClass = WebhookAttemptClass | 'refused';

export interface WebhookSendResult {
  readonly class: WebhookSendClass;
  readonly statusCode: number | null;
  /** Our own text; never the receiver's body. Null on delivery. */
  readonly error: string | null;
  readonly durationMs: number;
}

export interface WebhookTransport {
  send(request: WebhookSendRequest): Promise<WebhookSendResult>;
}

/** The log column holds at most 512 characters. */
const MAX_ERROR_CHARS = 500;

export function createWebhookTransport(options: WebhookTransportOptions): WebhookTransport {
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async send(request) {
      const startedAt = options.now();
      const elapsed = (): number => Math.max(0, Math.round(options.now() - startedAt));
      const scrub = (text: string): string =>
        cap(
          [request.secret, request.url]
            .filter((s) => s.length > 0)
            .reduce((acc, s) => acc.split(s).join('<redacted>'), text),
        );

      const check = validateWebhookUrl(request.url, options.rules);
      if (!check.ok) {
        return refused(`webhook url refused: ${check.reason}`, elapsed());
      }

      if (!check.ipLiteral) {
        let addresses: readonly string[];
        try {
          addresses = await options.resolver.resolve(check.host);
        } catch (error) {
          return {
            class: 'retry',
            statusCode: null,
            error: scrub(`webhook host ${check.host} did not resolve: ${describeError(error)}`),
            durationMs: elapsed(),
          };
        }
        if (!allAddressesPublic(addresses)) {
          return refused(`webhook host ${check.host} resolves to a non-public address`, elapsed());
        }
      }

      const timestampSeconds = Math.floor(options.now() / 1000);
      const signature = signWebhookPayload(request.secret, timestampSeconds, request.body);
      const result = await providerRequest({
        fetch: doFetch,
        url: check.href,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': WEBHOOK_USER_AGENT,
          'x-firewatch-delivery': request.deliveryId,
          [WEBHOOK_SIGNATURE_HEADER.toLowerCase()]: formatWebhookSignatureHeader(timestampSeconds, [
            signature,
          ]),
        },
        body: request.body,
        timeoutMs: options.timeoutMs,
        redact: [request.secret, request.url, check.href],
      });

      if (result.status === null) {
        return {
          class: 'retry',
          statusCode: null,
          error: scrub(`webhook request to ${check.host} failed: ${result.error}`),
          durationMs: elapsed(),
        };
      }
      const statusClass = classifyWebhookAttempt(result.status);
      return {
        class: statusClass,
        // A status outside 100–599 cannot be logged as one; the class still holds.
        statusCode: result.status >= 100 && result.status <= 599 ? result.status : null,
        error:
          statusClass === 'delivered'
            ? null
            : `webhook ${check.host} answered ${String(result.status)}`,
        durationMs: elapsed(),
      };
    },
  };
}

function refused(error: string, durationMs: number): WebhookSendResult {
  return { class: 'refused', statusCode: null, error: cap(error), durationMs };
}

function cap(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}
