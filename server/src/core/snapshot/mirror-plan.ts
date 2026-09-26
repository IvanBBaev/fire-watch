/**
 * The exact object the T2 static mirror holds (TASKS E3; ADR-003 D1, A1.2, A1.4).
 *
 * **What the web T2 reader needs, and nothing else.** On T2 the client fetches one URL —
 * `static_snapshot_url` — as a full snapshot, revalidates it with `If-None-Match`, and
 * parses it with the same `parseSnapshot` it uses for `/api/v1/snapshot.json`. There is no
 * manifest, no pointer and no second object, so the mirror is one object: the snapshot
 * document the API serves, serialised the way the API serialises it (`JSON.stringify`,
 * which is what Fastify's `send` does with an object), built by the same builder from the
 * same projection with no wall-clock filter (A1.4).
 *
 * **Why one PUT is safe to read mid-upload.** An S3/R2 PUT replaces an object atomically:
 * a reader gets the previous version or the new one, whole. With a single object there is
 * no ordering to get wrong. If a second object is ever added (a mirrored freshness report,
 * a manifest), the rule is data first, pointer last — never the other way round.
 *
 * **Where the age comes from.** The client's staleness clock reads the body's
 * `generated_at` and nothing else (the F4 lesson: a CDN 304 must not re-anchor it). So the
 * job stamps `generated_at` with its own clock at the moment it read the projection, and
 * it re-PUTs every cycle even when `max_seq` has not moved — a skipped upload would freeze
 * `generated_at` and turn a quiet day into a false T2 staleness flag. The same instant is
 * written as `x-amz-meta-generated-at`, so the age monitor can read it with a HEAD. Nothing
 * here derives age from `Date`, `Age` or the time a cache last revalidated.
 *
 * **Cache-Control.** `public, max-age=0, s-maxage=30`:
 *   * `max-age=0` — a browser always revalidates, so a client never trusts its own copy
 *     past the next poll; the 304 path is cheap and, since the F4 fix, age-honest.
 *   * `s-maxage=30` — the edge in front of the public hostname may hold the object for 30 s.
 *     Worst-case age a client can see is then push cadence (60 s) + push duration + 30 s,
 *     about 1.5 min, well inside the 5 min T2 bound (`staticFlipStaleMs`, D1).
 *   * no `stale-while-revalidate` / `stale-if-error` — either would let the edge serve an
 *     object past that arithmetic, and T2 is the tier with nothing behind it.
 */

import type { ObjectToStore } from '../ports/object-store.js';
import type { SnapshotDocument } from './snapshot-builder.js';

export const MIRROR_CACHE_CONTROL = 'public, max-age=0, s-maxage=30';

/** What Fastify sends for an object body; the mirror must not differ from the API. */
export const MIRROR_CONTENT_TYPE = 'application/json; charset=utf-8';

export const DEFAULT_MIRROR_OBJECT_KEY = 'snapshot.json';

/** Metadata names, served back by the bucket as `x-amz-meta-<name>`. */
export const MIRROR_META_GENERATED_AT = 'generated-at';
export const MIRROR_META_MAX_SEQ = 'max-seq';
export const MIRROR_META_SCHEMA_VERSION = 'schema-version';

/**
 * A key a public URL can carry without escaping surprises: path segments of
 * `[A-Za-z0-9._-]`, no leading or trailing slash, no empty, `.` or `..` segment.
 */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function isValidMirrorKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  return key
    .split('/')
    .every((segment) => SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..');
}

/** The one object to PUT for this document. Pure: same document, same object. */
export function planMirrorObject(document: SnapshotDocument, key: string): ObjectToStore {
  if (!isValidMirrorKey(key)) {
    throw new RangeError(`mirror object key ${JSON.stringify(key)} is not a safe path`);
  }
  if (document.partial) {
    // A partial document is an upsert batch (A1.5); served as T2 it would read as the whole
    // set and silently drop every fire not in the batch.
    throw new RangeError('refusing to mirror a partial snapshot');
  }
  return {
    key,
    body: JSON.stringify(document),
    contentType: MIRROR_CONTENT_TYPE,
    cacheControl: MIRROR_CACHE_CONTROL,
    metadata: {
      // Verbatim: the builder already renders it through `isoFromEpochMs`, and a header that
      // differed from the body by even a rounding step would be a second clock.
      [MIRROR_META_GENERATED_AT]: document.generated_at,
      [MIRROR_META_MAX_SEQ]: String(document.max_seq),
      [MIRROR_META_SCHEMA_VERSION]: String(document.schema_version),
    },
  };
}
