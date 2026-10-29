/**
 * Where a FireSat detection document comes from (V3-A1).
 *
 * Same contract as the FIRMS area client: the poller builds the query, never a URL (an
 * access key, when there is one, stays inside the HTTP adapter), and a transport failure
 * is thrown so the poller can record it as a failed poll. Only the fixture client exists
 * today; the HTTP client is written on access day against the real endpoint.
 */

import type { FirmsAreaQuery } from '../../core/ports/firms-client.js';

export interface FiresatResponse {
  /** The document as delivered. */
  readonly body: string;
  /** When the response was in our hands (ADR-002 D1), never derived from `acq_ts`. */
  readonly availableAt: number;
}

export interface FiresatClient {
  fetchDetections(query: FirmsAreaQuery): Promise<FiresatResponse>;
}

/**
 * Serves one recorded document, as the golden replay and the tests drive the poller. The
 * `availableAt` is part of the fixture: latency is what several replays are about.
 */
export function fixtureFiresatClient(body: string, availableAt: number): FiresatClient {
  return {
    fetchDetections: () => Promise.resolve({ body, availableAt }),
  };
}
