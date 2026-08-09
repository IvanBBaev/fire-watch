/**
 * The probe surface (OPERATIONS §2) — three routes and nothing else.
 *
 *   GET /healthz                 liveness: the process is up. No database, ever.
 *   GET /readyz                  readiness: this box can reach its database.
 *   GET /api/health/freshness    the canonical freshness answer, 500 when blind.
 *
 * `/api/v1/meta/freshness` is superseded and is deliberately **not** implemented and **not**
 * aliased (§2.1). An alias would mean two paths whose Grafana rules, CDN rules and
 * UptimeRobot monitors have to be kept in agreement forever, and the day they disagree is
 * the day one of them is quietly green.
 *
 * Four properties this file exists to guarantee, all of them from §2.2:
 *
 *   * Never cached. `no-store` plus the CDN-specific variants, because a cached 200 from
 *     four minutes ago is exactly the answer an outage would like the prober to see.
 *   * Never hangs. The query is bounded by the pool's statement timeout; a database that
 *     does not answer becomes a 500 with a reason, which is a page, not a mystery.
 *   * Leaks nothing. No hostnames, versions, credentials or upstream URLs — the body is
 *     row ids, budgets and timestamps, and errors are reduced to a fixed vocabulary.
 *   * Unauthenticated but rate-limited: a credential on a health endpoint is a credential
 *     whose expiry pages you at 03:00. Liveness alone is exempt from the limiter — it
 *     answers from memory, and refusing it turns a flood into a restart loop.
 */

import type { FreshnessRowId } from '@fire-watch/contracts';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { evaluateFreshness } from '../../core/health/freshness.js';
import { createRateLimiter } from '../../core/http/rate-limiter.js';
import type { Clock } from '../../core/ports/clock.js';
import type { DatabaseProbe, FreshnessReader } from '../../core/ports/freshness-reader.js';

/** Generous for a human, cheap for us; low enough that a loop is not a free connection tap. */
export const DEFAULT_RATE_LIMIT = 60;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/** A probe body is small and fixed; anything larger than this is not a probe. */
const MAX_BODY_BYTES = 1024;

/** Named because two places must agree on it: the route and the limiter exemption. */
const LIVENESS_PATH = '/healthz';

/**
 * The two database-touching routes share this cap on concurrent requests. The rate limiter
 * is per-client; this bounds the *aggregate*, so a distributed burst cannot stack sockets
 * behind the health pool's two connections and its one-second acquire timeout — everything
 * past the cap is refused from memory instead of joining the queue it would time out in.
 */
const MAX_DB_IN_FLIGHT = 8;

/**
 * Longer than any textual IP, v6 zones included. A rate-limit key is an identity, not
 * storage: an edge header stuffed with garbage must not mint kilobyte-sized keys.
 */
const MAX_CLIENT_KEY_LENGTH = 64;

export interface HealthServerDeps {
  readonly reader: FreshnessReader;
  readonly probe: DatabaseProbe;
  readonly clock: Clock;
  /**
   * The rows *this* deployment claims to run. Comes from the same place the scheduler gets
   * its work, so a box that polls three sources reports three rows and cannot be green by
   * having quietly stopped reporting a fourth.
   */
  readonly expected: readonly FreshnessRowId[];
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
  /**
   * The request header our own edge *overwrites* with the real client IP (for Cloudflare,
   * `cf-connecting-ip`), already lowercased — Node lowercases incoming header names, so an
   * uppercased name here would simply never match. The rate limiter keys on it when
   * present and falls back to the socket address when not.
   *
   * Safe only because the deployment's firewall lets nothing but that edge reach the port.
   * Fastify's `trustProxy` is deliberately not used at all: boolean `true` trusts every
   * hop, which makes `request.ip` the leftmost — client-written — `X-Forwarded-For` entry.
   *
   * `| undefined` on top of `?` so that config, whose value is genuinely optional, can be
   * passed straight through under `exactOptionalPropertyTypes` — an explicit `undefined`
   * means the same thing as an absent key here: no edge, key on the socket.
   */
  readonly clientIpHeader?: string | undefined;
}

export function createHealthServer(deps: HealthServerDeps): FastifyInstance {
  const app = Fastify({
    // Logging is the caller's business: this process writes canonical JSON lines, and a
    // second log format on the same stdout is a log nobody can parse.
    logger: false,
    // No `trustProxy`, on purpose: `request.ip` stays the socket peer, and the real client
    // identity travels only in the edge-owned header — see {@link HealthServerDeps}.
    bodyLimit: MAX_BODY_BYTES,
    routerOptions: {
      // A probe URL is short. Refusing a long one costs nothing and removes a class of
      // request that only ever arrives from a scanner. (Top-level `maxParamLength` is
      // deprecated in Fastify 5 and goes away in 6.)
      maxParamLength: 64,
    },
    // Three failures never reach the router, so no hook and no handler below ever sees
    // them: a URL with a broken percent-escape (`FST_ERR_BAD_URL`, 400), a parameter past
    // `maxParamLength` (`FST_ERR_MAX_PARAM_LENGTH`, 414 — unreachable today, no route has
    // parameters) and a failing async route constraint (`FST_ERR_ASYNC_CONSTRAINT`, 500 —
    // unreachable, no route has constraints). Fastify's built-in replies for the first two
    // quote the offending path back at the sender, which is an information leak by this
    // file's own rules. This handler owns that path instead: no-store set by hand, because
    // the onRequest hook does not run here, and the same fixed vocabulary as every other
    // refusal — never the path, never the message.
    frameworkErrors: (error, _request, reply) => {
      noStore(reply);
      void sendOpaque(error, reply);
    },
  });

  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  });

  /**
   * How many requests are currently holding, or waiting for, a database connection —
   * shared by the two routes that touch one. See {@link MAX_DB_IN_FLIGHT}.
   */
  let dbInFlight = 0;

  app.addHook('onRequest', (request, reply, done) => {
    noStore(reply);
    // Liveness is exempt from the limiter: it answers from memory and costs nothing, and
    // a 429'd liveness probe turns a harmless flood into a restart loop — the exact
    // failure the route exists to prevent. Everything else, 404s included, pays.
    if (request.routeOptions.url === LIVENESS_PATH) {
      done();
      return;
    }
    const decision = limiter.check(clientKey(request, deps.clientIpHeader), deps.clock.now());
    if (!decision.allowed) {
      void reply
        .code(429)
        .header('retry-after', String(decision.retryAfterSeconds))
        .send({ status: 'rate_limited' });
      return;
    }
    done();
  });

  // Fastify's default 404 and error bodies quote the path and the message. Both are
  // replaced: a scanner learns nothing from ours, and neither does a stack trace.
  app.setNotFoundHandler((_request, reply) => {
    // Only URLs the router could parse get this far — the truly malformed ones were
    // answered by `frameworkErrors` above and reach no handler at all. An ordinary 404
    // has been through the onRequest hook, so no-store is already set; it is set again
    // because this file's promise is that every terminal reply states it itself, not
    // that some earlier stage probably did. The limiter is deliberately not consulted
    // here: the hook already charged this request, and a second charge would make a 404
    // cost double what a 200 does.
    noStore(reply);
    return reply.code(404).send({ status: 'not_found' });
  });
  app.setErrorHandler((error, _request, reply) => {
    // A client fault — an oversized body, an unparseable content type — must not read as
    // a server failure to a 5xx-alerting monitor. The mapping lives in `sendOpaque`,
    // shared with `frameworkErrors` so the two refusal paths cannot drift apart.
    return sendOpaque(error, reply);
  });

  /**
   * Liveness. Answers from memory and must never touch the database — a liveness probe
   * wired to a dependency restarts the process every time the dependency blinks, which
   * turns a five-minute database hiccup into a crash loop.
   */
  app.get(LIVENESS_PATH, (_request, reply) => reply.send({ status: 'ok' }));

  /** Readiness: pull this box out of rotation, do not restart it. */
  app.get('/readyz', async (_request, reply) => {
    if (dbInFlight >= MAX_DB_IN_FLIGHT) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    dbInFlight += 1;
    try {
      await deps.probe.ping();
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    } finally {
      dbInFlight -= 1;
    }
    return reply.send({ status: 'ok' });
  });

  app.get('/api/health/freshness', async (_request, reply) => {
    if (dbInFlight >= MAX_DB_IN_FLIGHT) {
      return reply.code(503).send({ status: 'unavailable' });
    }
    let observations;
    dbInFlight += 1;
    try {
      observations = await deps.reader.readObservations(deps.expected);
    } catch (error: unknown) {
      // A database that cannot answer within the statement timeout is itself the outage.
      // It is reported as one — with a reason from a fixed vocabulary, never the driver's
      // message, which quotes connection strings.
      return reply.code(500).send({
        status: 'critical',
        reason: unreachableReason(error),
      });
    } finally {
      // Only the database touch is counted: the verdict below is pure arithmetic.
      dbInFlight -= 1;
    }

    const verdict = evaluateFreshness({
      now: deps.clock.now(),
      expected: deps.expected,
      observations,
    });
    return reply.code(verdict.httpStatus).send(verdict.report);
  });

  return app;
}

/**
 * `no-store` for the browser and the two CDN-specific variants, because Cloudflare honours
 * its own headers in preference to `Cache-Control` and a probe answer must never be served
 * from an edge that cannot tell whether the origin is still alive (§2.2 rule 4).
 */
function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store, max-age=0');
  reply.header('cdn-cache-control', 'no-store');
  reply.header('cloudflare-cdn-cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

/**
 * The one refusal shape for anything that is not a routed answer. A client fault keeps its
 * own 4xx status — a 5xx-alerting monitor must not page for something a caller did — and
 * everything else collapses to an opaque 500. Neither branch echoes the path or the
 * message: the body is a fixed vocabulary, whoever produced the error. Used by both the
 * error handler and `frameworkErrors`, so a refusal looks the same whichever stage of
 * Fastify produced it.
 *
 * Takes `unknown`, matching what Fastify 5 hands the error handler: anything a route or a
 * parser threw, which need not be an Error at all. The status code is read structurally
 * for the same reason.
 */
function sendOpaque(error: unknown, reply: FastifyReply): FastifyReply {
  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return reply.code(statusCode).send({ status: 'bad_request' });
  }
  return reply.code(500).send({ status: 'error' });
}

/**
 * The rate-limit key: the edge-owned header when it is configured and present, the socket
 * address otherwise. The fallback keeps loopback traffic — the supervisor's probe, a
 * curl over SSH — keyed sanely on a box where the header is configured but the request
 * never went through the edge. See {@link HealthServerDeps} for why the header can be
 * believed at all.
 */
function clientKey(request: FastifyRequest, clientIpHeader: string | undefined): string {
  if (clientIpHeader !== undefined) {
    const raw = request.headers[clientIpHeader];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value !== undefined && value !== '') {
      return value.slice(0, MAX_CLIENT_KEY_LENGTH);
    }
  }
  return request.ip;
}

/**
 * Two reasons, both of them actionable and neither of them quoting the database. A timeout
 * and a refusal need different first moves — "what is holding the lock" versus "is Postgres
 * running" — and that distinction is the entire information content a probe body owes.
 */
function unreachableReason(error: unknown): 'freshness_query_timeout' | 'freshness_query_failed' {
  if (!(error instanceof Error)) return 'freshness_query_failed';
  // `57014` is Postgres' `query_canceled`, which is what a statement timeout raises.
  const code: unknown = (error as { code?: unknown }).code;
  return code === '57014' || error.name === 'TimeoutError'
    ? 'freshness_query_timeout'
    : 'freshness_query_failed';
}
