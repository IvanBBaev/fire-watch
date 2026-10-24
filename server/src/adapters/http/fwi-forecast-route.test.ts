/**
 * The V2-B1 per-point FWI forecast route over the real core service, with a fake GWIS
 * client answering the recorded fixture.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { GFI_SOFIA as SOFIA_BODY } from '../../core/effis/__fixtures__/gwis-gfi.js';
import { createFwiForecastService } from '../../core/effis/fwi-point.js';
import { VirtualClock } from '../../core/ports/clock.js';
import type { FwiPointClient } from '../../core/ports/fwi-point-client.js';
import {
  FWI_FORECAST_CACHE_CONTROL,
  registerFwiForecastRoute,
  type FwiForecastResponse,
} from './fwi-forecast-route.js';

function app(options: { fail?: boolean; rateLimit?: { limit: number; windowMs: number } } = {}): {
  app: FastifyInstance;
  calls: () => number;
} {
  let calls = 0;
  const client: FwiPointClient = {
    fetchPoint() {
      calls += 1;
      return Promise.resolve(
        options.fail === true ? { body: null, error: 'down' } : { body: SOFIA_BODY, error: null },
      );
    },
  };
  const clock = new VirtualClock('2026-10-24T10:00:00Z');
  const server = Fastify();
  registerFwiForecastRoute(server, {
    service: createFwiForecastService({ client, clock }),
    clock,
    rateLimit: options.rateLimit,
  });
  return { app: server, calls: () => calls };
}

describe('GET /api/v1/fwi-forecast/:lat/:lon', () => {
  it('relays ten dated days with classes, the GWIS credit and cache headers', async () => {
    const { app: server } = app();
    const response = await server.inject({ method: 'GET', url: '/api/v1/fwi-forecast/42.7/23.3' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(FWI_FORECAST_CACHE_CONTROL);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['etag']).toMatch(/^"fwi1-[0-9a-f]{32}"$/);
    const body = response.json<FwiForecastResponse>();
    expect(body.source).toBe('gwis-ecmwf-fwi');
    expect(body.base_date).toBe('2026-10-24');
    expect(body.days).toHaveLength(10);
    expect(body.days[9]?.date).toBe('2026-11-02');
    expect(body.days[0]?.danger_class).toBe('very-low');
    expect(body.attribution[0]).toMatchObject({ id: 'gwis' });
    expect(body.attribution[0]?.text).toContain('2026');
  });

  it('answers a matching If-None-Match with 304 and asks GWIS only once', async () => {
    const { app: server, calls } = app();
    const first = await server.inject({ method: 'GET', url: '/api/v1/fwi-forecast/42.7/23.3' });
    const second = await server.inject({
      method: 'GET',
      url: '/api/v1/fwi-forecast/42.7/23.3',
      headers: { 'if-none-match': String(first.headers['etag']) },
    });
    expect(second.statusCode).toBe(304);
    expect(calls()).toBe(10);
  });

  it('refuses an unsnapped point, a point outside the box and a query string', async () => {
    const { app: server, calls } = app();
    const unsnapped = await server.inject({ url: '/api/v1/fwi-forecast/42.71/23.3' });
    expect(unsnapped.statusCode).toBe(400);
    const outside = await server.inject({ url: '/api/v1/fwi-forecast/48.5/2.3' });
    expect(outside.statusCode).toBe(404);
    const query = await server.inject({ url: '/api/v1/fwi-forecast/42.7/23.3?time=2030-01-01' });
    expect(query.statusCode).toBe(400);
    expect(calls()).toBe(0);
  });

  it('is a 503 when GWIS does not answer', async () => {
    const { app: server } = app({ fail: true });
    const response = await server.inject({ url: '/api/v1/fwi-forecast/42.7/23.3' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('300');
  });

  it('applies its own per-IP limit', async () => {
    const { app: server } = app({ rateLimit: { limit: 1, windowMs: 60_000 } });
    await server.inject({ url: '/api/v1/fwi-forecast/42.7/23.3' });
    const second = await server.inject({ url: '/api/v1/fwi-forecast/42.7/23.3' });
    expect(second.statusCode).toBe(429);
  });
});
