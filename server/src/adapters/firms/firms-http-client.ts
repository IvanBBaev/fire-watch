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
  FirmsAvailabilityQuery,
  FirmsAvailabilityResponse,
} from '../../core/ports/firms-client.js';

export const FIRMS_BASE_URL = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

/** The same host, the same key-in-the-path shape, a different endpoint (pitfall 10). */
export const FIRMS_AVAILABILITY_BASE_URL =
  'https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv';

/** Long enough for a slow day at NASA, short enough that a cycle cannot pile up. */
export const FIRMS_TIMEOUT_MS = 60_000;

/** How much of an unexpected body an error carries, in characters. */
const BODY_EXCERPT_CHARS = 200;

export interface FirmsHttpClientOptions {
  readonly mapKey: string;
  /** Stamps `available_at` the moment the body is in our hands. */
  readonly clock: Clock;
  readonly baseUrl?: string;
  /**
   * Where `fetchDataAvailability` asks. Defaults to {@link FIRMS_AVAILABILITY_BASE_URL},
   * or — when `baseUrl` points somewhere else, as a fake server does — to the same host
   * with the endpoint swapped. A test that redirects the area fetch and still reached NASA
   * for availability would be a test that talks to the internet without saying so.
   */
  readonly availabilityBaseUrl?: string;
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
  const availabilityBaseUrl = (options.availabilityBaseUrl ?? availabilityBaseFor(baseUrl)).replace(
    /\/+$/,
    '',
  );
  const timeoutMs = options.timeoutMs ?? FIRMS_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const redact = (text: string): string => text.split(mapKey).join('<MAP_KEY>');

  /**
   * One GET, one CSV body, every failure redacted. `label` is what the operator sees —
   * the product, never the URL, because the URL is the key.
   */
  const fetchCsv = async (url: string, label: string): Promise<string> => {
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
        `FIRMS request failed for ${label}: ${redact(describe(error))}`,
        null,
      );
    }

    if (!httpResponse.ok) {
      const body = await readBodySafely(httpResponse);
      throw new FirmsHttpError(
        `FIRMS returned ${String(httpResponse.status)} for ${label}: ${redact(excerpt(body))}`,
        httpResponse.status,
      );
    }

    try {
      return await httpResponse.text();
    } catch (error) {
      throw new FirmsHttpError(
        `FIRMS response body was unreadable for ${label}: ${redact(describe(error))}`,
        httpResponse.status,
      );
    }
  };

  return {
    async fetchArea(query: FirmsAreaQuery): Promise<FirmsAreaResponse> {
      const csv = await fetchCsv(areaUrl(baseUrl, mapKey, query), query.product);

      // Read the clock only once the body is complete: `available_at` is when the rows
      // were in our hands, and on a slow transfer the gap is minutes, not milliseconds.
      return { csv, availableAt: options.clock.now() };
    },

    async fetchDataAvailability(query: FirmsAvailabilityQuery): Promise<FirmsAvailabilityResponse> {
      const csv = await fetchCsv(
        availabilityUrl(availabilityBaseUrl, mapKey, query.product),
        `${query.product} availability`,
      );

      return { csv, fetchedAt: options.clock.now() };
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

/** `.../data_availability/csv/<MAP_KEY>/<SOURCE>` — the key is a path segment here too. */
export function availabilityUrl(baseUrl: string, mapKey: string, product: string): string {
  if (product.trim() === '') {
    throw new RangeError('a data-availability query needs a product');
  }
  return `${baseUrl}/${[mapKey, product].map(encodePathSegment).join('/')}`;
}

/**
 * The availability endpoint that belongs to a given area endpoint.
 *
 * The two differ by one path segment, so a `baseUrl` override — a fake server in a test, a
 * mirror in an emergency — carries over instead of silently splitting the client across two
 * hosts. A `baseUrl` that is not an area endpoint gets the documented default, because
 * guessing a second endpoint out of an unrecognised URL is how a poller ends up asking
 * something arbitrary for its health.
 */
function availabilityBaseFor(baseUrl: string): string {
  return baseUrl.endsWith('/area/csv')
    ? `${baseUrl.slice(0, -'/area/csv'.length)}/data_availability/csv`
    : FIRMS_AVAILABILITY_BASE_URL;
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
