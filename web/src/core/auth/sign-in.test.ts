/**
 * Sign-in token hygiene and the auth client's outcome mapping (TASKS I1).
 *
 * The token must leave the URL in the same synchronous step that reads it, must be sent
 * only in the body of `POST /api/v1/auth/continue`, and must never be logged.
 */

import { PROBLEM_CODES } from '@fire-watch/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_ACCOUNT_URL,
  AUTH_CONTINUE_URL,
  AUTH_LINK_URL,
  AUTH_LOGOUT_URL,
  SIGN_IN_CONTINUE_PATH,
  SIGN_IN_READING_BY_CODE,
  availabilityOf,
  continueOutcomeOf,
  createAuthClient,
  requestLinkOutcomeOf,
  sessionStateOf,
  takeSignInToken,
  type HistoryLike,
} from './sign-in.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'; // 43 chars, base64url

function historySpy(): HistoryLike & { readonly urls: (string | null | undefined)[] } {
  const urls: (string | null | undefined)[] = [];
  return {
    urls,
    replaceState: (_data, _unused, url) => {
      urls.push(url);
    },
  };
}

/**
 * A problem document as the server writes it. The title is deliberately not the server's:
 * the client must read the `code` and nothing else.
 */
function problem(status: number, code?: string, headers: Record<string, string> = {}): Response {
  const body = {
    type: 'about:blank',
    title: 'Any title',
    status,
    ...(code === undefined ? {} : { code }),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}

describe('takeSignInToken', () => {
  it('returns the token and strips it from the URL in the same call', () => {
    const history = historySpy();
    const taken = takeSignInToken({ pathname: '/', search: '', hash: `#token=${TOKEN}` }, history);
    expect(taken).toEqual({ kind: 'token', token: TOKEN });
    expect(history.urls).toEqual([SIGN_IN_CONTINUE_PATH]);
    expect(history.urls.join()).not.toContain(TOKEN);
  });

  it('keeps the query and every other fragment member', () => {
    const history = historySpy();
    takeSignInToken(
      {
        pathname: '/sign-in/continue',
        search: '?lang=bg',
        hash: `#map=8/42.7/23.3&token=${TOKEN}`,
      },
      history,
    );
    expect(history.urls).toEqual([`${SIGN_IN_CONTINUE_PATH}?lang=bg#map=8/42.7/23.3`]);
  });

  it('leaves a URL without a token alone', () => {
    const history = historySpy();
    expect(
      takeSignInToken({ pathname: '/', search: '', hash: '#map=8/42.7/23.3' }, history),
    ).toEqual({
      kind: 'none',
    });
    expect(takeSignInToken({ pathname: '/', search: '', hash: '' }, history)).toEqual({
      kind: 'none',
    });
    expect(history.urls).toEqual([]);
  });

  it.each([
    ['empty', '#token='],
    ['not base64url', '#token=abc%20def'],
    ['too long', `#token=${'a'.repeat(129)}`],
    ['two tokens', `#token=${TOKEN}&token=${TOKEN}`],
  ])('strips but never returns a malformed token (%s)', (_name, hash) => {
    const history = historySpy();
    expect(takeSignInToken({ pathname: '/', search: '', hash }, history)).toEqual({
      kind: 'malformed',
    });
    expect(history.urls).toEqual([SIGN_IN_CONTINUE_PATH]);
  });
});

describe('createAuthClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the token only in the continue body, same-origin, with an origin-only referrer', async () => {
    const calls: { url: string; body: string; init: RequestInit | undefined }[] = [];
    const fetchFn = vi.fn((input: string, init?: RequestInit) => {
      // The client always passes a string URL and a string body.
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push({ url: input, body, init });
      if (input === AUTH_CONTINUE_URL) {
        return Promise.resolve(
          new Response(JSON.stringify({ account_created: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (input === AUTH_LOGOUT_URL) return Promise.resolve(new Response(null, { status: 204 }));
      if (input === AUTH_ACCOUNT_URL) return Promise.resolve(problem(401, 'Not signed in'));
      return Promise.resolve(problem(400, 'Invalid request body'));
    }) as unknown as typeof fetch;
    const logs = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];

    const client = createAuthClient({ fetchFn });
    expect(await client.session()).toBe('signed-out');
    expect(await client.requestLink('reader@example.org')).toEqual({ kind: 'failed' });
    expect(await client.continueSignIn(TOKEN)).toEqual({ kind: 'signed-in', accountCreated: true });
    expect(await client.signOut()).toEqual({ kind: 'signed-out' });

    const withToken = calls.filter((call) => call.url.includes(TOKEN) || call.body.includes(TOKEN));
    expect(withToken).toHaveLength(1);
    expect(withToken[0]?.url).toBe(AUTH_CONTINUE_URL);
    expect(withToken[0]?.url).not.toContain(TOKEN);
    expect(JSON.parse(withToken[0]?.body ?? '')).toEqual({ token: TOKEN });

    expect(calls.map((call) => `${call.init?.method ?? ''} ${call.url}`)).toEqual([
      `GET ${AUTH_ACCOUNT_URL}`,
      `POST ${AUTH_LINK_URL}`,
      `POST ${AUTH_CONTINUE_URL}`,
      `POST ${AUTH_LOGOUT_URL}`,
    ]);
    for (const call of calls) {
      expect(call.init?.credentials).toBe('same-origin');
      // Not `no-referrer`: that serialises Origin as `null`, which the server refuses.
      expect(call.init?.referrerPolicy).toBe('strict-origin');
    }
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it('reads 404 and 405 as sign-in not served here, and never asks again', async () => {
    for (const status of [404, 405]) {
      const fetchFn = vi.fn(() =>
        Promise.resolve(new Response(null, { status })),
      ) as unknown as typeof fetch;
      const client = createAuthClient({ fetchFn });
      expect(await client.session()).toBe('unavailable');
      expect(await client.session()).toBe('unavailable');
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(
        AUTH_ACCOUNT_URL,
        expect.objectContaining({ method: 'GET' }),
      );
    }
  });

  it('asks afresh after a signed-in answer, a signed-out one or no answer', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response('{"signed_in":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(problem(401, 'Not signed in')) as unknown as typeof fetch;
    const client = createAuthClient({ fetchFn });
    expect(await client.session()).toBe('unknown');
    expect(await client.session()).toBe('unknown');
    expect(await client.session()).toBe('signed-in');
    expect(await client.session()).toBe('signed-out');
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('turns a thrown fetch into failed, never a throw', async () => {
    const fetchFn = vi.fn(() =>
      Promise.reject(new TypeError('offline')),
    ) as unknown as typeof fetch;
    const client = createAuthClient({ fetchFn });
    expect(await client.requestLink('a@example.org')).toEqual({ kind: 'failed' });
    expect(await client.continueSignIn(TOKEN)).toEqual({ kind: 'failed' });
    expect(await client.signOut()).toEqual({ kind: 'failed' });
  });
});

describe('requestLinkOutcomeOf', () => {
  it('answers sent for 202 whether or not the account exists', async () => {
    expect(
      await requestLinkOutcomeOf(new Response(JSON.stringify({ status: 'sent' }), { status: 202 })),
    ).toEqual({
      kind: 'sent',
    });
  });

  it('reads 429 with Retry-After', async () => {
    expect(
      await requestLinkOutcomeOf(problem(429, 'rate_limited', { 'retry-after': '120' })),
    ).toEqual({
      kind: 'rate-limited',
      retryAfterSeconds: 120,
    });
    expect(await requestLinkOutcomeOf(problem(429, 'rate_limited'))).toEqual({
      kind: 'rate-limited',
      retryAfterSeconds: null,
    });
  });

  it('tells an invalid address from other failures', async () => {
    expect(await requestLinkOutcomeOf(problem(400, 'invalid_email'))).toEqual({
      kind: 'invalid-email',
    });
    expect(await requestLinkOutcomeOf(problem(400, 'invalid_body'))).toEqual({
      kind: 'failed',
    });
    expect(await requestLinkOutcomeOf(problem(400))).toEqual({ kind: 'failed' });
    expect(await requestLinkOutcomeOf(problem(403, 'origin_refused'))).toEqual({ kind: 'failed' });
    expect(await requestLinkOutcomeOf(new Response(null, { status: 503 }))).toEqual({
      kind: 'failed',
    });
    expect(await requestLinkOutcomeOf(new Response(null, { status: 404 }))).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('sessionStateOf and availabilityOf', () => {
  it.each([
    [200, 'signed-in', 'available'],
    [401, 'signed-out', 'available'],
    [404, 'unavailable', 'unavailable'],
    [405, 'unavailable', 'unavailable'],
    [500, 'unknown', 'unavailable'],
    [403, 'unknown', 'unavailable'],
  ] as const)('reads %i as %s, so controls are %s', (status, state, shown) => {
    const headers = { 'content-type': 'application/json' };
    expect(sessionStateOf(new Response(null, { status, headers }))).toBe(state);
    expect(availabilityOf(state)).toBe(shown);
  });

  it('reads a static host answering index.html with a 200 as no sign-in here', () => {
    const html = new Response('<!doctype html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    expect(sessionStateOf(html)).toBe('unavailable');
  });
});

describe('continueOutcomeOf', () => {
  it.each([
    ['link_expired', 'expired'],
    ['link_used', 'used'],
    ['link_invalid', 'invalid'],
    ['link_superseded', 'superseded'],
    ['link_other_browser', 'other-browser'],
    // A code a newer server added, a code for another meaning, and none at all: invalid.
    ['link_from_the_future', 'invalid'],
    ['invalid_body', 'invalid'],
    [undefined, 'invalid'],
  ] as const)('maps the refusal code %s to %s', async (code, reason) => {
    expect(await continueOutcomeOf(problem(400, code))).toEqual({ kind: 'refused', reason });
  });

  it('ignores the title — only the code decides', async () => {
    const titled = new Response(
      JSON.stringify({ type: 'about:blank', title: 'Link already used', status: 400 }),
      { status: 400, headers: { 'content-type': 'application/problem+json' } },
    );
    expect(await continueOutcomeOf(titled)).toEqual({ kind: 'refused', reason: 'invalid' });
  });

  it('reads a signed-in answer, created or returning', async () => {
    const ok = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    expect(await continueOutcomeOf(ok({ account_created: true }))).toEqual({
      kind: 'signed-in',
      accountCreated: true,
    });
    expect(await continueOutcomeOf(ok({ account_created: false }))).toEqual({
      kind: 'signed-in',
      accountCreated: false,
    });
  });

  it('reads absence and server errors', async () => {
    expect(await continueOutcomeOf(new Response(null, { status: 404 }))).toEqual({
      kind: 'unavailable',
    });
    expect(await continueOutcomeOf(new Response(null, { status: 500 }))).toEqual({
      kind: 'failed',
    });
    expect(await continueOutcomeOf(problem(403, 'origin_refused'))).toEqual({ kind: 'failed' });
  });
});

describe('SIGN_IN_READING_BY_CODE', () => {
  // The type already makes the record total at compile time; this pins it at run time
  // too, against the list the server's own coverage test proves it emits.
  it('has a reading for every code the server emits, and for nothing else', () => {
    expect(Object.keys(SIGN_IN_READING_BY_CODE).sort()).toEqual([...PROBLEM_CODES].sort());
  });

  it('reads every sign-in link refusal as the matching page state', () => {
    expect(SIGN_IN_READING_BY_CODE).toMatchObject({
      link_invalid: 'invalid',
      link_expired: 'expired',
      link_used: 'used',
      link_superseded: 'superseded',
      link_other_browser: 'other-browser',
      invalid_email: 'invalid-email',
    });
  });
});
