/**
 * Decoding `fire_events` rows as `pg` hands them over, shared by the two read-path
 * adapters (`pg-snapshot-reader`, `pg-change-reader`).
 *
 * Every value is checked: `bigint` arrives as a decimal string, `timestamptz` as a `Date`,
 * `jsonb` as whatever was stored. A row that fails a check throws — the message names the
 * column, never the value, because it ends up in a process log.
 */

import { isLifecycleState } from '@fire-watch/contracts';

import type { ActiveEventRow, NearestPlace } from '../../core/ports/snapshot-reader.js';
import {
  STATIC_SOURCE_VERDICTS,
  type StaticSourceVerdict,
} from '../../core/static-sources/static-source-policy.js';

export function decodeEvent(row: unknown, publicId: string): ActiveEventRow {
  const status = string(field(row, 'status'), 'status');
  if (!isLifecycleState(status)) {
    throw new Error(`fire_events.status holds a value outside the lifecycle: ${status}`);
  }
  return {
    publicId,
    seq: seqFrom(field(row, 'seq'), 'seq'),
    status,
    score: number(field(row, 'score'), 'score'),
    lon: number(field(row, 'lon'), 'lon'),
    lat: number(field(row, 'lat'), 'lat'),
    startedAt: epochMs(field(row, 'started_at'), 'started_at'),
    lastDetectionAt: epochMs(field(row, 'last_detection_at'), 'last_detection_at'),
    detectionCount: number(field(row, 'detection_count'), 'detection_count'),
    nearestPlace: nearestPlace(field(row, 'nearest_place')),
    sourceIds: sourceIdsFromMix(field(row, 'source_mix')),
    staticSourceVerdict: staticSourceVerdict(field(row, 'static_source_verdict')),
  };
}

/**
 * `static_source_verdict` (021) as a known verdict, or `null` — "not evaluated". 021's
 * CHECK constrains the column, so an unknown value means a newer migration than this
 * build; reading it as unreported is the honest answer, the same trade as
 * {@link sourceIdsFromMix}.
 */
export function staticSourceVerdict(value: unknown): StaticSourceVerdict | null {
  return typeof value === 'string' && (STATIC_SOURCE_VERDICTS as readonly string[]).includes(value)
    ? (value as StaticSourceVerdict)
    : null;
}

/**
 * `source_mix` (`jsonb`, detections per source id) as the event's contributing source
 * ids: the keys with a positive count. Order is left to the snapshot builder, which owns
 * the wire bytes and canonicalises them (`canonicalSourceIds`). An empty or
 * malformed mix is `null` — "not recorded" — rather than a thrown error: one event without
 * a source list is an honest gap the client counts as unreported, an empty map is an
 * outage (the same trade as {@link nearestPlace}).
 *
 * Keys are passed through verbatim, not checked against the contracts registry: the
 * column is written from `detections.source`, which the `sources` table constrains, and
 * the web parser tolerates an id it does not know (an append-only registry must not make
 * an older bundle reject a newer server).
 */
export function sourceIdsFromMix(value: unknown): readonly string[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const ids = Object.entries(value as Record<string, unknown>)
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([id]) => id);
  return ids.length === 0 ? null : ids;
}

/**
 * `nearest_place` is "name and coordinates only" (migration 001); a row written before a
 * name was resolved, or by hand, is tolerated as "no place" rather than failing the whole
 * snapshot — one unnamed event is a cosmetic gap, an empty map is an outage.
 */
export function nearestPlace(value: unknown): NearestPlace | null {
  if (value === null || typeof value !== 'object') return null;
  const place = value as Record<string, unknown>;
  const nameBg = place['name_bg'];
  const nameEn = place['name_en'];
  const lat = place['lat'];
  const lon = place['lon'];
  if (typeof nameBg !== 'string' || typeof nameEn !== 'string') return null;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return { name_bg: nameBg, name_en: nameEn, lat, lon };
}

export function field(row: unknown, name: string): unknown {
  if (row === null || typeof row !== 'object') throw new Error('driver returned a non-object row');
  return (row as Record<string, unknown>)[name] ?? null;
}

export function string(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} is not a string`);
  return value;
}

export function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} is not a finite number`);
  }
  return value;
}

export function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} is not a boolean`);
  return value;
}

export function epochMs(value: unknown, name: string): number {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${name} is not a timestamp`);
  }
  return value.getTime();
}

/** `bigint` columns arrive as decimal strings; a value past 2^53 would silently round. */
export function seqFrom(value: unknown, name: string): number {
  const text = string(value, name);
  const parsed = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is not a safe integer`);
  }
  return parsed;
}
