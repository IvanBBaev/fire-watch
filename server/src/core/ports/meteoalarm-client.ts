/**
 * Reads MeteoAlarm's national Atom feeds and the CAP alerts they link (V2-B3;
 * DATA-SOURCES-EXTENDED §J11).
 *
 * Value-style like the other upstream clients: nothing is thrown. A feed request carries
 * the validators of the previous answer, so a server that honours them answers 304 and
 * the refresh job reuses what it already parsed. (MeteoAlarm sent neither `ETag` nor
 * `Last-Modified` when checked on 2026-10-24; the validators cost nothing and start
 * working the day it does.)
 */

export interface FeedValidators {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export type MeteoalarmFeedFetch =
  | { readonly kind: 'ok'; readonly body: string; readonly validators: FeedValidators }
  | { readonly kind: 'not-modified' }
  /** `status` is `null` when no response arrived at all. Public-safe: no header. */
  | { readonly kind: 'failed'; readonly status: number | null; readonly error: string };

export interface MeteoalarmCapFetch {
  readonly body: string | null;
  /** `null` exactly when `body` is not. */
  readonly error: string | null;
}

export interface MeteoalarmClient {
  /** One national legacy Atom feed by MeteoAlarm's country slug. */
  fetchFeed(slug: string, validators: FeedValidators | null): Promise<MeteoalarmFeedFetch>;
  /** One CAP alert; the caller has already checked the URL is MeteoAlarm's. */
  fetchCap(url: string): Promise<MeteoalarmCapFetch>;
}
