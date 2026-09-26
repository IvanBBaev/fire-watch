import { describe, expect, it } from 'vitest';

import { createHealthchecksBackupPinger } from './healthchecks-backup-pinger.js';

const BASE = 'https://hc-ping.example/secret-ping-key';

function recorder(respond: () => Promise<Response>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    return respond();
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('createHealthchecksBackupPinger', () => {
  it('pings the nightly-backup check on success and /fail on failure, empty body', async () => {
    const r = recorder(() => Promise.resolve(new Response('OK')));
    const pinger = createHealthchecksBackupPinger({ pingBaseUrl: `${BASE}/`, fetch: r.fetch });
    await pinger.succeeded();
    await pinger.failed();
    expect(r.calls).toEqual([
      { url: `${BASE}/nightly-backup`, method: 'POST', body: '' },
      { url: `${BASE}/nightly-backup/fail`, method: 'POST', body: '' },
    ]);
  });

  it('never throws, and redacts the secret URL from errors', async () => {
    const errors: string[] = [];
    const r = recorder(() => Promise.reject(new Error(`fetch failed for ${BASE}/nightly-backup`)));
    const pinger = createHealthchecksBackupPinger({
      pingBaseUrl: BASE,
      fetch: r.fetch,
      onError: (reason) => errors.push(reason),
    });
    await expect(pinger.failed()).resolves.toBeUndefined();
    expect(errors).toEqual(['fetch failed for <HEARTBEAT_URL>/nightly-backup']);
    expect(errors.join()).not.toContain('secret-ping-key');
  });

  it('reports a rejected ping by status only', async () => {
    const errors: string[] = [];
    const r = recorder(() => Promise.resolve(new Response('nope', { status: 404 })));
    const pinger = createHealthchecksBackupPinger({
      pingBaseUrl: BASE,
      fetch: r.fetch,
      onError: (reason) => errors.push(reason),
    });
    await pinger.succeeded();
    expect(errors).toEqual(['backup ping rejected with HTTP 404']);
  });

  it('refuses a ping URL that is not https or carries no key, without quoting it', () => {
    expect(() => createHealthchecksBackupPinger({ pingBaseUrl: 'http://hc/x' })).toThrow(/https/);
    expect(() =>
      createHealthchecksBackupPinger({ pingBaseUrl: 'https://hc-ping.example/' }),
    ).toThrow(/ping key/);
  });
});
