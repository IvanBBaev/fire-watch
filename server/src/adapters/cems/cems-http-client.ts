/**
 * The `CemsClient` port over HTTPS against the Copernicus EMS Rapid Mapping dashboard API
 * (TASKS V2-E3; DATA-SOURCES §V2-E3).
 *
 * Two public, keyless endpoints, the ones the Rapid Mapping portal itself reads:
 *
 *   * `public-activations-info/?category=Wildfire&limit=&offset=` — one page of the
 *     wildfire activation list, newest first (about 17 KB for 50 entries);
 *   * `public-activations/?code=EMSRnnn` — one activation's detail, with its areas of
 *     interest. A restricted activation answers 403.
 *
 * Redirects are not followed: the API has never redirected, and a redirect to somewhere
 * else is not an answer we asked for. Value-style like the other upstream clients: nothing
 * is thrown.
 */

import type { CemsClient, CemsFetch } from '../../core/ports/cems-client.js';
import type { Clock } from '../../core/ports/clock.js';

export const CEMS_BASE_URL = 'https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api';

export const CEMS_TIMEOUT_MS = 30_000;

/** A list page is under 20 KB and a large detail under 100 KB; anything this large is not. */
export const CEMS_MAX_BODY_BYTES = 2 * 1024 * 1024;

const BODY_EXCERPT_CHARS = 200;
const CODE_RE = /^EMSR\d{3,4}$/;

export interface CemsHttpClientOptions {
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so the test never opens a socket. */
  readonly fetch?: typeof globalThis.fetch;
}

export function cemsListUrl(baseUrl: string, offset: number, limit: number): string {
  const url = new URL(`${baseUrl}/public-activations-info/`);
  url.searchParams.set('category', 'Wildfire');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  return url.toString();
}

export function cemsDetailUrl(baseUrl: string, code: string): string {
  const url = new URL(`${baseUrl}/public-activations/`);
  url.searchParams.set('code', code);
  return url.toString();
}

export function createCemsHttpClient(options: CemsHttpClientOptions): CemsClient {
  const baseUrl = options.baseUrl ?? CEMS_BASE_URL;
  const timeoutMs = options.timeoutMs ?? CEMS_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  async function get(url: string, what: string): Promise<CemsFetch> {
    let response: Response;
    try {
      response = await doFetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      return noResponse(`Copernicus EMS request failed for ${what}: ${describe(error)}`);
    }
    if (response.status !== 200) {
      const body = await readBodySafely(response);
      return {
        body: null,
        status: response.status,
        availableAt: null,
        error: `Copernicus EMS returned ${String(response.status)} for ${what}: ${excerpt(body)}`,
      };
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch (error) {
      return noResponse(`Copernicus EMS body was unreadable for ${what}: ${describe(error)}`);
    }
    if (bytes.byteLength > CEMS_MAX_BODY_BYTES) {
      return noResponse(
        `Copernicus EMS body for ${what} is ${String(bytes.byteLength)} bytes, over the cap`,
      );
    }
    return {
      body: new TextDecoder().decode(bytes),
      status: 200,
      availableAt: options.clock.now(),
      error: null,
    };
  }

  return {
    listActivations({ offset, limit }) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1
      ) {
        return Promise.resolve(
          noResponse(`invalid page offset ${String(offset)} limit ${String(limit)}`),
        );
      }
      return get(
        cemsListUrl(baseUrl, offset, limit),
        `the activation list at offset ${String(offset)}`,
      );
    },
    activationDetail(code) {
      if (!CODE_RE.test(code)) {
        return Promise.resolve(noResponse(`invalid activation code ${JSON.stringify(code)}`));
      }
      return get(cemsDetailUrl(baseUrl, code), code);
    },
  };
}

function noResponse(error: string): CemsFetch {
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
