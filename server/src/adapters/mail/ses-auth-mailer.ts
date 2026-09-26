/**
 * The sign-in mailer — the `AuthMailer` port over Amazon SES v2 `SendEmail` (TASKS I1;
 * 05 §5.4.1 C2).
 *
 * **Why this is not the email alert channel.** A sign-in mail is transactional: one
 * message, sent inside the request that asked for it, whose failure must roll the link
 * row back (see `pg-auth.ts`). An alert goes through the outbox, the gateway's lint, the
 * rate buckets and a retry policy measured in hours — none of which a person waiting for
 * a link wants. So this adapter reuses the channel's *transport* (SigV4 signing and the
 * bounded, redirect-refusing request) and nothing of its delivery semantics. The
 * dependency-cruiser rule `auth-mailer-reuses-transport-only` pins exactly that: this file
 * may import `sigv4.ts` and `provider-http.ts`, never the channel.
 *
 * **EU only.** The region is checked here as well as in config: the address is personal
 * data, and SES processes it where the request is sent. The IAM principal whose keys this
 * uses needs `ses:SendEmail` and nothing else, scoped to the verified identity of the
 * auth-mail subdomain (README, "Sign-in").
 *
 * **Nothing secret leaves this file in an error.** The token, the link, the recipient and
 * both halves of the credential are redacted from anything SES or `fetch` says, and the
 * error this throws is built from the status and SES's error *type* alone — never its
 * message, which can quote the request back. The route's problem handler logs the error,
 * so that is the property the I1 wiring test checks against a real log sink.
 *
 * **The token rides in the fragment** (`#token=…`), which browsers never send to a server:
 * it stays out of access logs, `Referer` headers and a mail scanner's prefetch URL. The
 * landing page reads it and POSTs it on "Continue" (auth-route.ts).
 */

import { AUTH_POLICY } from '../../core/auth/auth-policy.js';
import { renderSignInMail } from '../../core/auth/sign-in-mail-copy.js';
import type { AuthMailer } from '../../core/ports/auth-stores.js';
import { providerRequest, type FetchLike } from '../alerts/channels/provider-http.js';
import { signRequest } from '../alerts/channels/email/sigv4.js';

export interface SesAuthMailerOptions {
  /** An EU SES region, e.g. `eu-central-1`. */
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The verified sender on the auth-mail subdomain. */
  readonly fromAddress: string;
  readonly configurationSetName: string | null;
  /** Absolute https URL of the landing page, no fragment. */
  readonly landingUrl: string;
  readonly now: () => number;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Override for tests; production derives `https://email.<region>.amazonaws.com`. */
  readonly endpointUrl?: string;
}

/** Short: the person is waiting on the request, and a slow SES rolls the link back. */
export const DEFAULT_AUTH_MAIL_TIMEOUT_MS = 10_000;
/** The same path the email channel posts to; duplicated so this file imports no channel. */
const SES_SEND_PATH = '/v2/email/outbound-emails';
const EU_REGION_RE = /^eu-[a-z]+-\d$/;

export function signInLinkUrl(landingUrl: string, token: string): string {
  return `${landingUrl}#token=${token}`;
}

export function createSesAuthMailer(options: SesAuthMailerOptions): AuthMailer {
  if (!EU_REGION_RE.test(options.region)) {
    throw new RangeError('sign-in mail must be sent through an EU SES region');
  }
  const landing = new URL(options.landingUrl);
  if (landing.protocol !== 'https:' || landing.hash !== '' || options.landingUrl.includes('#')) {
    throw new RangeError('sign-in landing URL must be https with no fragment');
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_MAIL_TIMEOUT_MS;
  const url = new URL(
    SES_SEND_PATH,
    options.endpointUrl ?? `https://email.${options.region}.amazonaws.com`,
  );
  const ttlMinutes = Math.round(AUTH_POLICY.linkTtlMs / 60_000);

  return {
    async sendSignInLink({ to, token }) {
      const link = signInLinkUrl(options.landingUrl, token);
      const mail = renderSignInMail({ link, ttlMinutes });
      const body = JSON.stringify({
        FromEmailAddress: options.fromAddress,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: mail.text, Charset: 'UTF-8' } },
          },
        },
        ...(options.configurationSetName !== null
          ? { ConfigurationSetName: options.configurationSetName }
          : {}),
      });
      const headers = signRequest(
        { method: 'POST', url, headers: { 'content-type': 'application/json' }, body },
        {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
          region: options.region,
          service: 'ses',
          now: options.now(),
        },
      );

      const result = await providerRequest({
        fetch: doFetch,
        url: url.href,
        method: 'POST',
        headers,
        body,
        timeoutMs,
        redact: [link, token, to, options.secretAccessKey, options.accessKeyId],
      });

      if (result.status === null) {
        // `result.error` is redacted, but it is `fetch`'s wording about a URL we built; the
        // status-free message below is all an operator needs, and all the log gets.
        throw new Error('sign-in mail not sent: ses request failed (network or timeout)');
      }
      if (result.status >= 200 && result.status < 300) return;
      const errorType = sesErrorType(result.headers, result.rawBody);
      throw new Error(
        `sign-in mail not sent: ses returned ${String(result.status)}` +
          (errorType === null ? '' : ` ${errorType}`),
      );
    },
  };
}

/**
 * SES's error type — the `x-amzn-errortype` header or the body's `__type`, namespace and
 * `Exception` suffix stripped — and only if it looks like an identifier, so a body that
 * put something else in `__type` cannot smuggle text into the error.
 */
function sesErrorType(headers: Headers, rawBody: string): string | null {
  let bodyType: string | null = null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = (parsed as { __type?: unknown }).__type;
      if (typeof candidate === 'string') bodyType = candidate;
    }
  } catch {
    // Not JSON: no type.
  }
  const raw = headers.get('x-amzn-errortype') ?? bodyType;
  if (raw === null) return null;
  const [name = ''] = raw.split(':');
  const type = name.replace(/Exception$/u, '');
  return /^[A-Za-z]{1,64}$/u.test(type) ? type : null;
}
