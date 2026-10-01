/**
 * The `TleClient` port over HTTPS against CelesTrak's GP query (TASKS F15; DATA-SOURCES §F15).
 *
 * One request per satellite, `gp.php?CATNR=<norad>&FORMAT=JSON`: the current OMM for one
 * catalogue number, a few hundred bytes. No key, no registration.
 *
 * Redirects are **not followed** (`redirect: 'manual'`): CelesTrak's usage policy says
 * repeated 301s get a client's address blocked, so a 301 must reach the refresh job as the
 * non-200 it is — where it latches the halt — rather than be silently chased. A transport
 * failure (timeout, DNS, reset) is `status: null`, which the job does not latch on.
 *
 * Value-style like the other upstream clients: nothing is thrown.
 */

import type { Clock } from '../../core/ports/clock.js';
import type { TleClient, TleFetch } from '../../core/ports/tle-client.js';

export const CELESTRAK_BASE_URL = 'https://celestrak.org/NORAD/elements/gp.php';

export const CELESTRAK_TIMEOUT_MS = 30_000;

/** One OMM is under 1 KiB; anything this large is not the answer we asked for. */
export const CELESTRAK_MAX_BODY_BYTES = 64 * 1024;

const BODY_EXCERPT_CHARS = 200;

export interface CelestrakHttpClientOptions {
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so the test never opens a socket. */
  readonly fetch?: typeof globalThis.fetch;
}

export function celestrakGpUrl(baseUrl: string, noradId: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set('CATNR', String(noradId));
  url.searchParams.set('FORMAT', 'JSON');
  return url.toString();
}

export function createCelestrakHttpClient(options: CelestrakHttpClientOptions): TleClient {
  const baseUrl = options.baseUrl ?? CELESTRAK_BASE_URL;
  const timeoutMs = options.timeoutMs ?? CELESTRAK_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async fetchElements(noradId: number): Promise<TleFetch> {
      if (!Number.isSafeInteger(noradId) || noradId <= 0) {
        return noResponse(`invalid NORAD catalogue number ${String(noradId)}`);
      }
      let response: Response;
      try {
        response = await doFetch(celestrakGpUrl(baseUrl, noradId), {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual',
          headers: { accept: 'application/json' },
        });
      } catch (error) {
        return noResponse(
          `CelesTrak request failed for NORAD ${String(noradId)}: ${describe(error)}`,
        );
      }

      if (response.status !== 200) {
        const body = await readBodySafely(response);
        return {
          body: null,
          status: response.status,
          availableAt: null,
          error: `CelesTrak returned ${String(response.status)} for NORAD ${String(noradId)}: ${excerpt(body)}`,
        };
      }

      let bytes: ArrayBuffer;
      try {
        bytes = await response.arrayBuffer();
      } catch (error) {
        return noResponse(
          `CelesTrak body was unreadable for NORAD ${String(noradId)}: ${describe(error)}`,
        );
      }
      if (bytes.byteLength > CELESTRAK_MAX_BODY_BYTES) {
        // A 200 with a body we will not store: not a refusal from CelesTrak, so no latch —
        // the OMM gate would refuse it anyway, this only bounds what is held in memory.
        return noResponse(
          `CelesTrak body for NORAD ${String(noradId)} is ${String(bytes.byteLength)} bytes, over the cap`,
        );
      }
      return {
        body: new TextDecoder().decode(bytes),
        status: 200,
        availableAt: options.clock.now(),
        error: null,
      };
    },
  };
}

function noResponse(error: string): TleFetch {
  return { body: null, status: null, availableAt: null, error };
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
