/**
 * The FIRMS Area API over HTTP — the only code that holds the MAP_KEY.
 *
 * FIRMS carries the key as a *path segment*, not a header or a query parameter:
 *
 *   https://firms.modaps.eosdis.nasa.gov/api/area/csv/<MAP_KEY>/<PRODUCT>/<AREA>/<DAYS>
 *
 * A key in a path is a key in every access log, proxy log, exception message and stack
 * trace the URL ever reaches. So the URL is assembled here and nowhere else, and every
 * error this module raises is redacted before it leaves — including errors raised by
 * `fetch` itself, which happily quote the URL they failed on.
 *
 * There is no retry. A failed poll is recorded as a failed poll (DATA-SOURCES §A1.1
 * pitfall 10) and the next cycle, ten to fifteen minutes later, is the retry — one that
 * is visible in the archive rather than hidden inside a call.
 */

import type { Clock } from '../../core/ports/clock.js';
import type {
  FirmsAreaClient,
  FirmsAreaQuery,
  FirmsAreaResponse,
} from '../../core/ports/firms-client.js';

export const FIRMS_BASE_URL = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

/** Long enough for a slow day at NASA, short enough that a cycle cannot pile up. */
export const FIRMS_TIMEOUT_MS = 60_000;

/** How much of an unexpected body an error carries, in characters. */
const BODY_EXCERPT_CHARS = 200;

export interface FirmsHttpClientOptions {
  readonly mapKey: string;
  /** Stamps `available_at` the moment the body is in our hands. */
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so the test never opens a socket. */
  readonly fetch?: typeof globalThis.fetch;
}

export class FirmsHttpError extends Error {
  override readonly name = 'FirmsHttpError';
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

export function createFirmsHttpClient(options: FirmsHttpClientOptions): FirmsAreaClient {
  const mapKey = assertMapKey(options.mapKey);
  const baseUrl = (options.baseUrl ?? FIRMS_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? FIRMS_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const redact = (text: string): string => text.split(mapKey).join('<MAP_KEY>');

  return {
    async fetchArea(query: FirmsAreaQuery): Promise<FirmsAreaResponse> {
      const url = areaUrl(baseUrl, mapKey, query);

      let httpResponse: Response;
      try {
        httpResponse = await doFetch(url, {
          headers: { accept: 'text/csv' },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch (error) {
        // `fetch` quotes the URL it failed on, and the URL is the key.
        throw new FirmsHttpError(
          `FIRMS request failed for ${query.product}: ${redact(describe(error))}`,
          null,
        );
      }

      if (!httpResponse.ok) {
        const body = await readBodySafely(httpResponse);
        throw new FirmsHttpError(
          `FIRMS returned ${String(httpResponse.status)} for ${query.product}: ` +
            redact(excerpt(body)),
          httpResponse.status,
        );
      }

      let csv: string;
      try {
        csv = await httpResponse.text();
      } catch (error) {
        throw new FirmsHttpError(
          `FIRMS response body was unreadable for ${query.product}: ${redact(describe(error))}`,
          httpResponse.status,
        );
      }

      // Read the clock only once the body is complete: `available_at` is when the rows
      // were in our hands, and on a slow transfer the gap is minutes, not milliseconds.
      return { csv, availableAt: options.clock.now() };
    },
  };
}

/**
 * `.../<MAP_KEY>/<PRODUCT>/<AREA>/<DAY_RANGE>[/<START_DATE>]`. Each segment is encoded,
 * so a malformed product or area can never escape into the path and address a different
 * endpoint — with one deliberate exception: the comma that separates the bbox ordinates.
 *
 * A comma is a sub-delimiter, legal unencoded in a path segment (RFC 3986 §3.3), and it
 * is what the documented URL looks like. Sending `%2C` relies on the server decoding the
 * path before it routes, which is a bet with no upside: it would fail as a 404 whose body
 * we redact, in the middle of a season we cannot re-poll.
 */
export function areaUrl(baseUrl: string, mapKey: string, query: FirmsAreaQuery): string {
  if (!Number.isInteger(query.dayRange) || query.dayRange < 1 || query.dayRange > 10) {
    throw new RangeError(`day_range must be an integer in 1..10, got ${String(query.dayRange)}`);
  }
  const segments = [
    mapKey,
    query.product,
    query.area,
    String(query.dayRange),
    ...(query.startDate === undefined ? [] : [query.startDate]),
  ];
  return `${baseUrl}/${segments.map(encodePathSegment).join('/')}`;
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%2C/g, ',');
}

/**
 * A key that is empty, padded or not a single path segment is a misconfiguration, and it
 * has to fail at wiring time. Discovering it at 03:00 through a 404 whose message we
 * deliberately redact is the worst possible time.
 */
function assertMapKey(mapKey: string): string {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(mapKey)) {
    throw new RangeError(
      'FIRMS map key must be at least 16 characters of [A-Za-z0-9_-] and nothing else — ' +
        'a stray slash, space or newline would rewrite the request path ' +
        `(got ${String(mapKey.length)} characters)`,
    );
  }
  return mapKey;
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
