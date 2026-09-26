/**
 * The two ways the core touches the R2 static mirror (TASKS E3; ADR-003 D1 tier T2, A1.2).
 *
 * {@link ObjectStore} is the write side: an S3-compatible bucket reached with credentials,
 * over the storage API endpoint. {@link PublicObjectProbe} is the read side, and it is
 * deliberately a different port: it asks the *public* hostname — the one clients flip to —
 * what it is serving right now, with no credentials and no knowledge of the bucket. A T2
 * that the uploader believes is fresh but the public hostname serves stale (a mis-bound
 * domain, an edge cache that ignores Cache-Control) is exactly the failure A1.2's "own
 * liveness check, independent of origin health" exists to catch, so the monitor must not
 * be able to take the uploader's word for it.
 */

import type { EpochMs } from './clock.js';

/** One object as it is written. Every field is part of what a reader sees. */
export interface ObjectToStore {
  /** Bucket-relative key, no leading slash. */
  readonly key: string;
  /** The exact bytes, as UTF-8 text. */
  readonly body: string;
  readonly contentType: string;
  readonly cacheControl: string;
  /**
   * User metadata, stored as `x-amz-meta-<name>` and served back by the bucket on GET and
   * HEAD. Names are lower-case `[a-z0-9-]`; values are printable ASCII.
   */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface StoredObjectHead {
  /** The store's ETag, verbatim (quoted). */
  readonly etag: string | null;
  readonly contentLength: number | null;
  /** Set by the store at write time, second precision. */
  readonly lastModifiedMs: EpochMs | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ObjectStore {
  /**
   * One atomic PUT: a concurrent reader sees the previous object or this one, whole, never
   * a mixture. Throws on any non-2xx answer; the message never carries a credential.
   */
  put(object: ObjectToStore): Promise<{ readonly etag: string | null }>;
  /** `null` when the key does not exist. Throws on any other non-2xx answer. */
  head(key: string): Promise<StoredObjectHead | null>;
}

/** What the public hostname answered to a HEAD of the mirrored object. */
export type PublicObjectObservation =
  | {
      readonly kind: 'present';
      readonly status: number;
      /** From the job-written `x-amz-meta-generated-at` header, when the hostname echoes it. */
      readonly generatedAtMs: EpochMs | null;
      /** From `Last-Modified` — the store's write time, carried with the cached object. */
      readonly lastModifiedMs: EpochMs | null;
      readonly etag: string | null;
      readonly cacheControl: string | null;
    }
  | { readonly kind: 'missing'; readonly status: number }
  | { readonly kind: 'unreachable'; readonly reason: string };

export interface PublicObjectProbe {
  /** Never throws: a network failure is an observation, not an exception. */
  head(): Promise<PublicObjectObservation>;
}
