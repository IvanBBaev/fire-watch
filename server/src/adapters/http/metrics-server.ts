/**
 * The internal metrics server (TASKS C5; OPERATIONS §3): `GET /metrics` — and, in the
 * worker, `GET /api/health/meta` (TASKS J1) — on its own Fastify instance and its own port,
 * never a route on the public health/API server.
 *
 * Why a separate instance rather than a route on `createHealthServer` behind a check:
 *
 *   * The public server sits behind Cloudflare, whose edge would cache and serve a route
 *     it can reach. A listener the edge cannot reach has no such failure mode.
 *   * The exposition names every freshness row, every loop and every table. That is an
 *     inventory of the system, and it is nobody's business but the scraper's.
 *   * A bug in the public server's routing (a prefix, a wildcard, a future plugin) cannot
 *     expose a route that was never registered on it. `health-server.test.ts` proves the
 *     public instance answers `/metrics` with its ordinary 404.
 *
 * Bind and auth follow OPERATIONS §8 (secrets by file, loopback by default): the listener
 * binds where the config says (default `127.0.0.1`), and when a bearer token is configured,
 * every request without exactly that token is refused with a 401 that says nothing else.
 * The comparison runs over SHA-256 digests with `timingSafeEqual`, so neither the token's
 * content nor its length leaks through timing.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import type { MetaHealthVerdict } from '../../core/monitoring/meta-health.js';
import { PROMETHEUS_TEXT_CONTENT_TYPE } from '../../core/observability/prometheus-text.js';
import type { MetricsRegistry } from '../metrics/metrics-registry.js';

export const METRICS_PATH = '/metrics';

/**
 * The meta-alert verdict (TASKS J1; `core/monitoring/meta-health.ts`). Registered only when
 * a process hands in {@link MetricsServerDeps.metaHealth} — the worker, which runs the
 * monitors loop — and only ever on this listener, behind the same token as the scrape.
 */
export const META_HEALTH_PATH = '/api/health/meta';

export interface MetricsServerDeps {
  readonly registry: MetricsRegistry;
  /** When set, a request must carry `Authorization: Bearer <token>`. */
  readonly bearerToken?: string | null | undefined;
  /** The monitors loop's verdict, read per request; the route exists only when set. */
  readonly metaHealth?: (() => MetaHealthVerdict) | undefined;
}

export function createMetricsServer(deps: MetricsServerDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    // A scrape is a GET with no body; nothing larger than this is a scraper.
    bodyLimit: 1024,
  });

  const expected = deps.bearerToken == null ? null : digest(`Bearer ${deps.bearerToken}`);

  app.addHook('onRequest', (request, reply, done) => {
    noStore(reply);
    if (expected !== null) {
      const given = request.headers.authorization;
      if (typeof given !== 'string' || !timingSafeEqual(digest(given), expected)) {
        void reply.code(401).header('www-authenticate', 'Bearer').send({ status: 'unauthorized' });
        return;
      }
    }
    done();
  });

  app.setNotFoundHandler((_request, reply) => {
    noStore(reply);
    return reply.code(404).send({ status: 'not_found' });
  });
  app.setErrorHandler((_error, _request, reply) => {
    noStore(reply);
    return reply.code(500).send({ status: 'error' });
  });

  app.get(METRICS_PATH, async (_request, reply) => {
    const body = await deps.registry.render();
    return reply.header('content-type', PROMETHEUS_TEXT_CONTENT_TYPE).send(body);
  });

  const metaHealth = deps.metaHealth;
  if (metaHealth !== undefined) {
    app.get(META_HEALTH_PATH, (_request, reply) => {
      const verdict = metaHealth();
      return reply.code(verdict.statusCode).send(verdict.body);
    });
  }

  return app;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store, max-age=0');
}
