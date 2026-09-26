/**
 * The `EffisClient` port over HTTP (TASKS C4; ADR-001 A1.2; DATA-SOURCES §D1).
 *
 * Same wire discipline as the FIRMS client — injected fetch, hard timeout, no redirect
 * following, clock read only once the body is complete — but value-style instead of
 * throwing: the refresh cycle treats "EFFIS did not answer" as a routine outcome that
 * keeps the stale copy, so the failure travels as data. No key to redact here; EFFIS is
 * an open service.
 *
 * Deliberately no judgement of the body: a 200 carrying ServiceException XML or a blank
 * raster leaves this adapter exactly as EFFIS sent it, Content-Type verbatim. The A2.2
 * sanity verdict decides what may be cached, and that decision is core logic under test
 * — an adapter that quietly "helped" would move the acceptance fixtures out of reach.
 *
 * No retry: the next scheduled refresh is the retry, and it is visible in the store.
 */

import type { Clock } from '../../core/ports/clock.js';
import type {
  EffisClient,
  EffisLayerFetch,
  EffisLayerRequest,
} from '../../core/ports/effis-client.js';

/** The open EFFIS mapserver endpoint (DATA-SOURCES §D1); WMS and WFS share it. */
export const EFFIS_BASE_URL = 'https://maps.effis.emergency.copernicus.eu/effis';

/** GetMap over an 11°×7° box can be slow on a bad day; a refresh is never in a hurry. */
export const EFFIS_TIMEOUT_MS = 60_000;

/** How much of an unexpected body an error carries, in characters. */
const BODY_EXCERPT_CHARS = 200;

export interface EffisHttpClientOptions {
  /** Stamps `availableAt` the moment the body is in our hands. */
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so the test never opens a socket. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createEffisHttpClient(options: EffisHttpClientOptions): EffisClient {
  const baseUrl = (options.baseUrl ?? EFFIS_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? EFFIS_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async fetchLayer(request: EffisLayerRequest): Promise<EffisLayerFetch> {
      const url = `${baseUrl}?${new URLSearchParams(request.query).toString()}`;

      let httpResponse: Response;
      try {
        httpResponse = await doFetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch (error) {
        return failure(`EFFIS request failed for ${request.layer}: ${describe(error)}`);
      }

      if (!httpResponse.ok) {
        const body = await readBodySafely(httpResponse);
        return failure(
          `EFFIS returned ${String(httpResponse.status)} for ${request.layer}: ${excerpt(body)}`,
          httpResponse.status,
        );
      }

      let buffer: ArrayBuffer;
      try {
        buffer = await httpResponse.arrayBuffer();
      } catch (error) {
        return failure(
          `EFFIS response body was unreadable for ${request.layer}: ${describe(error)}`,
          httpResponse.status,
        );
      }

      // Clock read only after the last byte: `availableAt` is when the layer was in our
      // hands, and a slow raster transfer can take real time.
      return {
        status: httpResponse.status,
        bytes: new Uint8Array(buffer),
        contentType: httpResponse.headers.get('content-type'),
        availableAt: options.clock.now(),
        error: null,
      };
    },
  };
}

function failure(error: string, status: number | null = null): EffisLayerFetch {
  return { status, bytes: null, contentType: null, availableAt: null, error };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

async function readBodySafely(httpResponse: Response): Promise<string> {
  try {
    return await httpResponse.text();
  } catch {
    return '<unreadable body>';
  }
}

function excerpt(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > BODY_EXCERPT_CHARS
    ? `${collapsed.slice(0, BODY_EXCERPT_CHARS)}…`
    : collapsed;
}
