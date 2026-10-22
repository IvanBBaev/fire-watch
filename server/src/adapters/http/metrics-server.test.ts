import type { FreshnessRowId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type { MetricDescriptor } from '../../core/observability/prometheus-text.js';
import { PROMETHEUS_TEXT_CONTENT_TYPE } from '../../core/observability/prometheus-text.js';
import { createMetricsRegistry } from '../metrics/metrics-registry.js';
import { createHealthServer } from './health-server.js';
import type { MetaHealthVerdict } from '../../core/monitoring/meta-health.js';
import { createMetricsServer, META_HEALTH_PATH, METRICS_PATH } from './metrics-server.js';

const UP: MetricDescriptor = { name: 'fw_test_up', kind: 'gauge', help: 'Up.', labels: [] };
const TOKEN = 'a'.repeat(64);

function registry(): ReturnType<typeof createMetricsRegistry> {
  const r = createMetricsRegistry([UP]);
  r.setGauge(UP, {}, 1);
  return r;
}

describe('the internal metrics server', () => {
  it('serves the exposition with the Prometheus content type and no caching', async () => {
    const app = createMetricsServer({ registry: registry() });
    const response = await app.inject({ method: 'GET', url: METRICS_PATH });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(PROMETHEUS_TEXT_CONTENT_TYPE);
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.body).toBe('# HELP fw_test_up Up.\n# TYPE fw_test_up gauge\nfw_test_up 1\n');
  });

  it('refuses a scrape without exactly the configured bearer token', async () => {
    const app = createMetricsServer({ registry: registry(), bearerToken: TOKEN });
    for (const authorization of [
      undefined,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}`,
      TOKEN,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: METRICS_PATH,
        headers: authorization === undefined ? {} : { authorization },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.headers['cache-control']).toBe('no-store, max-age=0');
      expect(response.json()).toEqual({ status: 'unauthorized' });
      expect(response.body).not.toContain('fw_test_up');
    }
    const ok = await app.inject({
      method: 'GET',
      url: METRICS_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('fw_test_up 1');
  });

  it('answers anything else with a bare 404, behind the same token', async () => {
    const open = createMetricsServer({ registry: registry() });
    const missing = await open.inject({ method: 'GET', url: '/healthz' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ status: 'not_found' });

    const closed = createMetricsServer({ registry: registry(), bearerToken: TOKEN });
    expect((await closed.inject({ method: 'GET', url: '/anything' })).statusCode).toBe(401);
  });

  it('answers a failing render with a bare 500', async () => {
    const failing = { ...registry(), render: () => Promise.reject(new Error('secret detail')) };
    const response = await createMetricsServer({ registry: failing }).inject({
      method: 'GET',
      url: METRICS_PATH,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ status: 'error' });
    expect(response.body).not.toContain('secret detail');
  });
});

describe('the meta-alert route on the internal server', () => {
  const PAGING: MetaHealthVerdict = {
    statusCode: 500,
    body: {
      status: 'paging',
      generatedAt: '2026-10-22T10:00:01Z',
      lastRunAt: '2026-10-22T10:00:00Z',
      ageSeconds: 1,
      staleAfterSeconds: 180,
      paging: ['outbox_queue_oldest_seconds'],
      readings: null,
    },
  };

  it('is not registered unless the process hands in a verdict', async () => {
    const app = createMetricsServer({ registry: registry() });
    const response = await app.inject({ method: 'GET', url: META_HEALTH_PATH });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ status: 'not_found' });
  });

  it('answers the verdict, read per request, with its status code and no caching', async () => {
    let verdict: MetaHealthVerdict = PAGING;
    const app = createMetricsServer({ registry: registry(), metaHealth: () => verdict });
    const paging = await app.inject({ method: 'GET', url: META_HEALTH_PATH });
    expect(paging.statusCode).toBe(500);
    expect(paging.headers['cache-control']).toBe('no-store, max-age=0');
    expect(paging.json()).toEqual(PAGING.body);

    verdict = { statusCode: 200, body: { ...PAGING.body, status: 'ok', paging: [] } };
    const ok = await app.inject({ method: 'GET', url: META_HEALTH_PATH });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ok', paging: [] });
  });

  it('sits behind the same bearer token as the scrape', async () => {
    const app = createMetricsServer({
      registry: registry(),
      bearerToken: TOKEN,
      metaHealth: () => PAGING,
    });
    const refused = await app.inject({ method: 'GET', url: META_HEALTH_PATH });
    expect(refused.statusCode).toBe(401);
    expect(refused.body).not.toContain('outbox');
    const allowed = await app.inject({
      method: 'GET',
      url: META_HEALTH_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(allowed.statusCode).toBe(500);
    expect(allowed.json()).toMatchObject({ status: 'paging' });
  });

  it('answers a verdict that throws with a bare 500', async () => {
    const app = createMetricsServer({
      registry: registry(),
      metaHealth: () => {
        throw new Error('secret detail');
      },
    });
    const response = await app.inject({ method: 'GET', url: META_HEALTH_PATH });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ status: 'error' });
  });
});

describe('the public API server', () => {
  const expected: readonly FreshnessRowId[] = ['firms:viirs:snpp'];
  const app = createHealthServer({
    reader: { readObservations: () => Promise.resolve([]) },
    probe: { ping: () => Promise.resolve() },
    clock: new VirtualClock('2026-09-25T00:00:00Z'),
    expected,
  });

  it.each([
    METRICS_PATH,
    `${METRICS_PATH}/`,
    '/api/metrics',
    '/api/health/metrics',
    '/api/health/meta',
  ])('never serves %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('# TYPE');
    expect(response.body).not.toContain('fw_');
  });

  it('registers no metrics route at all', async () => {
    await app.ready();
    expect(app.printRoutes()).not.toMatch(/metrics|health\/meta/);
  });
});
