/**
 * Who a request is from, for the purposes of a per-client cap: the probe surface's rate
 * limiter and the stream's connection cap must agree on it, or a client could be under
 * one cap and over the other for the same traffic.
 */

import type { FastifyRequest } from 'fastify';

/**
 * Longer than any textual IP, v6 zones included. A key is an identity, not storage: an
 * edge header stuffed with garbage must not mint kilobyte-sized keys.
 */
export const MAX_CLIENT_KEY_LENGTH = 64;

/**
 * The edge-owned header when it is configured and present, the socket address otherwise.
 * The fallback keeps loopback traffic — the supervisor's probe, a curl over SSH — keyed
 * sanely on a box where the header is configured but the request never went through the
 * edge. See `HealthServerDeps.clientIpHeader` for why the header can be believed at all.
 */
export function clientKey(request: FastifyRequest, clientIpHeader: string | undefined): string {
  if (clientIpHeader !== undefined) {
    const raw = request.headers[clientIpHeader];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value !== undefined && value !== '') {
      return value.slice(0, MAX_CLIENT_KEY_LENGTH);
    }
  }
  return request.ip;
}
