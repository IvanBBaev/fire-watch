/**
 * The `MeteoalarmClient` port over HTTPS against MeteoAlarm's public feeds (V2-B3;
 * DATA-SOURCES-EXTENDED §J11).
 *
 *   * **Feeds:** `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-<slug>`, one per
 *     country, keyless. The previous answer's `ETag` / `Last-Modified` go back as
 *     `If-None-Match` / `If-Modified-Since`; a 304 is `not-modified`.
 *   * **CAP alerts:** only URLs on `https://feeds.meteoalarm.org` (`isCapUrl`), checked
 *     again here so the adapter cannot be talked into fetching anything else.
 *
 * Redirects are not followed (`redirect: 'manual'`): a moved feed is a failure to look at,
 * not a host to chase. Bodies are capped. Value-style: nothing is thrown.
 */

import { isCapUrl, METEOALARM_CAP_ORIGIN } from '../../core/meteoalarm/meteoalarm-feed.js';
import type {
  FeedValidators,
  MeteoalarmCapFetch,
  MeteoalarmClient,
  MeteoalarmFeedFetch,
} from '../../core/ports/meteoalarm-client.js';

export const METEOALARM_FEED_BASE_URL = `${METEOALARM_CAP_ORIGIN}/feeds/meteoalarm-legacy-atom-`;

export const METEOALARM_TIMEOUT_MS = 30_000;

/** The largest recorded national feed is ~40 KiB; a busy summer day stays well under this. */
export const METEOALARM_MAX_FEED_BYTES = 2 * 1024 * 1024;

/** A CAP alert with every language block is a few KiB. */
export const METEOALARM_MAX_CAP_BYTES = 256 * 1024;

const BODY_EXCERPT_CHARS = 200;

export interface MeteoalarmHttpClientOptions {
  readonly feedBaseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so the test never opens a socket. */
  readonly fetch?: typeof globalThis.fetch;
}

export function meteoalarmFeedUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}${encodeURIComponent(slug)}`;
}

export function createMeteoalarmHttpClient(
  options: MeteoalarmHttpClientOptions = {},
): MeteoalarmClient {
  const feedBaseUrl = options.feedBaseUrl ?? METEOALARM_FEED_BASE_URL;
  const timeoutMs = options.timeoutMs ?? METEOALARM_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async fetchFeed(slug: string, validators: FeedValidators | null): Promise<MeteoalarmFeedFetch> {
      if (!/^[a-z][a-z-]{1,40}$/.test(slug)) {
        return { kind: 'failed', status: null, error: `invalid country slug ${slug}` };
      }
      const headers: Record<string, string> = { accept: 'application/atom+xml, application/xml' };
      if (validators?.etag != null) headers['if-none-match'] = validators.etag;
      if (validators?.lastModified != null) headers['if-modified-since'] = validators.lastModified;

      let response: Response;
      try {
        response = await doFetch(meteoalarmFeedUrl(feedBaseUrl, slug), {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual',
          headers,
        });
      } catch (error) {
        return {
          kind: 'failed',
          status: null,
          error: `MeteoAlarm feed request failed for ${slug}: ${describe(error)}`,
        };
      }
      if (response.status === 304) {
        await discardBody(response);
        return { kind: 'not-modified' };
      }
      if (response.status !== 200) {
        const body = await readBodySafely(response);
        return {
          kind: 'failed',
          status: response.status,
          error: `MeteoAlarm returned ${String(response.status)} for ${slug}: ${excerpt(body)}`,
        };
      }
      const body = await readCapped(response, METEOALARM_MAX_FEED_BYTES);
      if (typeof body !== 'string') {
        return { kind: 'failed', status: null, error: `MeteoAlarm feed ${slug}: ${body.error}` };
      }
      return {
        kind: 'ok',
        body,
        validators: {
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
        },
      };
    },

    async fetchCap(url: string): Promise<MeteoalarmCapFetch> {
      if (!isCapUrl(url)) return { body: null, error: 'CAP link is not on MeteoAlarm' };
      let response: Response;
      try {
        response = await doFetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual',
          headers: { accept: 'application/cap+xml, application/xml' },
        });
      } catch (error) {
        return { body: null, error: `CAP request failed: ${describe(error)}` };
      }
      if (response.status !== 200) {
        const body = await readBodySafely(response);
        return {
          body: null,
          error: `MeteoAlarm returned ${String(response.status)} for a CAP alert: ${excerpt(body)}`,
        };
      }
      const body = await readCapped(response, METEOALARM_MAX_CAP_BYTES);
      return typeof body === 'string'
        ? { body, error: null }
        : { body: null, error: `CAP alert: ${body.error}` };
    },
  };
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string | { readonly error: string }> {
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    return { error: `body was unreadable: ${describe(error)}` };
  }
  if (bytes.byteLength > maxBytes) {
    return { error: `body is ${String(bytes.byteLength)} bytes, over the cap` };
  }
  return new TextDecoder().decode(bytes);
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // nothing to release
  }
}

async function readBodySafely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > BODY_EXCERPT_CHARS ? `${flat.slice(0, BODY_EXCERPT_CHARS)}…` : flat;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
