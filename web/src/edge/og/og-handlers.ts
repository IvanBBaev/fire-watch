/**
 * The two og routes (TASKS V2-D4), as runtime-neutral fetch handlers: `Request` in,
 * `Response` out, with the shell, the snapshot, the rasteriser and the clock injected.
 * The Cloudflare Pages Functions under `web/functions/` only wire these to the platform,
 * so everything a test needs to prove — status codes, caching, escaping, determinism —
 * is proved here, without a platform.
 *
 * - `GET /event/:id` — the app shell with the event's Open Graph / Twitter tags injected
 *   between the og markers, including the PNG route's URL. An id the snapshot does not
 *   hold gets the unmodified shell with status 404 (the app renders its own not-found
 *   panel); a snapshot that cannot be read gets the unmodified shell with 200, because a
 *   preview is an extra and the permalink must keep working without it.
 * - `GET /og/event/:id.png` — the same card, rasterised. Strong ETag over the exact SVG
 *   the PNG is drawn from (plus the renderer revision), so `If-None-Match` answers 304
 *   without rasterising; the PNG itself sits in a {@link BoundedCache}. An unknown id is a
 *   404, an unreadable snapshot a 503 — never a stale or placeholder picture.
 *
 * No PII: neither route reads cookies, logs anything, echoes request headers, or puts
 * anything but the public id and the locale into a URL or a cache key.
 */

import { parseSnapshot } from '../../core/feed/parse-snapshot.js';
import type { Snapshot } from '../../core/types.js';
import type { BoundedCache } from './bounded-cache.js';
import { injectOgMeta } from './inject-meta.js';
import { findSnapshotEvent, ogCardImage, ogMetaTags, requestLocale } from './og-card.js';

export interface OgDependencies {
  /** The static app shell (`index.html`) as the host serves it. */
  readonly loadShell: () => Promise<Response>;
  /** The published `/snapshot.json` body, parsed as JSON but not yet guarded. */
  readonly loadSnapshot: () => Promise<unknown>;
  /** SVG document in, PNG bytes out. Must be deterministic for a given SVG. */
  readonly rasterize: (svg: string) => Promise<Uint8Array>;
  /** Server epoch ms — the card's "image created" stamp and the staleness clock. */
  readonly now: () => number;
  readonly cache: BoundedCache<Uint8Array>;
  /**
   * Changes whenever the same SVG would rasterise differently (renderer or font update),
   * so an ETag a client holds never vouches for pixels the route no longer draws.
   */
  readonly rendererRevision: string;
}

/** Previews are re-fetched by scrapers rarely; one snapshot cycle of edge caching is plenty. */
const SHELL_CACHE_CONTROL = 'public, max-age=60';
const IMAGE_CACHE_CONTROL = 'public, max-age=300';
const MISS_CACHE_CONTROL = 'public, max-age=60';

async function readSnapshot(deps: OgDependencies): Promise<Snapshot | null> {
  try {
    return parseSnapshot(await deps.loadSnapshot());
  } catch {
    return null;
  }
}

function originOf(request: Request): string {
  return new URL(request.url).origin;
}

function acceptLanguage(request: Request): string | null {
  return request.headers.get('accept-language');
}

function plain(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

export async function handleEventShell(
  request: Request,
  requestedId: string,
  deps: OgDependencies,
): Promise<Response> {
  const shell = await deps.loadShell();
  if (!shell.ok) return shell;
  const snapshot = await readSnapshot(deps);
  if (snapshot === null) return shell;
  const html = await shell.text();
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': SHELL_CACHE_CONTROL,
    vary: 'Accept-Language',
  };
  const event = findSnapshotEvent(snapshot, requestedId);
  if (event === null) return new Response(html, { status: 404, headers });

  const locale = requestLocale(null, acceptLanguage(request));
  const tags = ogMetaTags({
    snapshot,
    event,
    locale,
    origin: originOf(request),
    nowMs: deps.now(),
  });
  return new Response(injectOgMeta(html, tags, locale), { status: 200, headers });
}

/** Hex SHA-256 of a string — Web Crypto, present in workers and in Node 22 alike. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `If-None-Match` per RFC 9110: a list of entity tags, or `*`; weak tags compare weakly. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const wanted = ifNoneMatch.trim();
  if (wanted === '*') return true;
  return wanted
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//u, ''))
    .includes(etag);
}

export async function handleEventImage(
  request: Request,
  segment: string,
  deps: OgDependencies,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return plain(405, 'Method Not Allowed', { allow: 'GET, HEAD' });
  }
  if (!segment.endsWith('.png'))
    return plain(404, 'Not Found', { 'cache-control': MISS_CACHE_CONTROL });
  const requestedId = segment.slice(0, -'.png'.length);

  const snapshot = await readSnapshot(deps);
  if (snapshot === null) {
    return plain(503, 'Service Unavailable', { 'cache-control': 'no-store', 'retry-after': '60' });
  }
  const event = findSnapshotEvent(snapshot, requestedId);
  if (event === null) return plain(404, 'Not Found', { 'cache-control': MISS_CACHE_CONTROL });

  const url = new URL(request.url);
  const locale = requestLocale(url.searchParams.get('lang'), acceptLanguage(request));
  const image = ogCardImage({ snapshot, event, locale, origin: url.origin, nowMs: deps.now() });
  const etag = `"og-${(await sha256Hex(`${deps.rendererRevision}\n${image.svg}`)).slice(0, 32)}"`;
  const headers = {
    etag,
    'cache-control': IMAGE_CACHE_CONTROL,
    vary: 'Accept-Language',
    'x-content-type-options': 'nosniff',
  };
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }

  let png = deps.cache.get(etag);
  if (png === undefined) {
    png = await deps.rasterize(image.svg);
    deps.cache.set(etag, png);
  }
  // A copy per response: the body is then a plain ArrayBuffer view, and a consumer that
  // transfers or detaches it can never reach the cached bytes.
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(png), {
    status: 200,
    headers: { ...headers, 'content-type': 'image/png', 'content-length': String(png.byteLength) },
  });
}
