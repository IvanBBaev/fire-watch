import { describe, expect, it } from 'vitest';

import {
  judgeFreshness,
  judgeMeta,
  runSmoke,
  smokeProbes,
  type SmokeProbe,
  type SmokeResponse,
} from './deploy-smoke.js';

const VERDICT = { generatedAt: '2026-11-08T00:00:00Z', status: 'ok', budgetVersion: '1', rows: [] };

describe('judgeFreshness', () => {
  it('passes any verdict body, including a blind 500: an upstream outage is not this release', () => {
    expect(judgeFreshness({ status: 200, body: VERDICT })).toBeNull();
    expect(judgeFreshness({ status: 500, body: { ...VERDICT, status: 'critical' } })).toBeNull();
  });

  it('fails when the API could not produce a verdict', () => {
    expect(judgeFreshness({ status: 503, body: { status: 'unavailable' } })).toBe(
      'HTTP 503 status=unavailable',
    );
    expect(
      judgeFreshness({
        status: 500,
        body: { status: 'critical', reason: 'freshness_query_failed' },
      }),
    ).toBe('HTTP 500 status=critical reason=freshness_query_failed');
    expect(judgeFreshness({ status: 502, body: undefined })).toBe('HTTP 502 status=undefined');
  });
});

describe('judgeMeta', () => {
  it.each(['ok', 'starting'])('passes %s', (status) => {
    expect(judgeMeta({ status: 200, body: { status } })).toBeNull();
  });

  it.each(['paging', 'failed', 'stale'])('fails %s', (status) => {
    expect(judgeMeta({ status: 500, body: { status } })).toBe(`HTTP 500 status=${status}`);
  });
});

describe('smokeProbes', () => {
  it('probes the API and, when configured, the worker meta endpoint with the bearer token', () => {
    const probes = smokeProbes({
      apiUrl: 'http://api:8080/',
      metaUrl: 'http://127.0.0.1:9464',
      metaToken: 't'.repeat(32),
    });
    expect(probes.map((probe) => [probe.name, probe.url])).toEqual([
      ['api_liveness', 'http://api:8080/healthz'],
      ['api_readiness', 'http://api:8080/readyz'],
      ['api_freshness', 'http://api:8080/api/health/freshness'], // gitleaks:allow (URL, not a key)
      ['worker_meta', 'http://127.0.0.1:9464/api/health/meta'],
    ]);
    expect(probes[3]?.headers).toEqual({ authorization: `Bearer ${'t'.repeat(32)}` });
  });

  it('leaves the meta probe out when the worker has no metrics listener', () => {
    const probes = smokeProbes({ apiUrl: 'http://api:8080', metaUrl: null, metaToken: null });
    expect(probes.map((probe) => probe.name)).not.toContain('worker_meta');
  });

  it('expects liveness and readiness to say ok', () => {
    const [liveness] = smokeProbes({ apiUrl: 'http://api:8080', metaUrl: null, metaToken: null });
    expect(liveness?.judge({ status: 200, body: { status: 'ok' } })).toBeNull();
    expect(liveness?.judge({ status: 503, body: { status: 'unavailable' } })).toBe(
      'HTTP 503 status=unavailable',
    );
  });
});

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

const ok: SmokeProbe = {
  name: 'p',
  url: 'http://api:8080/healthz',
  judge: (response) => (response.status === 200 ? null : `HTTP ${String(response.status)}`),
};

describe('runSmoke', () => {
  it('retries while the containers start and passes on the first clean round', async () => {
    const answers: (SmokeResponse | Error)[] = [
      new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
      { status: 503, body: undefined },
      { status: 200, body: undefined },
    ];
    const result = await runSmoke(
      [ok],
      {
        ...clock(),
        fetch: () => {
          const next = answers.shift();
          return next instanceof Error ? Promise.reject(next) : Promise.resolve(next!);
        },
      },
      { deadlineMs: 60_000, intervalMs: 3_000 },
    );
    expect(result).toEqual({ passed: true, rounds: 3, failures: {} });
  });

  it('fails at the deadline with the last round, naming the error code and not the URL', async () => {
    const result = await runSmoke(
      [ok],
      {
        ...clock(),
        fetch: () =>
          Promise.reject(
            new TypeError('fetch failed http://api:8080', { cause: { code: 'ENOTFOUND' } }),
          ),
      },
      { deadlineMs: 10_000, intervalMs: 3_000 },
    );
    expect(result.passed).toBe(false);
    expect(result.rounds).toBe(4);
    expect(result.failures).toEqual({ p: 'unreachable: ENOTFOUND' });
  });
});
