import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type { EffisLayerRequest } from '../../core/ports/effis-client.js';
import { createEffisHttpClient } from './effis-http-client.js';

const REQUEST: EffisLayerRequest = {
  layer: 'ecmwf007.fwi',
  query: { SERVICE: 'WMS', REQUEST: 'GetMap', LAYERS: 'ecmwf007.fwi', BBOX: '39,20,46,31' },
};

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function fetchAnswering(response: () => Response): { calls: Captured[]; fetch: typeof fetch } {
  const calls: Captured[] = [];
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(response());
  };
  return { calls, fetch: fake };
}

describe('createEffisHttpClient', () => {
  it('builds the query URL against the base and refuses redirects', async () => {
    const { calls, fetch } = fetchAnswering(
      () => new Response(new Uint8Array(2048), { headers: { 'content-type': 'image/png' } }),
    );
    const client = createEffisHttpClient({
      clock: new VirtualClock('2026-08-13T10:15:00Z'),
      baseUrl: 'https://proxy.internal/effis/', // trailing slash must not double up
      fetch,
    });

    await client.fetchLayer(REQUEST);

    expect(calls[0]?.url).toBe(
      'https://proxy.internal/effis?SERVICE=WMS&REQUEST=GetMap&LAYERS=ecmwf007.fwi&BBOX=39%2C20%2C46%2C31',
    );
    expect(calls[0]?.init?.redirect).toBe('error');
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('hands the body over verbatim with Content-Type and an availableAt stamp', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const clock = new VirtualClock('2026-08-13T10:15:00Z');
    const { fetch } = fetchAnswering(
      () => new Response(body, { headers: { 'content-type': 'image/png' } }),
    );
    const client = createEffisHttpClient({ clock, fetch });

    const fetched = await client.fetchLayer(REQUEST);

    expect(fetched.error).toBeNull();
    expect(fetched.status).toBe(200);
    expect(fetched.bytes).toEqual(body);
    expect(fetched.contentType).toBe('image/png');
    expect(fetched.availableAt).toBe(clock.now());
  });

  it('does not judge a 200 ServiceException — that is the sanity gate’s job', async () => {
    // The adapter must pass poison through untouched, or the A2.2 acceptance fixtures
    // would be testing a body this adapter never lets the core see.
    const xml = '<?xml version="1.0"?><ServiceExceptionReport/>';
    const { fetch } = fetchAnswering(
      () => new Response(xml, { headers: { 'content-type': 'text/xml;charset=UTF-8' } }),
    );
    const client = createEffisHttpClient({ clock: new VirtualClock(0), fetch });

    const fetched = await client.fetchLayer(REQUEST);

    expect(fetched.error).toBeNull();
    expect(fetched.status).toBe(200);
    expect(fetched.contentType).toBe('text/xml;charset=UTF-8');
    expect(new TextDecoder().decode(fetched.bytes ?? new Uint8Array())).toBe(xml);
  });

  it('turns a non-2xx into a failure value carrying status and a body excerpt', async () => {
    const { fetch } = fetchAnswering(
      () => new Response('  Service   Unavailable\n\n try later ', { status: 503 }),
    );
    const client = createEffisHttpClient({ clock: new VirtualClock(0), fetch });

    const fetched = await client.fetchLayer(REQUEST);

    expect(fetched.bytes).toBeNull();
    expect(fetched.status).toBe(503);
    expect(fetched.availableAt).toBeNull();
    expect(fetched.error).toBe(
      'EFFIS returned 503 for ecmwf007.fwi: Service Unavailable try later',
    );
  });

  it('turns a network throw into a failure value naming the cause', async () => {
    const failing = () =>
      Promise.reject(new Error('fetch failed', { cause: new Error('ECONNREFUSED') }));
    const client = createEffisHttpClient({
      clock: new VirtualClock(0),
      fetch: failing,
    });

    const fetched = await client.fetchLayer(REQUEST);

    expect(fetched.bytes).toBeNull();
    expect(fetched.status).toBeNull();
    expect(fetched.error).toBe(
      'EFFIS request failed for ecmwf007.fwi: fetch failed (ECONNREFUSED)',
    );
  });
});
