/**
 * The GWIS point query as the FWI forecast lookup sees it (V2-B1).
 *
 * Value-style like the EFFIS client: GWIS not answering is routine, so a failure is a
 * value. The query is rendered in core (`gwisPointQuery`); the adapter owns the URL and
 * only serializes it, and it never judges the body — the parser in core does.
 */

export interface FwiPointRequest {
  /** The full GetFeatureInfo query as ordered pairs. */
  readonly query: Readonly<Record<string, string>>;
}

export interface FwiPointFetch {
  /** The body of a 200 (possibly empty), or `null` when the request failed. */
  readonly body: string | null;
  /** `null` exactly when `body` is not. */
  readonly error: string | null;
}

export interface FwiPointClient {
  fetchPoint(request: FwiPointRequest): Promise<FwiPointFetch>;
}
