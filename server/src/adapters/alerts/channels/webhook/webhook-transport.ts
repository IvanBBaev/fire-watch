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
 *   4. **One request, pinned, no redirects** (`createPinnedHttpsPoster`): the socket
 *      connects to the address step 2 checked, never to a second resolution, so a DNS
 *      answer swapped between the check and the connect cannot reach a private address.
 *      A 3xx is not followed, since it could point the signed POST at an address the guard
 *      never checked; it is retried like a network error. Only the status line is read:
 *      the response is dropped once its headers arrive.
 *
 * The secret is redacted from every error text, and so is the URL, whose path or query
 * may carry the receiver's own token; the error names the host only.
 *
 * An injected `fetch` (tests, the wiring's shared seam) replaces the pinned poster and
 * resolves the name itself; production injects none.
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
import { describeError, type FetchLike } from '../provider-http.js';
import {
  createPinnedHttpsPoster,
  type WebhookPostRequest,
  type WebhookPoster,
  type WebhookPostResult,
} from './pinned-https-post.js';

export const WEBHOOK_USER_AGENT = 'FireWatch-Webhook/1';

export interface WebhookTransportOptions {
  readonly resolver: HostResolver;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly rules: WebhookUrlRules;
  /** Replaces the pinned `node:https` poster. */
  readonly post?: WebhookPoster;
  /** Replaces the poster with an unpinned `fetch`; ignored when `post` is given. */
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
  const post =
    options.post ??
    (options.fetch === undefined ? createPinnedHttpsPoster() : fetchPoster(options.fetch));

  return {
    async send(request) {
      const startedAt = options.now();
      const elapsed = (): number => Math.max(0, Math.round(options.now() - startedAt));
      const scrub = (text: string): string =>
        cap(
          [request.secret, request.url, check.ok ? check.href : '']
            .filter((s) => s.length > 0)
            .reduce((acc, s) => acc.split(s).join('<redacted>'), text),
        );

      const check = validateWebhookUrl(request.url, options.rules);
      if (!check.ok) {
        return refused(`webhook url refused: ${check.reason}`, elapsed());
      }

      let address: string | null = null;
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
        // Every answer is public; connect to the first, so the socket never resolves again.
        address = addresses[0] ?? null;
      }

      const timestampSeconds = Math.floor(options.now() / 1000);
      const signature = signWebhookPayload(request.secret, timestampSeconds, request.body);
      const result = await post({
        href: check.href,
        address,
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
      });

      if ('error' in result) {
        return {
          class: 'retry',
          statusCode: null,
          error: scrub(`webhook request to ${check.host} failed: ${result.error}`),
          durationMs: elapsed(),
        };
      }
      if (result.status >= 300 && result.status < 400) {
        return {
          class: 'retry',
          statusCode: result.status,
          error: `webhook ${check.host} answered ${String(result.status)}; redirects are not followed`,
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

/** The `fetch` seam: unpinned, no redirects, the body cancelled unread. */
export function fetchPoster(doFetch: FetchLike): WebhookPoster {
  return async (input: WebhookPostRequest): Promise<WebhookPostResult> => {
    try {
      const response = await doFetch(input.href, {
        method: 'POST',
        headers: input.headers,
        body: input.body,
        redirect: 'error',
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status };
    } catch (error) {
      return { error: describeError(error) };
    }
  };
}

function refused(error: string, durationMs: number): WebhookSendResult {
  return { class: 'refused', statusCode: null, error: cap(error), durationMs };
}

function cap(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}
