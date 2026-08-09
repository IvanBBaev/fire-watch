import { describe, expect, it } from 'vitest';

import { assertPingBaseUrl, createHealthchecksHeartbeat } from './healthchecks-heartbeat.js';

/**
 * A stand-in for the real ping URL. It is a secret in production, so several tests below
 * assert that this exact string never reaches an error message.
 */
const PING_BASE = 'https://hc-ping.example/0000-not-a-real-key';

interface Call {
  readonly url: string;
  readonly method: string | undefined;
}

interface Recorder {
  readonly calls: Call[];
  readonly fetch: typeof globalThis.fetch;
}

/** The three shapes `fetch` accepts, reduced to the one the assertions care about. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function recorder(respond: () => Promise<Response>): Recorder {
  const calls: Call[] = [];
  return {
    calls,
    // Parameters are typed by `Recorder.fetch`, so this stays honest to the real signature.
    fetch: (input, init) => {
      calls.push({ url: urlOf(input), method: init?.method });
      return respond();
    },
  };
}

function ok(): Promise<Response> {
  return Promise.resolve(new Response('OK', { status: 200 }));
}

describe('createHealthchecksHeartbeat', () => {
  it('pings the check named after the job', async () => {
    // The slug *is* the job id: adding a job means creating a check called after it,
    // not adding a second secret to a VM nobody wants to redeploy at 03:00.
    const fake = recorder(ok);
    const heartbeat = createHealthchecksHeartbeat({ pingBaseUrl: PING_BASE, fetch: fake.fetch });

    await heartbeat.succeeded('ingest-cycle');

    expect(fake.calls).toEqual([{ url: `${PING_BASE}/ingest-cycle`, method: 'POST' }]);
  });

  it('tolerates a base URL that arrived with a trailing slash', async () => {
    const fake = recorder(ok);
    const heartbeat = createHealthchecksHeartbeat({
      pingBaseUrl: `${PING_BASE}/`,
      fetch: fake.fetch,
    });

    await heartbeat.succeeded('nightly-backup');

    expect(fake.calls[0]?.url).toBe(`${PING_BASE}/nightly-backup`);
  });

  it('never throws when the ping does not land', async () => {
    // A monitor that can fail the process it monitors is worse than no monitor: a DNS
    // blip against hc-ping.io must not turn a finished ingest cycle into a failed one.
    const heartbeat = createHealthchecksHeartbeat({
      pingBaseUrl: PING_BASE,
      fetch: () => Promise.reject(new Error('getaddrinfo EAI_AGAIN hc-ping.example')),
    });

    await expect(heartbeat.succeeded('ingest-cycle')).resolves.toBeUndefined();
  });

  it('reports a rejected ping without retrying it', async () => {
    // A ping that does not arrive is already the page. Retrying here only delays a job
    // whose real work is finished.
    const reasons: string[] = [];
    const fake = recorder(() => Promise.resolve(new Response('nope', { status: 404 })));
    const heartbeat = createHealthchecksHeartbeat({
      pingBaseUrl: PING_BASE,
      fetch: fake.fetch,
      onError: (_job, reason) => reasons.push(reason),
    });

    await heartbeat.succeeded('snapshot-push');

    expect(fake.calls).toHaveLength(1);
    expect(reasons).toEqual(['heartbeat rejected with HTTP 404']);
  });

  it('strips the ping URL out of an error that quotes it', async () => {
    // `fetch` puts the URL it failed on into the message, and this one is a credential:
    // anyone holding it can keep our dead-man's switch quiet forever.
    const reasons: string[] = [];
    const heartbeat = createHealthchecksHeartbeat({
      pingBaseUrl: PING_BASE,
      fetch: () => Promise.reject(new Error(`request to ${PING_BASE}/ingest-cycle failed`)),
      onError: (_job, reason) => reasons.push(reason),
    });

    await heartbeat.succeeded('ingest-cycle');

    expect(reasons[0]).toBe('request to <HEARTBEAT_URL>/ingest-cycle failed');
    expect(reasons.join(' ')).not.toContain(PING_BASE);
  });

  it('says a timeout is a timeout', async () => {
    const reasons: string[] = [];
    const timeout = new Error('This operation was aborted');
    timeout.name = 'TimeoutError';
    const heartbeat = createHealthchecksHeartbeat({
      pingBaseUrl: PING_BASE,
      fetch: () => Promise.reject(timeout),
      onError: (_job, reason) => reasons.push(reason),
    });

    await heartbeat.succeeded('wal-archive');

    // `AbortError` would send whoever reads the log looking for a cancelled request.
    expect(reasons).toEqual(['heartbeat timed out']);
  });

  it('survives a failure with no reporter attached', async () => {
    const heartbeat = createHealthchecksHeartbeat({
      pingBaseUrl: PING_BASE,
      fetch: () => Promise.reject(new Error('boom')),
    });

    await expect(heartbeat.succeeded('deploy-smoke')).resolves.toBeUndefined();
  });

  it('bounds every ping with a timeout signal', async () => {
    // The heartbeat runs after the work is done, so a wedged hc-ping.io connection with
    // no deadline would hold every cycle hostage for as long as the socket dangles.
    let init: RequestInit | undefined;
    const heartbeat = createHealthchecksHeartbeat({
      pingBaseUrl: PING_BASE,
      fetch: (_input, requestInit) => {
        init = requestInit;
        return ok();
      },
    });

    await heartbeat.succeeded('ingest-cycle');

    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('assertPingBaseUrl', () => {
  it('refuses a value that is not a URL, without quoting it back', () => {
    // The whole value is the secret, so the diagnostic may describe the shape and nothing
    // else — an env var echoed into a startup log is an env var in the log forever.
    const secret = 'obviously-not-a-url';
    expect(() => assertPingBaseUrl(secret)).toThrow(/must be an absolute URL/);
    try {
      assertPingBaseUrl(secret);
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('refuses plain http, which would put the secret on the wire in clear text', () => {
    expect(() => assertPingBaseUrl('http://hc-ping.example/key')).toThrow(/https/);
  });

  it('accepts an https base and normalises its trailing slashes', () => {
    expect(assertPingBaseUrl(`${PING_BASE}///`)).toBe(PING_BASE);
  });

  it('refuses a bare origin — an operator who forgot the ping key, without quoting it', () => {
    // `https://hc-ping.com` with no key would boot cleanly and then ping a check nobody
    // created, 404ing forever — a dead-man's switch that was never armed.
    const bareOrigin = 'https://hc-ping.example';
    expect(() => assertPingBaseUrl(bareOrigin)).toThrow(/ping key/);
    // Trailing slashes must not be able to impersonate a path.
    expect(() => assertPingBaseUrl(`${bareOrigin}///`)).toThrow(/ping key/);
    try {
      assertPingBaseUrl(bareOrigin);
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain(bareOrigin);
    }
  });

  it('refuses a query string or fragment, which would corrupt the slug URL', () => {
    // The slug is appended to the base, so `…?next=1` would produce `…?next=1/ingest-cycle`.
    expect(() => assertPingBaseUrl(`${PING_BASE}?next=1`)).toThrow(/query string or fragment/);
    expect(() => assertPingBaseUrl(`${PING_BASE}#prod`)).toThrow(/query string or fragment/);
  });
});
