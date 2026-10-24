import { describe, expect, it } from 'vitest';

import {
  CEMS_DETAIL_RESTRICTED_BODY,
  CEMS_LIST_PAGE_0,
} from '../../core/cems/__fixtures__/cems-api.js';
import { VirtualClock } from '../../core/ports/clock.js';
import { CEMS_BASE_URL, CEMS_MAX_BODY_BYTES, createCemsHttpClient } from './cems-http-client.js';

const NOW = Date.UTC(2026, 9, 24, 9, 0);

function clientAnswering(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createCemsHttpClient({
    clock: new VirtualClock(NOW),
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url));
    },
  });
  return { client, calls };
}

describe('createCemsHttpClient', () => {
  it('asks for one page of wildfire activations and returns the body with its arrival time', async () => {
    const { client, calls } = clientAnswering(
      () => new Response(CEMS_LIST_PAGE_0, { status: 200 }),
    );
    const fetched = await client.listActivations({ offset: 50, limit: 50 });
    expect(fetched).toEqual({ body: CEMS_LIST_PAGE_0, status: 200, availableAt: NOW, error: null });
    expect(calls[0]?.url).toBe(
      `${CEMS_BASE_URL}/public-activations-info/?category=Wildfire&limit=50&offset=50`,
    );
    expect(calls[0]?.init.redirect).toBe('manual');
  });

  it('asks for one activation detail by code', async () => {
    const { client, calls } = clientAnswering(() => new Response('{}', { status: 200 }));
    await client.activationDetail('EMSR822');
    expect(calls[0]?.url).toBe(`${CEMS_BASE_URL}/public-activations/?code=EMSR822`);
  });

  it('hands a restricted detail back as the 403 it is', async () => {
    const { client } = clientAnswering(
      () => new Response(CEMS_DETAIL_RESTRICTED_BODY, { status: 403 }),
    );
    const fetched = await client.activationDetail('EMSR700');
    expect(fetched.status).toBe(403);
    expect(fetched.body).toBeNull();
    expect(fetched.error).toContain('Authentication credentials were not provided');
  });

  it('never follows a redirect', async () => {
    const { client, calls } = clientAnswering(
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
    );
    expect((await client.listActivations({ offset: 0, limit: 50 })).status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it('turns a transport failure into status null', async () => {
    const client = createCemsHttpClient({
      clock: new VirtualClock(NOW),
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const fetched = await client.listActivations({ offset: 0, limit: 50 });
    expect(fetched.status).toBeNull();
    expect(fetched.error).toMatch(/fetch failed/);
  });

  it('refuses a body over the cap', async () => {
    const { client } = clientAnswering(
      () => new Response(new Uint8Array(CEMS_MAX_BODY_BYTES + 1), { status: 200 }),
    );
    const fetched = await client.listActivations({ offset: 0, limit: 50 });
    expect(fetched.body).toBeNull();
    expect(fetched.error).toMatch(/over the cap/);
  });

  it('makes no request for a malformed code or page', async () => {
    const { client, calls } = clientAnswering(() => new Response('{}', { status: 200 }));
    expect((await client.activationDetail('../admin')).status).toBeNull();
    expect((await client.listActivations({ offset: -1, limit: 50 })).status).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
