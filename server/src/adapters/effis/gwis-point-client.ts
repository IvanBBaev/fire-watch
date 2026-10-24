/**
 * The `FwiPointClient` port over HTTP (V2-B1): GWIS `GetFeatureInfo` on `ecmwf.query`.
 *
 * Same wire discipline as the EFFIS client — injected fetch, hard timeout, no redirects,
 * value-style failures — with a short timeout, because a reader is waiting on this one,
 * and a body cap, because the honest answer is half a kilobyte of HTML.
 */

import type {
  FwiPointClient,
  FwiPointFetch,
  FwiPointRequest,
} from '../../core/ports/fwi-point-client.js';
import { GWIS_BASE_URL } from './effis-http-client.js';

/** A reader is waiting; GWIS answers a point in well under a second on a normal day. */
export const GWIS_POINT_TIMEOUT_MS = 8_000;

/** The real answer is ~550 bytes; anything past this is not the table we parse. */
export const GWIS_POINT_MAX_BODY_BYTES = 16_384;

export interface GwisPointClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function createGwisPointClient(options: GwisPointClientOptions = {}): FwiPointClient {
  const baseUrl = (options.baseUrl ?? GWIS_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? GWIS_POINT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async fetchPoint(request: FwiPointRequest): Promise<FwiPointFetch> {
      const url = `${baseUrl}?${new URLSearchParams(request.query).toString()}`;
      let response: Response;
      try {
        response = await doFetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch (error) {
        return { body: null, error: `GWIS point request failed: ${describe(error)}` };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { body: null, error: `GWIS point request returned ${String(response.status)}` };
      }
      let buffer: ArrayBuffer;
      try {
        buffer = await response.arrayBuffer();
      } catch (error) {
        return { body: null, error: `GWIS point body was unreadable: ${describe(error)}` };
      }
      if (buffer.byteLength > GWIS_POINT_MAX_BODY_BYTES) {
        return { body: null, error: 'GWIS point body exceeded the size cap' };
      }
      return { body: new TextDecoder('utf-8').decode(buffer), error: null };
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
