/**
 * The webhook POST over `node:https`, connected to the address the SSRF guard already
 * checked (TASKS V2-G2; docs/WEBHOOKS.md §1).
 *
 * `fetch` resolves the host itself, so a DNS server answering with a very short TTL could
 * hand the guard a public address and the socket a private one. Here the request's
 * `lookup` returns the checked address and nothing else, so no second resolution happens;
 * TLS still verifies the certificate against the host name (`servername`), and the `Host`
 * header is the URL's.
 *
 * Only the status line matters: the response is destroyed once its headers arrive, so a
 * receiver cannot make us read, buffer or wait for a body. Redirects are never followed
 * (`node:https` does not follow them); the caller sees the 3xx status.
 *
 * One timeout covers connect to headers. Every failure resolves `{ error }`, never throws.
 */

import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP, type LookupFunction } from 'node:net';

import { describeError } from '../provider-http.js';

export interface WebhookPostRequest {
  /** The validated URL. */
  readonly href: string;
  /**
   * The checked public address to connect to; null for an IP-literal URL, which needs no
   * lookup.
   */
  readonly address: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}

export type WebhookPostResult = { readonly status: number } | { readonly error: string };

export type WebhookPoster = (request: WebhookPostRequest) => Promise<WebhookPostResult>;

type RequestImpl = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

/**
 * `requestImpl` is `node:https`'s `request` in production; a test passes `node:http`'s to
 * reach a local server under a name that never resolves.
 */
export function createPinnedHttpsPoster(requestImpl: RequestImpl = httpsRequest): WebhookPoster {
  return (input) =>
    new Promise<WebhookPostResult>((resolve) => {
      let settled = false;
      let req: ClientRequest | undefined;
      const timer = setTimeout(() => {
        finish({ error: `TimeoutError: no response headers within ${String(input.timeoutMs)} ms` });
        req?.destroy();
      }, input.timeoutMs);
      const finish = (result: WebhookPostResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const url = new URL(input.href);
      // `URL.hostname` keeps the brackets of an IPv6 literal; the socket wants it bare.
      const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
      const options: RequestOptions = {
        protocol: url.protocol,
        hostname,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...input.headers, 'content-length': String(Buffer.byteLength(input.body)) },
        agent: false,
      };
      if (input.address !== null) {
        options.lookup = pinnedLookup(input.address);
        // SNI and certificate checks against the name, not the pinned address.
        options.servername = hostname;
      }

      try {
        req = requestImpl(options, (response) => {
          const status = response.statusCode ?? 0;
          response.destroy();
          req?.destroy();
          finish({ status });
        });
      } catch (error) {
        finish({ error: describeError(error) });
        return;
      }
      req.on('error', (error) => finish({ error: describeError(error) }));
      req.end(input.body);
    });
}

function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}
