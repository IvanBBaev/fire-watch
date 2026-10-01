import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import { OMM_SNPP } from '../../core/passes/__fixtures__/celestrak-omm.js';
import {
  CELESTRAK_BASE_URL,
  CELESTRAK_MAX_BODY_BYTES,
  celestrakGpUrl,
  createCelestrakHttpClient,
} from './celestrak-http-client.js';

const NOW = Date.UTC(2026, 8, 30, 13, 16);

function clientAnswering(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createCelestrakHttpClient({
    clock: new VirtualClock(NOW),
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url, init ?? {}));
    },
  });
  return { client, calls };
}

describe('createCelestrakHttpClient', () => {
  it('asks for one catalogue number as JSON and returns the body with its arrival time', async () => {
    const { client, calls } = clientAnswering(() => new Response(OMM_SNPP, { status: 200 }));
    const fetched = await client.fetchElements(37849);
    expect(fetched).toEqual({ body: OMM_SNPP, status: 200, availableAt: NOW, error: null });
    expect(calls[0]?.url).toBe(`${CELESTRAK_BASE_URL}?CATNR=37849&FORMAT=JSON`);
    expect(calls[0]?.init.redirect).toBe('manual');
  });

  it('hands a redirect back as the non-200 it is, never following it', async () => {
    const { client, calls } = clientAnswering(
      () => new Response(null, { status: 301, headers: { location: 'https://elsewhere.test/' } }),
    );
    const fetched = await client.fetchElements(43013);
    expect(fetched.status).toBe(301);
    expect(fetched.body).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it.each([403, 404, 500])('reports HTTP %i with a short excerpt', async (code) => {
    const { client } = clientAnswering(() => new Response('x'.repeat(500), { status: code }));
    const fetched = await client.fetchElements(43013);
    expect(fetched.status).toBe(code);
    expect(fetched.error).toMatch(new RegExp(`returned ${String(code)} for NORAD 43013`));
    expect(fetched.error!.length).toBeLessThan(300);
  });

  it('turns a transport failure into status null', async () => {
    const client = createCelestrakHttpClient({
      clock: new VirtualClock(NOW),
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const fetched = await client.fetchElements(43013);
    expect(fetched).toMatchObject({ body: null, status: null, availableAt: null });
    expect(fetched.error).toMatch(/fetch failed/);
  });

  it('refuses an oversized body without latching', async () => {
    const { client } = clientAnswering(
      () => new Response('a'.repeat(CELESTRAK_MAX_BODY_BYTES + 1), { status: 200 }),
    );
    const fetched = await client.fetchElements(43013);
    expect(fetched.status).toBeNull();
    expect(fetched.error).toMatch(/over the cap/);
  });

  it('refuses a nonsense catalogue number before any request', async () => {
    const { client, calls } = clientAnswering(() => new Response('', { status: 200 }));
    expect((await client.fetchElements(-1)).status).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('builds the query against a configured base', () => {
    expect(celestrakGpUrl('https://mirror.test/gp.php', 5)).toBe(
      'https://mirror.test/gp.php?CATNR=5&FORMAT=JSON',
    );
  });
});
