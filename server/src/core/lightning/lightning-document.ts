/**
 * What the lightning job stores and what the route serves (TASKS F18; DATA-SOURCES §F18).
 *
 * ## Two layers of storage
 *
 * * **One record per product**, `lightning/mtg-li/lfl/<YYYYMMDD>/<window end>.json`, the
 *   decoded flashes of one 10-minute window, with a canonical-JSON provenance sidecar
 *   (`.meta.json`: product id, md5 as published, sha256 of the raw BODY bytes, decoder
 *   counts, `available_at`). A record's existence is how the job knows a product is done;
 *   the raw full-disc bytes are not kept — the product id makes them re-fetchable.
 * * **One merged document**, {@link LIGHTNING_CURRENT_PATH}: the last
 *   {@link LIGHTNING_RETENTION_MS} of flashes across products, plus the list of products it
 *   was built from, with a sha256 sidecar the route verifies. The payload store cannot list
 *   a directory, so the merged document is also the job's index of what it has merged.
 *
 * ## What "as of" means here
 *
 * `covered_through` is the latest window end among the merged products: every flash
 * up to that minute that the Lightning Imager detected inside the box is in the document.
 * It is the only honest clock for this layer — an empty map means "no flashes detected
 * up to `covered_through`", and it means that only while `covered_through` is recent. The
 * route refuses (503) once it is older than {@link LIGHTNING_MAX_STALENESS_MS}, instead of
 * serving an empty sky from a frozen pipeline (the F4 lesson).
 */

import type { BoundingBox } from '../config/polling-bbox.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import { LIGHTNING_SOURCE } from '../ports/lightning-decoder.js';
import type { Flash } from './lightning-payload.js';

export const LIGHTNING_DOCUMENT_SCHEMA_VERSION = 1;

export const LIGHTNING_RECORD_DIR = 'lightning/mtg-li/lfl';
export const LIGHTNING_CURRENT_PATH = 'overlays/lightning/current.json';
export const LIGHTNING_CURRENT_META_PATH = 'overlays/lightning/current.meta.json';

/** How far back the layer draws (the oldest age class, < 6 h). */
export const LIGHTNING_RETENTION_MS = 6 * 3_600_000;

/**
 * Products are 10 minutes long and published ~40 s after their window; the job runs
 * every 5 minutes. 45 minutes is four missed products — well past jitter, well short of
 * a map that silently shows an hour-old sky as "now".
 */
export const LIGHTNING_MAX_STALENESS_MS = 45 * 60_000;

/** One merged product, as listed in the document. */
export interface LightningProductEntry {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly available_at: string;
  readonly flashes: number;
}

/** A merged flash, trimmed to what the map draws. */
export interface LightningDocumentFlash {
  readonly t: string;
  readonly lat: number;
  readonly lon: number;
}

export interface LightningDocument {
  readonly schema_version: number;
  readonly source: typeof LIGHTNING_SOURCE;
  readonly generated_at: string;
  readonly covered_from: string | null;
  readonly covered_through: string | null;
  readonly available_at: string | null;
  readonly products: readonly LightningProductEntry[];
  readonly flashes: readonly LightningDocumentFlash[];
}

/** The record a product becomes on disk. */
export interface LightningRecord {
  readonly schema_version: number;
  readonly source: typeof LIGHTNING_SOURCE;
  readonly product_id: string;
  readonly start: string;
  readonly end: string;
  readonly available_at: string;
  readonly flashes: readonly {
    readonly t: string;
    readonly lat: number;
    readonly lon: number;
    readonly radiance: number | null;
    readonly duration_ms: number | null;
    readonly footprint: number | null;
  }[];
}

export function recordPath(windowEnd: EpochMs): string {
  const iso = isoFromEpochMs(windowEnd);
  const day = iso.slice(0, 10).replaceAll('-', '');
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d+Z$/u, 'Z');
  return `${LIGHTNING_RECORD_DIR}/${day}/${stamp}.json`;
}

export function recordMetaPath(windowEnd: EpochMs): string {
  return recordPath(windowEnd).replace(/\.json$/u, '.meta.json');
}

export function buildRecord(input: {
  readonly productId: string;
  readonly window: { readonly start: EpochMs; readonly end: EpochMs };
  readonly availableAt: EpochMs;
  readonly flashes: readonly Flash[];
}): LightningRecord {
  return {
    schema_version: LIGHTNING_DOCUMENT_SCHEMA_VERSION,
    source: LIGHTNING_SOURCE,
    product_id: input.productId,
    start: isoFromEpochMs(input.window.start),
    end: isoFromEpochMs(input.window.end),
    available_at: isoFromEpochMs(input.availableAt),
    flashes: [...input.flashes].sort(compareFlash).map((f) => ({
      t: new Date(f.at).toISOString(),
      lat: f.lat,
      lon: f.lon,
      radiance: f.radiance,
      duration_ms: f.durationMs,
      footprint: f.footprint,
    })),
  };
}

export function emptyDocument(now: EpochMs): LightningDocument {
  return {
    schema_version: LIGHTNING_DOCUMENT_SCHEMA_VERSION,
    source: LIGHTNING_SOURCE,
    generated_at: isoFromEpochMs(now),
    covered_from: null,
    covered_through: null,
    available_at: null,
    products: [],
    flashes: [],
  };
}

/**
 * Adds records to a document and drops everything older than the retention window —
 * products by their window end, flashes by their own time. Pure and order-independent:
 * the same set of records merged in any order gives the same document, so a job that
 * restarts halfway through a cycle converges on the next one.
 */
export function mergeRecords(
  previous: LightningDocument,
  records: readonly LightningRecord[],
  now: EpochMs,
): LightningDocument {
  const cutoff = now - LIGHTNING_RETENTION_MS;
  const products = new Map(previous.products.map((p) => [p.id, p] as const));
  const flashes: LightningDocumentFlash[] = [...previous.flashes];
  for (const record of records) {
    if (products.has(record.product_id)) continue;
    products.set(record.product_id, {
      id: record.product_id,
      start: record.start,
      end: record.end,
      available_at: record.available_at,
      flashes: record.flashes.length,
    });
    for (const f of record.flashes) flashes.push({ t: f.t, lat: f.lat, lon: f.lon });
  }
  const kept = [...products.values()]
    .filter((p) => Date.parse(p.end) > cutoff)
    .sort((a, b) => a.end.localeCompare(b.end) || a.id.localeCompare(b.id));
  const keptFlashes = flashes
    .filter((f) => Date.parse(f.t) > cutoff)
    .sort((a, b) => a.t.localeCompare(b.t) || a.lat - b.lat || a.lon - b.lon);
  const latestEnd = maxIso(kept.map((p) => p.end));
  const earliestStart = minIso(kept.map((p) => p.start));
  return {
    schema_version: LIGHTNING_DOCUMENT_SCHEMA_VERSION,
    source: LIGHTNING_SOURCE,
    generated_at: isoFromEpochMs(now),
    covered_from: earliestStart,
    covered_through: latestEnd,
    available_at: maxIso(kept.map((p) => p.available_at)),
    products: kept,
    flashes: keptFlashes,
  };
}

/** Parses a stored document; `null` for anything that is not exactly this shape. */
export function parseLightningDocument(text: string): LightningDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw['schema_version'] !== LIGHTNING_DOCUMENT_SCHEMA_VERSION) return null;
  if (raw['source'] !== LIGHTNING_SOURCE) return null;
  if (!isIso(raw['generated_at'])) return null;
  for (const key of ['covered_from', 'covered_through', 'available_at'] as const) {
    if (raw[key] !== null && !isIso(raw[key])) return null;
  }
  const products = raw['products'];
  const flashes = raw['flashes'];
  if (!Array.isArray(products) || !Array.isArray(flashes)) return null;
  for (const p of products) {
    if (
      !isRecord(p) ||
      typeof p['id'] !== 'string' ||
      !isIso(p['start']) ||
      !isIso(p['end']) ||
      !isIso(p['available_at']) ||
      typeof p['flashes'] !== 'number'
    ) {
      return null;
    }
  }
  for (const f of flashes) {
    if (!isRecord(f) || !isIso(f['t']) || !isCoord(f['lat'], 90) || !isCoord(f['lon'], 180)) {
      return null;
    }
  }
  return raw as unknown as LightningDocument;
}

/** Parses a stored record, for re-merging a product the document lost. */
export function parseLightningRecord(text: string): LightningRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw['schema_version'] !== LIGHTNING_DOCUMENT_SCHEMA_VERSION) return null;
  if (raw['source'] !== LIGHTNING_SOURCE || typeof raw['product_id'] !== 'string') return null;
  if (!isIso(raw['start']) || !isIso(raw['end']) || !isIso(raw['available_at'])) return null;
  const flashes = raw['flashes'];
  if (!Array.isArray(flashes)) return null;
  for (const f of flashes) {
    if (!isRecord(f) || !isIso(f['t']) || !isCoord(f['lat'], 90) || !isCoord(f['lon'], 180)) {
      return null;
    }
  }
  return raw as unknown as LightningRecord;
}

/** The body the route serves: the document's flashes as of `now`, inside `box`. */
export interface LightningOverlayBody {
  readonly schema_version: number;
  readonly source: typeof LIGHTNING_SOURCE;
  readonly covered_from: string;
  readonly covered_through: string;
  readonly available_at: string;
  /** Products merged; with the window it lets a reader see a gap in coverage. */
  readonly products: number;
  readonly retention_hours: number;
  readonly flashes: readonly LightningDocumentFlash[];
}

export type LightningSelection =
  | { readonly ok: true; readonly body: LightningOverlayBody }
  | { readonly ok: false; readonly reason: 'empty' | 'stale' };

export function selectLightning(
  document: LightningDocument,
  now: EpochMs,
  box: BoundingBox,
): LightningSelection {
  const { covered_from: from, covered_through: through, available_at: available } = document;
  if (from === null || through === null || available === null)
    return { ok: false, reason: 'empty' };
  if (now - Date.parse(through) > LIGHTNING_MAX_STALENESS_MS) return { ok: false, reason: 'stale' };
  const cutoff = now - LIGHTNING_RETENTION_MS;
  const flashes = document.flashes.filter((f) => {
    const at = Date.parse(f.t);
    return (
      at > cutoff &&
      at <= now &&
      f.lat >= box.south &&
      f.lat <= box.north &&
      f.lon >= box.west &&
      f.lon <= box.east
    );
  });
  return {
    ok: true,
    body: {
      schema_version: document.schema_version,
      source: document.source,
      covered_from: from,
      covered_through: through,
      available_at: available,
      products: document.products.filter((p) => Date.parse(p.end) > cutoff).length,
      retention_hours: LIGHTNING_RETENTION_MS / 3_600_000,
      flashes,
    },
  };
}

function compareFlash(a: Flash, b: Flash): number {
  return a.at - b.at || a.lat - b.lat || a.lon - b.lon;
}

function maxIso(values: readonly string[]): string | null {
  let best: string | null = null;
  for (const v of values) if (best === null || Date.parse(v) > Date.parse(best)) best = v;
  return best;
}

function minIso(values: readonly string[]): string | null {
  let best: string | null = null;
  for (const v of values) if (best === null || Date.parse(v) < Date.parse(best)) best = v;
  return best;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function isIso(value: unknown): value is string {
  return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
}

function isCoord(value: unknown, bound: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= bound;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
