/**
 * The {@link PublicObjectProbe} port: one unauthenticated HEAD of the T2 object over the
 * public hostname clients flip to (TASKS E3, A1.2).
 *
 * No credentials, no cache-busting query, no `Cache-Control: no-cache` — the point is to
 * see what a client would be served right now, edge cache included. Only headers the job
 * wrote or the store set at write time are read for age (`x-amz-meta-generated-at`,
 * `Last-Modified`); `Date` and `Age` are ignored on purpose (see `core/snapshot/mirror-age.ts`).
 */

import { epochMsFromIso } from '../../core/ports/clock.js';
import type { PublicObjectObservation, PublicObjectProbe } from '../../core/ports/object-store.js';
import { MIRROR_META_GENERATED_AT } from '../../core/snapshot/mirror-plan.js';
import { parseHttpDate } from './r2-object-store.js';

export const PUBLIC_PROBE_TIMEOUT_MS = 10_000;

export interface PublicObjectProbeOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createPublicObjectProbe(options: PublicObjectProbeOptions): PublicObjectProbe {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PUBLIC_PROBE_TIMEOUT_MS;
  return {
    async head(): Promise<PublicObjectObservation> {
      let response: Response;
      try {
        response = await doFetch(options.url, {
          method: 'HEAD',
          // A redirect means the hostname is not bound the way A1.2 requires.
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { kind: 'unreachable', reason: describeNetworkError(error) };
      }
      if (response.status === 404 || response.status === 410) {
        return { kind: 'missing', status: response.status };
      }
      if (!response.ok) {
        return { kind: 'unreachable', reason: `HTTP ${String(response.status)}` };
      }
      return {
        kind: 'present',
        status: response.status,
        generatedAtMs: parseIso(response.headers.get(`x-amz-meta-${MIRROR_META_GENERATED_AT}`)),
        lastModifiedMs: parseHttpDate(response.headers.get('last-modified')),
        etag: response.headers.get('etag'),
        cacheControl: response.headers.get('cache-control'),
      };
    },
  };
}

function parseIso(value: string | null): number | null {
  if (value === null) return null;
  try {
    return epochMsFromIso(value.trim());
  } catch {
    return null;
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'timed out' : `${error.name}: ${error.message}`;
  }
  return String(error);
}
