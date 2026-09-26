import type { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type { DatabaseProbe, FreshnessReader } from '../../core/ports/freshness-reader.js';
import type { ReplayOutcome } from '../../core/stream/frame-ring.js';
import { KEEPALIVE_CHUNK, type ControlFrame, encodeFrame } from '../../core/stream/frames.js';
import { type StreamHub, createStreamHub } from '../../core/stream/stream-hub.js';
import { frame } from '../../core/stream/test-rows.js';
import { createHealthServer } from './health-server.js';
import type { ProblemLogEntry } from './problem.js';
import {
  CURSOR_PARAM,
  MAX_BUFFERED_BYTES,
  STREAM_PATH,
  type StreamRouteDeps,
} from './stream-route.js';

const NOW = '2026-07-14T10:15:00Z';

const FRESHNESS: ControlFrame = {
  event: 'freshness',
  data: { generated_at: NOW, max_seq: 1042, sources: [] },
};

type RoutePump = StreamRouteDeps['pump'];

interface FakePump extends RoutePump {
  readonly cursors: number[];
}

/** Classifies the cursor the way the ring would, for a ring covering `[floor, latest]`. */
function pump(
  options: {
    ready?: boolean;
    floor?: number;
    latest?: number;
    frames?: ReplayOutcome;
    freshness?: ControlFrame | null;
  } = {},
): FakePump {
  const cursors: number[] = [];
  return {
    cursors,
    ready: () => options.ready ?? true,
    replayAfter: (cursor) => {
      cursors.push(cursor);
      if (cursor < (options.floor ?? Number.NEGATIVE_INFINITY)) {
        return { kind: 'reset', reason: 'too_old' };
      }
      if (cursor > (options.latest ?? Number.POSITIVE_INFINITY)) {
        return { kind: 'reset', reason: 'unknown' };
      }
      return options.frames ?? { kind: 'replay', frames: [] };
    },
    freshness: () => (options.freshness === undefined ? FRESHNESS : options.freshness),
  };
}

const forbidden = {
  reader: {
    readObservations: () => Promise.reject(new Error('the probe reader must not be touched')),
  } satisfies FreshnessReader,
  probe: {
    ping: () => Promise.reject(new Error('the probe must not be touched')),
  } satisfies DatabaseProbe,
};

/** The whole server, so the probe hook's exemption is part of what is proven. */
function server(
  stream: Partial<StreamRouteDeps> & Pick<StreamRouteDeps, 'pump'>,
  options: { hub?: StreamHub; rateLimit?: { limit: number; windowMs: number } } = {},
): { app: ReturnType<typeof createHealthServer>; hub: StreamHub; problems: ProblemLogEntry[] } {
  const hub = options.hub ?? createStreamHub({ maxConnections: 8, maxPerClient: 8 });
  const problems: ProblemLogEntry[] = [];
  const app = createHealthServer({
    reader: forbidden.reader,
    probe: forbidden.probe,
    clock: new VirtualClock(NOW),
    expected: ['firms:viirs:noaa20'],
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    stream: { hub, onProblem: (entry) => problems.push(entry), ...stream },
  });
  return { app, hub, problems };
}

/**
 * Reads the open stream until the text ends with `until` (or the stream ends), or gives
 * up. Everything the route writes on connect is buffered before the headers go out, so
 * the preamble always arrives in the first few reads.
 */
async function readUntil(stream: Readable, until: string | null, limitMs = 1_000): Promise<string> {
  let text = '';
  const deadline = Date.now() + limitMs;
  for await (const chunk of stream) {
    text += (chunk as Buffer).toString('utf8');
    if ((until !== null && text.endsWith(until)) || Date.now() > deadline) break;
  }
  return text;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('GET /api/v1/stream', () => {
  it('answers with the SSE headers and the connect preamble: retry, replay, freshness', async () => {
    const { app, hub } = server({
      pump: pump({
        frames: { kind: 'replay', frames: [frame(1041), frame(1042, 'event.created')] },
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: STREAM_PATH,
      headers: { 'last-event-id': '1040' },
      payloadAsStream: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache, no-transform');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    // No probe-surface headers leak onto the stream.
    expect(response.headers['cdn-cache-control']).toBeUndefined();
    expect(response.headers.pragma).toBeUndefined();

    const text = await readUntil(response.stream(), encodeFrame(FRESHNESS));
    expect(text).toBe(
      'retry: 5000\n\n' +
        encodeFrame(frame(1041)) +
        encodeFrame(frame(1042, 'event.created')) +
        encodeFrame(FRESHNESS),
    );
    expect(hub.size).toBe(1);
    hub.drain(() => '');
    await app.close();
  });

  it('takes the cursor from the query on a first connection, and lets the header win', async () => {
    const fake = pump();
    const { app, hub } = server({ pump: fake });
    await app.inject({
      method: 'GET',
      url: `${STREAM_PATH}?${CURSOR_PARAM}=1040`,
      payloadAsStream: true,
    });
    await app.inject({
      method: 'GET',
      url: `${STREAM_PATH}?${CURSOR_PARAM}=1040`,
      headers: { 'last-event-id': '1041' },
      payloadAsStream: true,
    });
    await app.inject({ method: 'GET', url: STREAM_PATH, payloadAsStream: true });
    expect(fake.cursors).toEqual([1040, 1041, -1]);
    hub.drain(() => '');
    await app.close();
  });

  it('sends a reset frame, not a 400, for a cursor the ring cannot serve or cannot parse', async () => {
    const { app, hub } = server({ pump: pump({ floor: 1000, latest: 2000 }) });
    // Anything that is not a cursor is passed on as -1: below every floor, so `too_old`.
    for (const [cursor, reason] of [
      ['999', 'too_old'],
      ['2001', 'unknown'],
      ['abc', 'too_old'],
      ['-5', 'too_old'],
      ['12345678901234567', 'too_old'],
      ['', 'too_old'],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: STREAM_PATH,
        headers: { 'last-event-id': cursor },
        payloadAsStream: true,
      });
      expect(response.statusCode).toBe(200);
      const text = await readUntil(response.stream(), encodeFrame(FRESHNESS));
      expect(text).toBe(
        'retry: 5000\n\n' +
          encodeFrame({ event: 'reset', data: { reason } }) +
          encodeFrame(FRESHNESS),
      );
    }
    hub.drain(() => '');
    await app.close();
  });

  it('sends a keepalive in place of freshness when none has been built yet', async () => {
    const { app, hub } = server({ pump: pump({ freshness: null }), retryMs: 7_000 });
    const response = await app.inject({ method: 'GET', url: STREAM_PATH, payloadAsStream: true });
    const text = await readUntil(response.stream(), KEEPALIVE_CHUNK);
    expect(text).toBe(`retry: 7000\n\n${KEEPALIVE_CHUNK}`);
    hub.drain(() => '');
    await app.close();
  });

  it('is 503 with a short Retry-After before the pump has seeded, holding nothing', async () => {
    const { app, hub, problems } = server({ pump: pump({ ready: false }) });
    const response = await app.inject({ method: 'GET', url: STREAM_PATH });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.json()).toMatchObject({ status: 503, instance: STREAM_PATH });
    expect(hub.size).toBe(0);
    expect(problems).toHaveLength(1);
    await app.close();
  });

  it('is 503 + Retry-After: 60 at the global cap (A1.1), and 429 at the per-client cap (A1.3)', async () => {
    const hub = createStreamHub({ maxConnections: 2, maxPerClient: 1 });
    const { app } = server({ pump: pump(), clientIpHeader: 'cf-connecting-ip' }, { hub });
    const open = (ip: string) =>
      app.inject({
        method: 'GET',
        url: STREAM_PATH,
        headers: { 'cf-connecting-ip': ip },
        payloadAsStream: true,
      });

    expect((await open('10.0.0.1')).statusCode).toBe(200);
    const sameClient = await app.inject({
      method: 'GET',
      url: STREAM_PATH,
      headers: { 'cf-connecting-ip': '10.0.0.1' },
    });
    expect(sameClient.statusCode).toBe(429);
    expect(sameClient.headers['retry-after']).toBe('60');
    expect(sameClient.headers['content-type']).toMatch(/^application\/problem\+json/);

    expect((await open('10.0.0.2')).statusCode).toBe(200);
    const full = await app.inject({
      method: 'GET',
      url: STREAM_PATH,
      headers: { 'cf-connecting-ip': '10.0.0.3' },
    });
    expect(full.statusCode).toBe(503);
    expect(full.headers['retry-after']).toBe('60');
    expect(full.json()).toMatchObject({ status: 503, title: 'Stream at capacity' });
    expect(hub.size).toBe(2);
    hub.drain(() => '');
    await app.close();
  });

  it('is 503 + Retry-After: 60 while the stream is not offered (A1.1), holding nothing', async () => {
    let offered = false;
    const { app, hub, problems } = server({ pump: pump(), offered: () => offered });
    const demoted = await app.inject({ method: 'GET', url: STREAM_PATH });
    expect(demoted.statusCode).toBe(503);
    expect(demoted.headers['retry-after']).toBe('60');
    expect(demoted.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(demoted.headers['cache-control']).toMatch(/no-store/);
    expect(demoted.json()).toMatchObject({
      status: 503,
      title: 'Stream not offered',
      instance: STREAM_PATH,
    });
    expect(hub.size).toBe(0);
    expect(problems).toHaveLength(1);

    // The gate reads the answer on every connect: a re-offer needs no restart.
    offered = true;
    const reoffered = await app.inject({ method: 'GET', url: STREAM_PATH, payloadAsStream: true });
    expect(reoffered.statusCode).toBe(200);
    expect(hub.size).toBe(1);
    hub.drain(() => '');
    await app.close();
  });

  it('names every refusal to onRefused, and a throwing hook never changes the answer (C5)', async () => {
    const reasons: string[] = [];
    let offered = false;
    let ready = false;
    const hub = createStreamHub({ maxConnections: 2, maxPerClient: 1 });
    const { app } = server(
      {
        pump: { ...pump(), ready: () => ready },
        offered: () => offered,
        clientIpHeader: 'cf-connecting-ip',
        onRefused: (reason) => reasons.push(reason),
      },
      { hub },
    );
    const open = (ip: string, stream = false) =>
      app.inject({
        method: 'GET',
        url: STREAM_PATH,
        headers: { 'cf-connecting-ip': ip },
        payloadAsStream: stream,
      });

    expect((await open('10.0.0.1')).statusCode).toBe(503);
    offered = true;
    expect((await open('10.0.0.1')).statusCode).toBe(503);
    ready = true;
    expect((await open('10.0.0.1', true)).statusCode).toBe(200);
    expect((await open('10.0.0.1')).statusCode).toBe(429);
    expect((await open('10.0.0.2', true)).statusCode).toBe(200);
    expect((await open('10.0.0.3')).statusCode).toBe(503);
    expect(reasons).toEqual(['not_offered', 'not_ready', 'client_cap', 'capacity']);
    hub.drain(() => '');
    await app.close();

    const throwing = server({
      pump: pump(),
      offered: () => false,
      onRefused: () => {
        throw new Error('metrics bug');
      },
    });
    const refused = await throwing.app.inject({ method: 'GET', url: STREAM_PATH });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ title: 'Stream not offered' });
    await throwing.app.close();
  });

  it('refuses an unknown query parameter as the snapshot does', async () => {
    const { app, hub } = server({ pump: pump() });
    const response = await app.inject({ method: 'GET', url: `${STREAM_PATH}?after=1` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 400, title: 'Invalid query' });
    expect(hub.size).toBe(0);
    await app.close();
  });

  it('has no HEAD: a sink that never reads is not admitted', async () => {
    const { app, hub } = server({ pump: pump() });
    const response = await app.inject({ method: 'HEAD', url: STREAM_PATH });
    expect(response.statusCode).toBe(404);
    expect(hub.size).toBe(0);
    await app.close();
  });

  it('answers no per-IP limiter: the stream is not a probe', async () => {
    const { app, hub } = server({ pump: pump() }, { rateLimit: { limit: 1, windowMs: 60_000 } });
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(429);
    const response = await app.inject({ method: 'GET', url: STREAM_PATH, payloadAsStream: true });
    expect(response.statusCode).toBe(200);
    hub.drain(() => '');
    await app.close();
  });

  it('releases the connection when the client goes away', async () => {
    const { app, hub } = server({ pump: pump() });
    const controller = new AbortController();
    const response = await app.inject({
      method: 'GET',
      url: STREAM_PATH,
      payloadAsStream: true,
      signal: controller.signal,
    });
    expect(response.statusCode).toBe(200);
    expect(hub.size).toBe(1);
    controller.abort();
    await settle();
    expect(hub.size).toBe(0);
    // A broadcast after the release must not reach a destroyed stream.
    expect(() => {
      hub.broadcast(KEEPALIVE_CHUNK);
    }).not.toThrow();
    await app.close();
  });

  it('releases the connection over a real socket too', async () => {
    const { app, hub } = server({ pump: pump() });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const response = await fetch(`${address}${STREAM_PATH}`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    if (response.body === null) throw new Error('no body');
    // Node's fetch types the stream's chunks as `any`; narrow before decoding.
    const first: unknown = (await response.body.getReader().read()).value;
    if (!(first instanceof Uint8Array)) throw new Error('first chunk is not bytes');
    const text = new TextDecoder().decode(first);
    expect(text).toBe(`retry: 5000\n\n${encodeFrame(FRESHNESS)}`);
    expect(hub.size).toBe(1);
    controller.abort();
    for (let i = 0; i < 50 && hub.size > 0; i += 1) await settle();
    expect(hub.size).toBe(0);
    await app.close();
  });

  it('cuts a client that does not read once its unsent bytes pass the bound', async () => {
    const { app, hub } = server({ pump: pump() });
    const response = await app.inject({ method: 'GET', url: STREAM_PATH, payloadAsStream: true });
    expect(response.statusCode).toBe(200);
    const chunk = `: ${'x'.repeat(1_022)}\n\n`;
    const half = Math.floor(MAX_BUFFERED_BYTES / 2 / chunk.length);
    for (let sent = 0; sent < half; sent += 1) hub.broadcast(chunk);
    await settle();
    // Half the bound unread is a slow client, not a dead one.
    expect(hub.size).toBe(1);
    // The transport's own buffer takes some of it, so send the bound again to be sure.
    for (let sent = 0; sent < half * 2; sent += 1) hub.broadcast(chunk);
    await settle();
    expect(hub.size).toBe(0);
    await app.close();
  });

  it('drains: every open stream gets its last chunk and ends', async () => {
    const { app, hub } = server({ pump: pump({ freshness: null }) });
    const first = await app.inject({ method: 'GET', url: STREAM_PATH, payloadAsStream: true });
    const second = await app.inject({ method: 'GET', url: STREAM_PATH, payloadAsStream: true });
    hub.drain((index) => `retry: ${String(1_000 + index)}\n\n`);
    expect(hub.size).toBe(0);
    const [a, b] = await Promise.all([
      readUntil(first.stream(), null),
      readUntil(second.stream(), null),
    ]);
    expect(a).toBe(`retry: 5000\n\n${KEEPALIVE_CHUNK}retry: 1000\n\n`);
    expect(b).toBe(`retry: 5000\n\n${KEEPALIVE_CHUNK}retry: 1001\n\n`);
    await app.close();
  });
});
