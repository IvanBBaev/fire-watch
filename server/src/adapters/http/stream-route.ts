/**
 * `GET /api/v1/stream` — T0, the SSE tier (ADR-003 D1 T0 row, D3, A1.1, A1.3).
 *
 * The route is the thin edge of the stream: admission, the connect preamble, and the
 * one guard a transport has to have. Everything with a decision in it lives in core —
 * the caps ({@link StreamHub}), the ring and the replay/reset arithmetic
 * ({@link StreamPump}), the frame grammar (`frames.ts`).
 *
 * On connect, in this order and synchronously with the request:
 *
 *   1. **Admission.** Not offered — the fleet is demoted to polling (A1.1), or the
 *      stream is switched off — → `503 + Retry-After: 60`, the same answer as a full hub,
 *      so a browser whose `EventSource` retries on its own meets the refusal the
 *      amendment describes and the client-config document, not the stream, says when to
 *      come back. Not seeded yet → `503 + Retry-After: 5`. Over the global cap →
 *      `503 + Retry-After: 60` (A1.1: the client stays on polling and tries the stream
 *      again in a minute). Over the per-client cap → `429 + Retry-After: 60` (A1.3).
 *      All four are RFC 7807 through the scope's own handler; none of them holds a
 *      connection.
 *   2. **`retry: 5000`** — the browser's reconnect delay from now on (D1).
 *   3. **Replay or reset.** The cursor is `Last-Event-ID` when the browser is
 *      reconnecting, else `?last_event_id=` for a first connection after a snapshot
 *      (`EventSource` cannot set headers, so the first cursor travels in the URL and the
 *      browser takes over from there). A cursor the ring still covers replays every
 *      frame above it; a cursor below the ring's floor or above its latest is a `reset`
 *      frame (D3 rule 3), and so is no cursor or one that is not an integer at all —
 *      never a 400, because a reconnecting `EventSource` would retry a 400 forever and a
 *      reset ("fetch a snapshot") is the recovery.
 *   4. **The cached `freshness` frame** (D2), which also carries the mark a client
 *      compares its own against.
 *
 * Afterwards the connection only ever receives what the hub broadcasts. A client that
 * cannot keep up is disconnected once the unsent bytes pass {@link MAX_BUFFERED_BYTES}:
 * the ring exists so that a reconnect is cheap, whereas a process that buffers for a
 * stalled socket is a process that buffers for five thousand of them.
 *
 * Headers are the D1 set: `text/event-stream`, `no-cache, no-transform` (a transforming
 * proxy would buffer or gzip the stream into silence), `X-Accel-Buffering: no` for an
 * nginx in front, and CORS `*` because the data is public. GET only — a HEAD would admit
 * a sink that never reads.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PassThrough } from 'node:stream';

import type { SseRejectReason } from '../../core/observability/metric-catalog.js';
import { KEEPALIVE_CHUNK, encodeFrame, encodeRetry } from '../../core/stream/frames.js';
import type { StreamHub } from '../../core/stream/stream-hub.js';
import type { StreamPump } from '../../core/stream/stream-pump.js';
import { clientKey } from './client-key.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const STREAM_PATH = '/api/v1/stream';

/** The first-connection cursor: the same value the browser later sends as `Last-Event-ID`. */
export const CURSOR_PARAM = 'last_event_id';

/** D1: the reconnect delay a client is told on connect. */
export const DEFAULT_RETRY_MS = 5_000;

/**
 * A1.1: when refused for capacity — or because the fleet has been demoted — the client
 * stays on polling and asks again in a minute.
 */
const CAPACITY_RETRY_AFTER_SECONDS = 60;

/** Before the seed read has landed there is no ring to replay from; a few seconds is enough. */
const NOT_READY_RETRY_AFTER_SECONDS = 5;

/**
 * Unsent bytes a connection may hold before it is cut. A full replay of a thousand-frame
 * ring is under this; a client that has not drained that much is not reading.
 */
export const MAX_BUFFERED_BYTES = 256 * 1024;

export interface StreamRouteDeps {
  readonly hub: StreamHub;
  readonly pump: Pick<StreamPump, 'ready' | 'replayAfter' | 'freshness'>;
  /** Receives every refusal's correlation id; the caller owns the log line. */
  readonly onProblem?: ProblemObserver | undefined;
  /** The edge-owned client-IP header, lowercased — see `HealthServerDeps.clientIpHeader`. */
  readonly clientIpHeader?: string | undefined;
  readonly retryMs?: number | undefined;
  /**
   * Whether the stream is on offer *now* — the demotion controller's answer (A1.1).
   * Absent means always offered, which is what a box with no controller wired has.
   */
  readonly offered?: (() => boolean) | undefined;
  /**
   * Told which admission check refused a connect, before the refusal is thrown (C5's
   * `fw_sse_rejected_total`). Observation only: whatever it throws is swallowed, because a
   * counter must never turn a 503 into a 500.
   */
  readonly onRefused?: ((reason: SseRejectReason) => void) | undefined;
}

export function registerStreamRoute(app: FastifyInstance, deps: StreamRouteDeps): void {
  const retryChunk = encodeRetry(deps.retryMs ?? DEFAULT_RETRY_MS);
  const refused = (reason: SseRejectReason): void => {
    try {
      deps.onRefused?.(reason);
    } catch {
      // See `onRefused`: the refusal goes out regardless.
    }
  };

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route({
      method: 'GET',
      url: STREAM_PATH,
      // Fastify would otherwise mint a HEAD route that runs this handler — and admits a sink.
      exposeHeadRoute: false,
      handler: (request, reply) => {
        const cursor = cursorFrom(request);

        if (deps.offered !== undefined && !deps.offered()) {
          refused('not_offered');
          throw new ProblemError({
            status: 503,
            title: 'Stream not offered',
            detail: 'The stream is not offered at the moment; poll the snapshot and retry later.',
            retryAfterSeconds: CAPACITY_RETRY_AFTER_SECONDS,
          });
        }

        if (!deps.pump.ready()) {
          refused('not_ready');
          throw new ProblemError({
            status: 503,
            title: 'Stream not ready',
            detail: 'The stream has not loaded its state yet; retry after the indicated delay.',
            retryAfterSeconds: NOT_READY_RETRY_AFTER_SECONDS,
          });
        }

        const stream = new PassThrough();
        const sink = {
          write: (chunk: string) => {
            if (stream.destroyed || stream.writableEnded) return;
            stream.write(chunk);
            if (stream.writableLength + stream.readableLength > MAX_BUFFERED_BYTES) {
              stream.destroy();
            }
          },
          end: () => {
            if (!stream.destroyed && !stream.writableEnded) stream.end();
          },
        };

        const admission = deps.hub.admit(clientKey(request, deps.clientIpHeader), sink);
        if (admission.kind === 'refused') {
          refused(admission.reason);
          throw admission.reason === 'capacity'
            ? new ProblemError({
                status: 503,
                title: 'Stream at capacity',
                detail: 'No stream connections are available; poll the snapshot and retry later.',
                retryAfterSeconds: CAPACITY_RETRY_AFTER_SECONDS,
              })
            : new ProblemError({
                status: 429,
                title: 'Too many streams',
                detail: 'This client already holds its share of stream connections.',
                retryAfterSeconds: CAPACITY_RETRY_AFTER_SECONDS,
              });
        }
        // Fastify destroys the payload stream when the response closes for any reason
        // (client gone, server closing, our own guard), so this is the one release point.
        stream.once('close', admission.release);

        sink.write(retryChunk);
        const outcome = deps.pump.replayAfter(cursor);
        if (outcome.kind === 'replay') {
          for (const frame of outcome.frames) sink.write(encodeFrame(frame));
        } else {
          sink.write(encodeFrame({ event: 'reset', data: { reason: outcome.reason } }));
        }
        const freshness = deps.pump.freshness();
        sink.write(freshness === null ? KEEPALIVE_CHUNK : encodeFrame(freshness));

        reply.header('content-type', 'text/event-stream; charset=utf-8');
        reply.header('cache-control', 'no-cache, no-transform');
        reply.header('x-accel-buffering', 'no');
        // Not returned: a sync handler's return value is sent again, on top of the stream.
        void reply.send(stream);
      },
    });
    done();
  });
}

/**
 * The cursor the client resumes from. `Last-Event-ID` wins: the browser sets it on every
 * reconnect and it is newer than whatever the URL said. No cursor, or anything that is not
 * exactly one non-negative safe integer, resolves to `-1` — below every ring's floor, so
 * the ring answers with a reset; see the module comment for why that is not a 400.
 * Unknown query parameters *are* a 400, as on the snapshot: the URL space a client may
 * hit is the path times one cursor.
 */
function cursorFrom(request: FastifyRequest): number {
  const header = request.headers['last-event-id'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader !== undefined) return parseCursor(fromHeader);

  const query = request.query;
  if (typeof query !== 'object' || query === null) return -1;
  let cursor = -1;
  for (const [name, value] of Object.entries(query as Record<string, unknown>)) {
    if (name !== CURSOR_PARAM) {
      throw new ProblemError({
        status: 400,
        title: 'Invalid query',
        detail: 'unknown query parameter',
      });
    }
    cursor = typeof value === 'string' ? parseCursor(value) : -1;
  }
  return cursor;
}

function parseCursor(text: string): number {
  if (!/^\d{1,16}$/.test(text)) return -1;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}
