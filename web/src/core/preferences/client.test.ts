import { ACCOUNT_PREFERENCES_SCHEMA } from '@fire-watch/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ACCOUNT_PREFERENCES_URL, createPreferencesClient, remoteFromBody } from './client.js';

const STATE = {
  revision: 4,
  document: { schema: ACCOUNT_PREFERENCES_SCHEMA, preferences: { theme: 'dark' } },
  updated_at: '2026-10-27T10:00:00.000Z',
};

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('remoteFromBody', () => {
  it('keeps the revision and the preferences of a valid state', () => {
    expect(remoteFromBody(STATE)).toEqual({ revision: 4, preferences: { theme: 'dark' } });
  });

  it('refuses a body that is not a state', () => {
    expect(remoteFromBody(null)).toBeNull();
    expect(remoteFromBody({ ...STATE, revision: -1 })).toBeNull();
    expect(remoteFromBody({ ...STATE, revision: '4' })).toBeNull();
    expect(remoteFromBody({ ...STATE, document: { schema: 'other', preferences: {} } })).toBeNull();
  });
});

describe('createPreferencesClient', () => {
  it('reads with the cookie, no cache and a strict referrer', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(respond(200, STATE)));
    const outcome = await createPreferencesClient({ fetchFn }).read();
    expect(outcome).toEqual({
      kind: 'read',
      remote: { revision: 4, preferences: { theme: 'dark' } },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      ACCOUNT_PREFERENCES_URL,
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        referrerPolicy: 'strict-origin',
      }),
    );
  });

  it('writes the document with If-Match on the revision it was based on', async () => {
    const fetchFn = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(respond(200, { ...STATE, revision: 5 })),
    );
    const outcome = await createPreferencesClient({ fetchFn }).write({ theme: 'dark' }, 4);
    expect(outcome.kind).toBe('written');
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.method).toBe('PUT');
    expect((init?.headers as Record<string, string>)['if-match']).toBe('"4"');
    expect(JSON.parse(init?.body as string)).toEqual({
      schema: ACCOUNT_PREFERENCES_SCHEMA,
      preferences: { theme: 'dark' },
    });
  });

  it.each([
    [409, 'conflict'],
    [428, 'conflict'],
    [401, 'signed-out'],
    [404, 'unavailable'],
    [405, 'unavailable'],
    [422, 'failed'],
    [413, 'failed'],
    [500, 'failed'],
  ])('a write answered %i is %s', async (status, kind) => {
    const fetchFn = () => Promise.resolve(respond(status, { type: 'x' }));
    expect((await createPreferencesClient({ fetchFn }).write({}, 0)).kind).toBe(kind);
  });

  it.each([
    [401, 'signed-out'],
    [404, 'unavailable'],
    [503, 'failed'],
  ])('a read answered %i is %s', async (status, kind) => {
    const fetchFn = () => Promise.resolve(respond(status, {}));
    expect((await createPreferencesClient({ fetchFn }).read()).kind).toBe(kind);
  });

  it('never throws: a network failure or a broken body is failed', async () => {
    const offline = () => Promise.reject(new TypeError('offline'));
    expect((await createPreferencesClient({ fetchFn: offline }).read()).kind).toBe('failed');
    expect((await createPreferencesClient({ fetchFn: offline }).write({}, 0)).kind).toBe('failed');
    const garbled = () => Promise.resolve(new Response('not json', { status: 200 }));
    expect((await createPreferencesClient({ fetchFn: garbled }).read()).kind).toBe('failed');
  });
});
