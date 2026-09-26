/**
 * The `/snapshot.json` document, as a pure projection (ADR-003 D1, D2, D4, A1.3–A1.5).
 *
 * Everything the client is *forbidden* to compute is computed here from the stored rows:
 * the lifecycle state arrives decided, the score arrives as a bucket and never raw, the
 * place name is rendered, the timestamps are ISO UTC. Everything this module is forbidden
 * to compute is absent on purpose: there is no clock comparison anywhere below (A1.4 R1
 * — the active set is what the rows say it is), and the ETag is a function of one integer
 * the database bumped, not of the bytes we happened to serialize.
 *
 * The wire shape is a GeoJSON FeatureCollection with snake_case foreign members, the
 * shape `web/src/core/feed/parse-snapshot.ts` guards on the other side. `schema_version`
 * travels in the body (A1.3: `/snapshot.json` is outside the `/api/v1` prefix, so the
 * version cannot live in the path), and the same number is folded into the ETag so a
 * schema change can never validate against a cached representation of the old one.
 */

import type { Credit, LifecycleState, ScoreBucket } from '@fire-watch/contracts';
import { creditsFor, renderCredit, scoreBucket } from '@fire-watch/contracts';

import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type {
  ActiveEventRow,
  ActiveSetRead,
  SourceObservationRow,
} from '../ports/snapshot-reader.js';

/**
 * Bumped only with a change the web parser would reject; folded into every ETag.
 *
 * History: 1 — first wire shape (E1). 2 — `properties.uuid` removed (2026-09-26): it was a
 * byte-for-byte duplicate of the public id, kept only because the web store keyed on it.
 * A v1 parser requires `uuid`, so a v1 bundle would reject a v2 body; the bump moves the
 * ETag so no cache can validate a v1 representation against a v2 client or vice versa.
 */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/** The product name the licence strings' `[Product]` placeholder resolves to. */
export const PRODUCT_NAME = 'Fire Watch';

/**
 * The properties of one event feature, as both tiers serve it. `M` is the type of
 * `merged_into`: `null` in a snapshot, whose active set contains no tombstones, and
 * `string | null` on the stream, which is exactly where a client learns of a merge.
 */
export interface EventFeaturePropertiesOf<M extends string | null> {
  /**
   * The public id — MapLibre feature-state (`promoteId: 'id'`) and the client store key.
   * Equal to the feature-level `id`; there is no second identifier on the wire.
   */
  readonly id: string;
  readonly seq: number;
  readonly status: LifecycleState;
  readonly score_bucket: ScoreBucket;
  /** The survivor's public id when this event was merged into another; the tombstone. */
  readonly merged_into: M;
  readonly first_observed_at: string;
  readonly last_observed_at: string;
  readonly detection_count: number;
  readonly place_name_bg: string;
  readonly place_name_en: string;
  /** Null until a burned-area source is attributed to events; nothing publishes one yet. */
  readonly area_ha: null;
  /** Null until the pass predictor is wired into the read path; renders "unknown". */
  readonly next_pass_window: null;
}

export interface EventFeatureOf<M extends string | null> {
  readonly type: 'Feature';
  readonly id: string;
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
  readonly properties: EventFeaturePropertiesOf<M>;
}

/** A feature as the stream serves it: possibly a tombstone (ADR-003 D3 rule 2). */
export type EventFeature = EventFeatureOf<string | null>;

/** A feature as the snapshot serves it: never a tombstone (the active set has none). */
export type SnapshotFeatureProperties = EventFeaturePropertiesOf<null>;
export type SnapshotFeature = EventFeatureOf<null>;

export interface SnapshotSource {
  readonly source_id: string;
  readonly last_observed_at: string | null;
}

/** One verbatim licence string the payload's data is owed to (A1.3, credits registry). */
export interface SnapshotAttribution {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly href?: string;
}

export interface SnapshotDocument {
  readonly type: 'FeatureCollection';
  readonly schema_version: number;
  readonly generated_at: string;
  /** The global seq high-water mark the ETag is derived from (A1.4). */
  readonly max_seq: number;
  /** True for a `?updated_after_seq` response: an upsert batch, never authoritative on the set (A1.5). */
  readonly partial: boolean;
  readonly features: readonly SnapshotFeature[];
  readonly sources: readonly SnapshotSource[];
  readonly attribution: readonly SnapshotAttribution[];
}

export interface SnapshotInput {
  readonly read: ActiveSetRead;
  readonly sources: readonly SourceObservationRow[];
  /** The `generated_at` instant — what the caller's clock says, never `Date.now()` here. */
  readonly generatedAtMs: EpochMs;
  /** The cursor the read was taken with; anything above zero makes the document partial. */
  readonly afterSeq: number;
}

export function buildSnapshot(input: SnapshotInput): SnapshotDocument {
  return {
    type: 'FeatureCollection',
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    generated_at: isoFromEpochMs(input.generatedAtMs),
    max_seq: input.read.maxSeq,
    partial: input.afterSeq > 0,
    features: input.read.events.map(toFeature),
    sources: input.sources.map(snapshotSource),
    attribution: attributionFor(input.generatedAtMs),
  };
}

/** The per-source freshness line (D2), shared by the snapshot and the stream's `freshness` frame. */
export function snapshotSource(row: SourceObservationRow): SnapshotSource {
  return {
    source_id: row.sourceId,
    last_observed_at: row.lastObservedAt === null ? null : isoFromEpochMs(row.lastObservedAt),
  };
}

/**
 * The strong validator for a snapshot representation (A1.3, A1.4): the schema version and
 * the global max seq, nothing else. Two responses with the same max seq are the same set
 * — R1 guarantees it — so a client holding this value can be told "unchanged" without
 * the server building the body.
 */
export function snapshotEtag(maxSeq: number): string {
  if (!Number.isSafeInteger(maxSeq) || maxSeq < 0) {
    throw new RangeError(`max seq must be a non-negative safe integer, got ${String(maxSeq)}`);
  }
  return `"v${String(SNAPSHOT_SCHEMA_VERSION)}-${String(maxSeq)}"`;
}

/**
 * The licence strings owed by a data payload, rendered with the year of `generated_at`.
 * The registry decides which credits carry the `api` surface; this only renders them.
 */
export function attributionFor(generatedAtMs: EpochMs): readonly SnapshotAttribution[] {
  const context = { year: new Date(generatedAtMs).getUTCFullYear(), productName: PRODUCT_NAME };
  return creditsFor('api', []).map((credit: Credit) => ({
    id: credit.id,
    source: credit.source,
    text: renderCredit(credit, context),
    ...(credit.href === undefined ? {} : { href: credit.href }),
  }));
}

function toFeature(row: ActiveEventRow): SnapshotFeature {
  return eventFeature(row, null);
}

/**
 * One stored row as a GeoJSON feature — the projection both tiers share, so a delta and
 * a snapshot member are the same bytes for the same row (D3 rule 2 relies on it).
 */
export function eventFeature<M extends string | null>(
  row: ActiveEventRow,
  mergedInto: M,
): EventFeatureOf<M> {
  return {
    type: 'Feature',
    id: row.publicId,
    geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
    properties: {
      id: row.publicId,
      seq: row.seq,
      status: row.status,
      score_bucket: scoreBucket(row.score),
      merged_into: mergedInto,
      first_observed_at: isoFromEpochMs(row.startedAt),
      last_observed_at: isoFromEpochMs(row.lastDetectionAt),
      detection_count: row.detectionCount,
      place_name_bg: row.nearestPlace?.name_bg ?? '',
      place_name_en: row.nearestPlace?.name_en ?? '',
      area_ha: null,
      next_pass_window: null,
    },
  };
}
