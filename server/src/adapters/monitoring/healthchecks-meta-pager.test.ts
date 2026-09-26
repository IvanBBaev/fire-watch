import { describe, expect, it } from 'vitest';

import { createHealthchecksMetaPager, META_ALERT_CHECK_SLUG } from './healthchecks-meta-pager.js';

/** A stand-in for the real ping URL — a secret in production. */
const PING_BASE = 'https://hc-ping.example/0000-not-a-real-key';

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

function recorder(respond: () => Promise<Response>): {
  calls: Call[];
  fetch: typeof globalThis.fetch;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: init?.method, body: init?.body });
      return respond();
    },
  };
}

const ok = (): Promise<Response> => Promise.resolve(new Response('OK', { status: 200 }));

describe('createHealthchecksMetaPager', () => {
  it('pings the meta-alerts check as a success while nothing pages', async () => {
    const fake = recorder(ok);
    await createHealthchecksMetaPager({ pingBaseUrl: PING_BASE, fetch: fake.fetch }).report([]);
    expect(META_ALERT_CHECK_SLUG).toBe('meta-alerts');
    expect(fake.calls).toEqual([{ url: `${PING_BASE}/meta-alerts`, method: 'POST', body: '' }]);
  });

  it('signals an explicit failure naming only the paging keys', async () => {
    const fake = recorder(ok);
    await createHealthchecksMetaPager({ pingBaseUrl: `${PING_BASE}/`, fetch: fake.fetch }).report([
      'outbox_queue_oldest_seconds',
    ]);
    expect(fake.calls).toEqual([
      {
        url: `${PING_BASE}/meta-alerts/fail`,
        method: 'POST',
        body: 'outbox_queue_oldest_seconds',
      },
    ]);
  });

  it('never throws, and redacts the secret from what it reports', async () => {
    const reasons: string[] = [];
    const pager = createHealthchecksMetaPager({
      pingBaseUrl: PING_BASE,
      fetch: (input) =>
        Promise.reject(
          new Error(`fetch failed for ${input instanceof Request ? input.url : input.toString()}`),
        ),
      onError: (reason) => reasons.push(reason),
    });
    await expect(pager.report([])).resolves.toBeUndefined();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).not.toContain(PING_BASE);
    expect(reasons[0]).toContain('<HEARTBEAT_URL>');
  });

  it('reports a rejected ping by status', async () => {
    const reasons: string[] = [];
    const pager = createHealthchecksMetaPager({
      pingBaseUrl: PING_BASE,
      fetch: () => Promise.resolve(new Response('not found', { status: 404 })),
      onError: (reason) => reasons.push(reason),
    });
    await pager.report([]);
    expect(reasons).toEqual(['meta-alert ping rejected with HTTP 404']);
  });

  it('refuses a ping URL that would leak or misroute the secret', () => {
    expect(() => createHealthchecksMetaPager({ pingBaseUrl: 'http://hc-ping.example/k' })).toThrow(
      /https/,
    );
  });
});
