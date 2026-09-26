import { describe, expect, it } from 'vitest';

import type { FetchLike } from '../alerts/channels/provider-http.js';
import {
  createSesAuthMailer,
  signInLinkUrl,
  type SesAuthMailerOptions,
} from './ses-auth-mailer.js';

const NOW = 1_758_200_000_000;
const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123';
const TO = 'reader@example.invalid';
const LANDING = 'https://app.example.invalid/sign-in';
const LINK = signInLinkUrl(LANDING, TOKEN);

function options(overrides: Partial<SesAuthMailerOptions> = {}): SesAuthMailerOptions {
  return {
    region: 'eu-central-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    fromAddress: 'sign-in@auth.example.invalid',
    configurationSetName: null,
    landingUrl: LANDING,
    now: () => NOW,
    ...overrides,
  };
}

function stubFetch(reply: () => Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const answer = reply();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { calls, fetch };
}

const send = { to: TO, token: TOKEN, expiresAtIso: '2025-09-18T13:08:20.000Z' };

describe('createSesAuthMailer (I1)', () => {
  it('posts one signed SES v2 SendEmail with the token in the link fragment', async () => {
    const { calls, fetch } = stubFetch(() => new Response('{"MessageId":"m-1"}', { status: 200 }));
    await createSesAuthMailer(options({ fetch })).sendSignInLink(send);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 .*\/eu-central-1\/ses\/aws4_request/u,
    );
    const body = JSON.parse(call?.init.body as string) as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[] };
      Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } };
      ConfigurationSetName?: string;
    };
    expect(body.FromEmailAddress).toBe('sign-in@auth.example.invalid');
    expect(body.Destination.ToAddresses).toEqual([TO]);
    expect(body.Content.Simple.Body.Text.Data).toContain(`${LANDING}#token=${TOKEN}`);
    expect(body.Content.Simple.Subject.Data).not.toContain(TOKEN);
    expect(body.ConfigurationSetName).toBeUndefined();
  });

  it('passes the configuration set when one is configured', async () => {
    const { calls, fetch } = stubFetch(() => new Response('{}', { status: 200 }));
    await createSesAuthMailer(options({ fetch, configurationSetName: 'auth' })).sendSignInLink(
      send,
    );
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({
      ConfigurationSetName: 'auth',
    });
  });

  it('refuses a non-EU region and a landing URL with a fragment or without https', () => {
    expect(() => createSesAuthMailer(options({ region: 'us-east-1' }))).toThrow(/EU SES region/u);
    expect(() => createSesAuthMailer(options({ landingUrl: `${LANDING}#x` }))).toThrow(RangeError);
    expect(() =>
      createSesAuthMailer(options({ landingUrl: 'http://app.example.invalid/' })),
    ).toThrow(RangeError);
  });

  it('throws on a refusal with the status and error type only — never the token, link or address', async () => {
    const echo = JSON.stringify({
      __type: 'MessageRejected',
      message: `Rejected ${TO}: ${LINK} (${TOKEN})`,
    });
    const { fetch } = stubFetch(() => new Response(echo, { status: 400 }));
    const failure = await createSesAuthMailer(options({ fetch }))
      .sendSignInLink(send)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    const text = `${String(failure)} ${(failure as Error).stack ?? ''}`;
    expect((failure as Error).message).toBe(
      'sign-in mail not sent: ses returned 400 MessageRejected',
    );
    for (const secret of [TOKEN, LINK, TO]) expect(text).not.toContain(secret);
  });

  it('does not let a crafted error type carry text into the error', async () => {
    const { fetch } = stubFetch(
      () => new Response('{}', { status: 500, headers: { 'x-amzn-errortype': `Bad ${TOKEN}:x` } }),
    );
    await expect(createSesAuthMailer(options({ fetch })).sendSignInLink(send)).rejects.toThrow(
      /^sign-in mail not sent: ses returned 500$/u,
    );
  });

  it('turns a network failure into a message with no URL, token or address', async () => {
    const { fetch } = stubFetch(() => new TypeError(`fetch failed for ${LINK} to ${TO}`));
    const failure = await createSesAuthMailer(options({ fetch }))
      .sendSignInLink(send)
      .catch((error: unknown) => error as Error);
    expect(failure?.message).toBe('sign-in mail not sent: ses request failed (network or timeout)');
  });
});
