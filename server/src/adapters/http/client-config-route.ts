/**
 * `GET /api/v1/client-config` — the fleet-control document (ADR-003 D1 "server-side
 * transport control", A1.1, A1.2, A1.3; 04 §5.2.3).
 *
 * Three fields, one purpose: to move every client between tiers, and to a static copy of
 * the snapshot, without a client release — plus, since G6, an optional fourth, `imagery`
 * (ADR-001 A2.3), present only while the imagery toggle is enabled. The document is built
 * on every request from whatever the wiring says *now* — the demotion controller's
 * transport, the configured poll cadence, the configured static URL, the imagery meter's
 * block — and it is the edge, not the origin, that makes it cheap:
 *
 *   * `Cache-Control: public, max-age=30`, and nothing more. Thirty seconds is the "one
 *     config TTL" of A1.1 L-2 criterion 1 (a flip must be visible fleet-wide within it),
 *     which is why there is no `stale-while-revalidate` here as there is on the snapshot:
 *     SWR would let the edge keep answering `sse` for a minute past the flip to `poll`,
 *     which is the one thing this document exists to say on time. And no `s-maxage`:
 *     the browser and the edge may hold it for the same thirty seconds, so a poll from a
 *     warm browser cache costs nothing and is still never older than one TTL.
 *   * No `ETag`. The body is under a hundred bytes, a few hundred with the imagery block —
 *     no bigger than the headers of the conditional request that would save resending it.
 *   * `Access-Control-Allow-Origin: *`, GET and HEAD only, no credentials (A1.3): the
 *     document is public. No `Vary: Origin`, since the header is constant.
 *   * No query parameters at all. The URL space an edge may cache is exactly one path;
 *     a `?_=…` cache-buster from a careless consumer must not become an origin hit per
 *     request, so any query string is refused with a 400 problem — the snapshot's rule.
 *   * No per-IP throttle (A1.3): the cache rule is the protection. The probe hook exempts
 *     the path by name, as it does the two read routes.
 *
 * The body carries no secret, hostname or version: two enum-and-integer members, a
 * static URL which is a public CDN address by design (A1.2), and, while imagery is on, a
 * provider tile template and an ArcGIS *client* key — public by design too (A1.3/A2.3:
 * it is meant for browsers and is referrer-restricted at the provider, not kept secret).
 * Thirty seconds of edge caching is also what bounds how long a tripped block can outlive
 * the trip.
 */

import type { ClientConfigDocument } from '@fire-watch/contracts';
import type { FastifyInstance } from 'fastify';

import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const CLIENT_CONFIG_PATH = '/api/v1/client-config';

/** One config TTL (A1.1 L-2 criterion 1), for the edge and the browser alike. */
export const CLIENT_CONFIG_CACHE_CONTROL = 'public, max-age=30';

export interface ClientConfigRouteDeps {
  /** Called on every request: the document must say what the controller says *now*. */
  readonly document: () => ClientConfigDocument;
  /** Receives every refusal's correlation id; the caller owns the log line. */
  readonly onProblem?: ProblemObserver | undefined;
}

export function registerClientConfigRoute(app: FastifyInstance, deps: ClientConfigRouteDeps): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route({
      method: ['GET', 'HEAD'],
      url: CLIENT_CONFIG_PATH,
      handler: (request, reply) => {
        refuseQuery(request.query);
        const { transport, poll_interval_ms, static_snapshot_url, imagery } = deps.document();
        // Rebuilt member by member: the wire shape is exactly these, whatever else a future
        // document type may carry. The imagery block is absent, not null, when imagery is
        // off (A2.3), and is itself rebuilt so nothing rides along inside it.
        const body: ClientConfigDocument = {
          transport,
          poll_interval_ms,
          static_snapshot_url,
          ...(imagery === undefined
            ? {}
            : {
                imagery: {
                  tile_url_template: imagery.tile_url_template,
                  api_key: imagery.api_key,
                },
              }),
        };
        reply.header('cache-control', CLIENT_CONFIG_CACHE_CONTROL);
        return reply.type('application/json').send(body);
      },
    });
    done();
  });
}

function refuseQuery(query: unknown): void {
  if (typeof query !== 'object' || query === null) return;
  if (Object.keys(query).length === 0) return;
  throw new ProblemError({
    status: 400,
    title: 'Invalid query',
    detail: 'This resource takes no query parameters.',
  });
}
