/**
 * The T2 static mirror (ADR-003 A1.2, TASKS E3) as a second, independent server: a
 * stand-in for the R2 bucket the snapshot push job writes to, on its own loopback port —
 * a different origin from the app, as the real mirror is a different hostname.
 *
 * It holds one object and serves it the way an S3-compatible bucket does. What goes in is
 * exactly what E3 puts: `server/src/core/snapshot/mirror-plan.ts` `planMirrorObject` —
 * the body is `JSON.stringify(document)` of the whole snapshot document (never a partial
 * one), with that plan's content type, cache policy and three metadata fields, which the
 * bucket serves back as `x-amz-meta-*` headers. What the bucket adds is what R2 adds: a
 * strong `ETag` that is the quoted MD5 of the body, `Last-Modified` at the PUT, a `304`
 * on a matching `If-None-Match`, `Date` on every answer.
 *
 * The web harness cannot import `server/` (it is outside this project's references), so
 * the plan's constants are restated below; each names the export it restates.
 *
 * **CORS is part of the contract here, not a harness detail.** The mirror is cross-origin
 * to the app, and the client's T2 read is conditional once it holds the mirror's tag.
 * `If-None-Match` is not a CORS-safelisted request header, so every conditional read is
 * preflighted; and `ETag` and `Date` are not safelisted response headers, so a page can
 * read neither unless the bucket exposes them. The policy below is therefore the minimum
 * a real bucket must carry for T2 to revalidate and for the server-time tracker to sample
 * it: allowed origin = the app, methods `GET`/`HEAD`, allowed header `If-None-Match`,
 * exposed headers `ETag` and `Date`. A preflight asking for anything else is refused the
 * way R2 refuses it — no `Access-Control-Allow-*` at all — so a client that grew a new
 * request header would fail here before it failed in production.
 *
 * Pushes are explicit (`push`): a test models a live push job by pushing and a dead one
 * by not pushing, so what the object says at any instant is decided by the scenario and
 * never by a background timer.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { WireSnapshot } from './fixture.js';

/** Restates `DEFAULT_MIRROR_OBJECT_KEY` (server/src/core/snapshot/mirror-plan.ts). */
export const MIRROR_OBJECT_KEY = 'snapshot.json';
/** Restates `MIRROR_CACHE_CONTROL`. */
export const MIRROR_CACHE_CONTROL = 'public, max-age=0, s-maxage=30';
/** Restates `MIRROR_CONTENT_TYPE`. */
export const MIRROR_CONTENT_TYPE = 'application/json; charset=utf-8';
/** Restates `MIRROR_META_GENERATED_AT` / `MIRROR_META_MAX_SEQ` / `MIRROR_META_SCHEMA_VERSION`. */
const META_PREFIX = 'x-amz-meta-';
export const MIRROR_META_GENERATED_AT_HEADER = `${META_PREFIX}generated-at`;
export const MIRROR_META_MAX_SEQ_HEADER = `${META_PREFIX}max-seq`;
export const MIRROR_META_SCHEMA_VERSION_HEADER = `${META_PREFIX}schema-version`;

/**
 * The bucket CORS policy T2 needs (see the module comment) — as data, so the report of
 * what a deployment must configure and what this suite exercises are the same list.
 */
export const MIRROR_CORS_POLICY = {
  allowedMethods: ['GET', 'HEAD'],
  allowedHeaders: ['if-none-match'],
  exposeHeaders: ['ETag', 'Date'],
} as const;

export interface MirrorRequest {
  readonly method: string;
  readonly path: string;
  /** Whether the request carried `If-None-Match`. */
  readonly conditional: boolean;
  readonly status: number;
  /** World-clock ms when the answer was decided. */
  readonly at: number;
}

export interface MirrorObject {
  readonly body: string;
  readonly etag: string;
  readonly lastModifiedMs: number;
  readonly generatedAt: string;
  readonly maxSeq: number;
  readonly schemaVersion: number;
}

export interface HarnessMirror {
  /** `http://127.0.0.1:<port>` — its own origin, distinct from the app's. */
  readonly baseUrl: string;
  /** The object's public URL — what client-config advertises as `static_snapshot_url`. */
  readonly objectUrl: string;
  /** Every request answered so far, preflights included, in arrival order. */
  readonly requests: readonly MirrorRequest[];
  /** PUT the document, as one cycle of the E3 push job would. Refuses a partial one. */
  push(document: WireSnapshot): MirrorObject;
  /** The object as it stands, or `null` before the first push. */
  current(): MirrorObject | null;
  close(): Promise<void>;
}

export interface MirrorOptions {
  /** The one origin the bucket's CORS policy allows — the app's. */
  readonly allowedOrigin: string;
  /** Scenario time, epoch ms. */
  readonly clock: () => number;
}

export async function startMirror(options: MirrorOptions): Promise<HarnessMirror> {
  const requests: MirrorRequest[] = [];
  let object: MirrorObject | null = null;
  const objectPath = `/${MIRROR_OBJECT_KEY}`;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://mirror.invalid');
    const now = options.clock();
    const ifNoneMatch = req.headers['if-none-match'] ?? null;
    const origin = req.headers.origin ?? null;
    const corsAllowed = origin === options.allowedOrigin;

    const send = (status: number, headers: Record<string, string>, body: string | null): void => {
      requests.push({
        method,
        path: url.pathname,
        conditional: ifNoneMatch !== null,
        status,
        at: now,
      });
      res.writeHead(status, { date: new Date(now).toUTCString(), vary: 'Origin', ...headers });
      if (method === 'HEAD' || body === null) res.end();
      else res.end(body);
    };

    if (method === 'OPTIONS') {
      send(204, preflightHeaders(req, corsAllowed, options.allowedOrigin), null);
      return;
    }

    const cors: Record<string, string> = corsAllowed
      ? {
          'access-control-allow-origin': options.allowedOrigin,
          'access-control-expose-headers': MIRROR_CORS_POLICY.exposeHeaders.join(', '),
        }
      : {};

    if (method !== 'GET' && method !== 'HEAD') {
      send(405, { allow: 'GET, HEAD', ...cors }, null);
      return;
    }
    if (url.pathname !== objectPath || object === null) {
      send(
        404,
        { 'content-type': 'application/xml', ...cors },
        '<Error><Code>NoSuchKey</Code></Error>',
      );
      return;
    }

    const headers: Record<string, string> = {
      etag: object.etag,
      'last-modified': new Date(object.lastModifiedMs).toUTCString(),
      'cache-control': MIRROR_CACHE_CONTROL,
      [MIRROR_META_GENERATED_AT_HEADER]: object.generatedAt,
      [MIRROR_META_MAX_SEQ_HEADER]: String(object.maxSeq),
      [MIRROR_META_SCHEMA_VERSION_HEADER]: String(object.schemaVersion),
      ...cors,
    };
    if (ifNoneMatch !== null && tagMatches(ifNoneMatch, object.etag)) {
      send(304, headers, null);
      return;
    }
    send(200, { 'content-type': MIRROR_CONTENT_TYPE, ...headers }, object.body);
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    objectUrl: `${baseUrl}${objectPath}`,
    requests,
    push: (document) => {
      if (document.partial) throw new RangeError('mirror: refusing to store a partial snapshot');
      const body = JSON.stringify(document);
      object = {
        body,
        etag: `"${createHash('md5').update(body).digest('hex')}"`,
        lastModifiedMs: options.clock(),
        generatedAt: document.generated_at,
        maxSeq: document.max_seq,
        schemaVersion: document.schema_version,
      };
      return object;
    },
    current: () => object,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      }),
  };
}

/** A CORS preflight answered by the policy above — all of it, or none of it. */
function preflightHeaders(
  req: IncomingMessage,
  corsAllowed: boolean,
  allowedOrigin: string,
): Record<string, string> {
  const method = String(req.headers['access-control-request-method'] ?? '').toUpperCase();
  const asked = String(req.headers['access-control-request-headers'] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  const methodOk = (MIRROR_CORS_POLICY.allowedMethods as readonly string[]).includes(method);
  const headersOk = asked.every((name) =>
    (MIRROR_CORS_POLICY.allowedHeaders as readonly string[]).includes(name),
  );
  if (!corsAllowed || !methodOk || !headersOk) return {};
  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': MIRROR_CORS_POLICY.allowedMethods.join(', '),
    'access-control-allow-headers': MIRROR_CORS_POLICY.allowedHeaders.join(', '),
  };
}

/** RFC 9110 §13.1.2: `If-None-Match` uses the weak comparison. */
function tagMatches(ifNoneMatch: string, etag: string): boolean {
  const strip = (tag: string): string => tag.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some((candidate) => strip(candidate) === strip(etag));
}
