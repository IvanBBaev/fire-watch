/**
 * FIRMS without a MAP_KEY: the public NRT "active fire" regional files.
 *
 * NASA publishes a rolling CSV per sensor and region that anyone can download:
 *
 *   https://firms.modaps.eosdis.nasa.gov/data/active_fire/<sensor-dir>/csv/<FILE>_Europe_24h.csv
 *
 * The columns are the Area API's (`latitude,longitude,bright_ti4,…,daynight`), with one
 * spelling difference: VIIRS `confidence` is written out (`low`/`nominal`/`high`) where
 * the Area API — and therefore the parser — uses `l`/`n`/`h`. The adapter maps the words
 * back to the letters; anything else is passed through for the parser to reject. The
 * other difference is the *selection*, and this adapter re-creates the Area API's
 * selection so the core cannot tell the two apart:
 *
 *  - **Area.** The file covers all of Europe. Rows outside `query.area` are dropped here,
 *    exactly as the Area API would never have returned them. A row whose coordinates do
 *    not parse is *kept*: it is the parser's and the validator's job to reject and
 *    quarantine it, and silently dropping it here would hide a malformed upstream file.
 *  - **Day range.** Despite its name the "24h" file starts at 00:00 UTC of the previous
 *    day, so it spans up to ~48 h. The Area API's `day_range` counts UTC calendar days
 *    ending today (DATA-SOURCES §A1.1 pitfall 2); rows acquired before that window are
 *    dropped here, so the validator's `acquired_before_window` check never sees them.
 *  - **No backfill.** The file is only the recent past. A query with `startDate` is a
 *    backfill, and it is refused rather than answered with the wrong days.
 *
 * Conditional GET: every request carries `If-None-Match` / `If-Modified-Since` from the
 * last response. At the time of writing the FIRMS file server (nginx + object store)
 * ignores both and answers 200 with the full body, so an unchanged file is also detected
 * by an identical `ETag`. Either way the cached body is re-clipped and returned: the poll
 * *succeeded*, every row is already archived and lands as a no-op (pitfall 3), and
 * freshness stays honest because `last_data_at` only moves when new rows land.
 *
 * Same error discipline as the Area API client: no retry, `redirect: 'error'`, a timeout,
 * and a failed fetch is a failed poll recorded by the cycle. There is no key to redact.
 *
 * The files trail the Area API by the file-regeneration cadence (observed: minutes to an
 * hour), and there is no data-availability endpoint, so `fetchDataAvailability` is omitted
 * and the cycle reports upstream state as unchecked.
 */

import type { SourceId } from '@fire-watch/contracts';

import { parseCsvLine } from '../../core/ingest/firms-csv.js';
import type { Clock } from '../../core/ports/clock.js';
import type {
  FirmsAreaClient,
  FirmsAreaQuery,
  FirmsAreaResponse,
} from '../../core/ports/firms-client.js';
import { FIRMS_TIMEOUT_MS, FirmsHttpError } from './firms-http-client.js';

export const FIRMS_KEYLESS_BASE_URL = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire';

/** The regional file for each source, relative to the base URL. Europe covers the bbox. */
export const FIRMS_KEYLESS_FILES: Readonly<Partial<Record<SourceId, string>>> = {
  'firms:viirs:snpp': 'suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_24h.csv',
  'firms:viirs:noaa20': 'noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_24h.csv',
  'firms:viirs:noaa21': 'noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_24h.csv',
  'firms:modis': 'modis-c6.1/csv/MODIS_C6_1_Europe_24h.csv',
};

const DAY_MS = 86_400_000;

/** The keyless files spell VIIRS confidence out; the Area API and the parser use letters. */
const CONFIDENCE_LETTERS: Readonly<Record<string, string>> = {
  low: 'l',
  nominal: 'n',
  high: 'h',
};
const BODY_EXCERPT_CHARS = 200;

export interface FirmsKeylessClientOptions {
  /** Stamps `available_at`, and anchors the day-range window. */
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so the test never opens a socket. */
  readonly fetch?: typeof globalThis.fetch;
}

interface CachedFile {
  readonly body: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export function createFirmsKeylessClient(options: FirmsKeylessClientOptions): FirmsAreaClient {
  const baseUrl = (options.baseUrl ?? FIRMS_KEYLESS_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? FIRMS_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const cache = new Map<string, CachedFile>();

  const fetchFile = async (url: string, label: string): Promise<string> => {
    const cached = cache.get(url);
    const headers: Record<string, string> = { accept: 'text/csv' };
    if (cached?.etag != null) headers['if-none-match'] = cached.etag;
    if (cached?.lastModified != null) headers['if-modified-since'] = cached.lastModified;

    let httpResponse: Response;
    try {
      httpResponse = await doFetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new FirmsHttpError(
        `FIRMS keyless request failed for ${label}: ${describe(error)}`,
        null,
      );
    }

    if (httpResponse.status === 304 && cached !== undefined) {
      return cached.body;
    }

    if (!httpResponse.ok) {
      const body = await readBodySafely(httpResponse);
      throw new FirmsHttpError(
        `FIRMS keyless file returned ${String(httpResponse.status)} for ${label}: ${excerpt(body)}`,
        httpResponse.status,
      );
    }

    const etag = httpResponse.headers.get('etag');
    const lastModified = httpResponse.headers.get('last-modified');
    // The server ignores conditional headers today; an identical ETag is the same file.
    if (cached !== undefined && etag !== null && etag === cached.etag) {
      await httpResponse.body?.cancel().catch(() => undefined);
      return cached.body;
    }

    let body: string;
    try {
      body = await httpResponse.text();
    } catch (error) {
      throw new FirmsHttpError(
        `FIRMS keyless file body was unreadable for ${label}: ${describe(error)}`,
        httpResponse.status,
      );
    }
    cache.set(url, { body, etag, lastModified });
    return body;
  };

  return {
    async fetchArea(query: FirmsAreaQuery): Promise<FirmsAreaResponse> {
      if (query.startDate !== undefined) {
        throw new FirmsHttpError(
          `FIRMS keyless mode cannot serve a backfill (startDate ${query.startDate}); ` +
            'the public files only hold the last ~48 h — use FIRE_WATCH_FIRMS_MODE=area',
          null,
        );
      }
      const url = keylessFileUrl(baseUrl, query.source);
      const body = await fetchFile(url, query.product);
      const availableAt = options.clock.now();
      const csv = clipKeylessCsv(body, parseArea(query.area), dayWindowStart(availableAt, query));
      return { csv, availableAt };
    },
  };
}

export function keylessFileUrl(baseUrl: string, source: SourceId): string {
  const file = FIRMS_KEYLESS_FILES[source];
  if (file === undefined) {
    throw new FirmsHttpError(`FIRMS keyless mode has no public file for ${source}`, null);
  }
  return `${baseUrl}/${file}`;
}

interface Area {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

function parseArea(area: string): Area {
  const parts = area.split(',').map(Number);
  const [west, south, east, north] = parts;
  if (
    parts.length !== 4 ||
    west === undefined ||
    south === undefined ||
    east === undefined ||
    north === undefined ||
    !parts.every(Number.isFinite)
  ) {
    throw new RangeError(`area must be "west,south,east,north", got "${area}"`);
  }
  return { west, south, east, north };
}

/** `YYYY-MM-DD` of the first UTC calendar day the Area API would include. */
function dayWindowStart(now: number, query: FirmsAreaQuery): string {
  if (!Number.isInteger(query.dayRange) || query.dayRange < 1 || query.dayRange > 10) {
    throw new RangeError(`day_range must be an integer in 1..10, got ${String(query.dayRange)}`);
  }
  const startOfToday = Math.floor(now / DAY_MS) * DAY_MS;
  return new Date(startOfToday - (query.dayRange - 1) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Keeps the header and every data row inside `area` (inclusive) acquired on or after
 * `firstDay`, with spelled-out confidence mapped to the Area API's letters. Rows whose
 * coordinates or date cannot be read are kept for the parser to reject. A body without
 * the expected columns is returned unchanged, so the parser's missing-column error — not
 * an empty batch — is what the operator sees.
 */
export function clipKeylessCsv(body: string, area: Area, firstDay: string): string {
  const lines = body.split(/\r?\n/);
  const header = lines[0] ?? '';
  const columns = parseCsvLine(header).map((name) => name.trim().toLowerCase());
  const latIndex = columns.indexOf('latitude');
  const lonIndex = columns.indexOf('longitude');
  const dateIndex = columns.indexOf('acq_date');
  const confidenceIndex = columns.indexOf('confidence');
  if (latIndex < 0 || lonIndex < 0 || dateIndex < 0) return body;

  const kept = [header];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    const cells = parseCsvLine(line);
    const lat = Number(cells[latIndex]);
    const lon = Number(cells[lonIndex]);
    const date = (cells[dateIndex] ?? '').trim();
    const readable =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      (cells[latIndex] ?? '').trim() !== '' &&
      (cells[lonIndex] ?? '').trim() !== '' &&
      /^\d{4}-\d{2}-\d{2}$/.test(date);
    if (!readable) {
      kept.push(line);
      continue;
    }
    const inside = lon >= area.west && lon <= area.east && lat >= area.south && lat <= area.north;
    if (inside && date >= firstDay) kept.push(withConfidenceLetter(line, cells, confidenceIndex));
  }
  return `${kept.join('\n')}\n`;
}

function withConfidenceLetter(line: string, cells: readonly string[], index: number): string {
  const letter = index < 0 ? undefined : CONFIDENCE_LETTERS[(cells[index] ?? '').trim()];
  // Only unquoted lines are rewritten; FIRMS never quotes, and a quoted one goes to the
  // parser as-is rather than being re-serialized by guesswork.
  if (letter === undefined || line.includes('"')) return line;
  return cells.map((cell, i) => (i === index ? letter : cell)).join(',');
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
