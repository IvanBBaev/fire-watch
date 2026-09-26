/**
 * The `WeatherClient` port over HTTPS against ECMWF Open Data (TASKS C4; A19;
 * DATA-SOURCES §D2).
 *
 * ECMWF publishes each run as one large GRIB2 file per step plus a `.index` sidecar, on
 * plain HTTPS with no registration. The two operations here map onto that directly: GET
 * the index as text, and Range-request one field's byte extent out of the data file.
 *
 * The Range handling is deliberately strict. A server that ignores `Range` answers 200
 * with the *whole* multi-hundred-megabyte file; treating that as success would slowly
 * fill the disk with bodies we never asked for. So anything but a 206 with exactly the
 * requested byte count is a failure value — and on a 200 the body stream is cancelled
 * rather than drained.
 *
 * Value-style like the EFFIS client: a provider hiccup is recorded, never thrown, and
 * the next scheduled refresh is the retry.
 */

import type { Clock } from '../../core/ports/clock.js';
import type {
  ByteRange,
  ForecastCycleRef,
  WeatherClient,
  WeatherIndexFetch,
  WeatherRangeFetch,
} from '../../core/ports/weather-client.js';

/** The open dissemination root (DATA-SOURCES §D2); no key, no registration. */
export const ECMWF_BASE_URL = 'https://data.ecmwf.int/forecasts';

/** Indexes are small but the host can be slow near publication time. */
export const ECMWF_TIMEOUT_MS = 120_000;

const BODY_EXCERPT_CHARS = 200;

export interface EcmwfHttpClientOptions {
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so the test never opens a socket. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * `<base>/20260813/06z/ifs/0p25/oper/20260813060000-0h-oper-fc.index` — the documented
 * open-data layout: date, cycle, model, resolution, stream, then the per-step file.
 */
export function ecmwfFileUrl(
  baseUrl: string,
  cycle: ForecastCycleRef,
  step: number,
  extension: 'index' | 'grib2',
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const hh = String(cycle.hour).padStart(2, '0');
  return (
    `${base}/${cycle.dateYmd}/${hh}z/ifs/0p25/oper/` +
    `${cycle.dateYmd}${hh}0000-${String(step)}h-oper-fc.${extension}`
  );
}

export function createEcmwfHttpClient(options: EcmwfHttpClientOptions): WeatherClient {
  const baseUrl = options.baseUrl ?? ECMWF_BASE_URL;
  const timeoutMs = options.timeoutMs ?? ECMWF_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async fetchIndex(cycle: ForecastCycleRef, step: number): Promise<WeatherIndexFetch> {
      const url = ecmwfFileUrl(baseUrl, cycle, step, 'index');
      const label = `${cycle.dateYmd}/${String(cycle.hour)}z step ${String(step)}`;

      let httpResponse: Response;
      try {
        httpResponse = await doFetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch (error) {
        return {
          text: null,
          availableAt: null,
          error: `ECMWF index request failed for ${label}: ${describe(error)}`,
        };
      }

      if (!httpResponse.ok) {
        const body = await readBodySafely(httpResponse);
        return {
          text: null,
          availableAt: null,
          error: `ECMWF returned ${String(httpResponse.status)} for index ${label}: ${excerpt(body)}`,
        };
      }

      let text: string;
      try {
        text = await httpResponse.text();
      } catch (error) {
        return {
          text: null,
          availableAt: null,
          error: `ECMWF index body was unreadable for ${label}: ${describe(error)}`,
        };
      }

      return { text, availableAt: options.clock.now(), error: null };
    },

    async fetchRange(
      cycle: ForecastCycleRef,
      step: number,
      range: ByteRange,
    ): Promise<WeatherRangeFetch> {
      const label = `${cycle.dateYmd}/${String(cycle.hour)}z step ${String(step)}`;
      if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
        return failure(`invalid range offset ${String(range.offset)} for ${label}`);
      }
      if (!Number.isSafeInteger(range.length) || range.length <= 0) {
        return failure(`invalid range length ${String(range.length)} for ${label}`);
      }

      const url = ecmwfFileUrl(baseUrl, cycle, step, 'grib2');
      let httpResponse: Response;
      try {
        httpResponse = await doFetch(url, {
          headers: {
            range: `bytes=${String(range.offset)}-${String(range.offset + range.length - 1)}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch (error) {
        return failure(`ECMWF range request failed for ${label}: ${describe(error)}`);
      }

      if (httpResponse.status !== 206) {
        // A 200 means the server ignored the range and is sending the whole run file.
        // Do not drain it — cancel the stream and record the refusal.
        try {
          await httpResponse.body?.cancel();
        } catch {
          // Cancelling a stream the server already closed can itself throw; irrelevant.
        }
        return failure(
          httpResponse.status === 200
            ? `ECMWF ignored the range request for ${label} (answered 200, not 206)`
            : `ECMWF returned ${String(httpResponse.status)} for range on ${label}`,
        );
      }

      let buffer: ArrayBuffer;
      try {
        buffer = await httpResponse.arrayBuffer();
      } catch (error) {
        return failure(`ECMWF range body was unreadable for ${label}: ${describe(error)}`);
      }

      if (buffer.byteLength !== range.length) {
        return failure(
          `ECMWF range for ${label} was truncated: asked for ${String(range.length)} bytes, ` +
            `got ${String(buffer.byteLength)}`,
        );
      }

      return { bytes: new Uint8Array(buffer), availableAt: options.clock.now(), error: null };
    },
  };
}

function failure(error: string): WeatherRangeFetch {
  return { bytes: null, availableAt: null, error };
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
