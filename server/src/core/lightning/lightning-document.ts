/**
 * What the lightning job stores and what the route serves (TASKS F18; DATA-SOURCES §F18).
 *
 * ## Two layers of storage
 *
 * * **One record per product**, `lightning/mtg-li/lfl/<YYYYMMDD>/<product id>.json`, the
 *   decoded flashes of one 10-minute window (every flash, with its `false_likelihood`),
 *   with a canonical-JSON provenance sidecar
 *   (`.meta.json`: product id, md5 as published, sha256 of the raw BODY bytes, decoder
 *   counts, `available_at`). A record's existence is how the job knows a product is done;
 *   the raw full-disc bytes are not kept — the product id makes them re-fetchable.
 * * **One merged document**, {@link LIGHTNING_CURRENT_PATH}: the last
 *   {@link LIGHTNING_DOCUMENT_RETENTION_MS} of flashes, grouped by the product (one per
 *   window) they came from and filtered under `lightning_filter`, with a sha256 sidecar
 *   the route verifies. The route serves only the last {@link LIGHTNING_RETENTION_MS}. The payload store cannot list
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
import {
  LIGHTNING_FILTER,
  judgeFlash,
  type LightningFilterValues,
} from '../config/lightning-filter.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import { LIGHTNING_SOURCE } from '../ports/lightning-decoder.js';
import type { Flash } from './lightning-payload.js';

/**
 * Version 2: records keyed by product id with `published_at` and per-flash
 * `false_likelihood`; the document groups flashes by product so a reprocessed product
 * replaces exactly its own window, and names the filter it was built under.
 */
export const LIGHTNING_DOCUMENT_SCHEMA_VERSION = 2;
export const LIGHTNING_RECORD_SCHEMA_VERSION = 2;
/** The route's body is unchanged by the storage bump; the web parser pins this. */
export const LIGHTNING_OVERLAY_SCHEMA_VERSION = 1;

export const LIGHTNING_RECORD_DIR = 'lightning/mtg-li/lfl';
export const LIGHTNING_CURRENT_PATH = 'overlays/lightning/current.json';
export const LIGHTNING_CURRENT_META_PATH = 'overlays/lightning/current.meta.json';

/** How far back the layer draws (the oldest age class, < 6 h). */
export const LIGHTNING_RETENTION_MS = 6 * 3_600_000;

/**
 * How far back the merged document keeps products. Longer than what the map draws so the
 * per-event context (`lightning-context.ts`) can still answer for an event whose first
 * VIIRS detection reaches the pipeline hours after the overpass: a 3 h look-back plus
 * ~3 h of NRT latency plus margin.
 */
export const LIGHTNING_DOCUMENT_RETENTION_MS = 9 * 3_600_000;

/**
 * Products are 10 minutes long and published ~40 s after their window; the job runs
 * every 5 minutes. 45 minutes is four missed products — well past jitter, well short of
 * a map that silently shows an hour-old sky as "now".
 */
export const LIGHTNING_MAX_STALENESS_MS = 45 * 60_000;

/** A merged flash, trimmed to what the map draws. */
export interface LightningDocumentFlash {
  readonly t: string;
  readonly lat: number;
  readonly lon: number;
}

/** One merged product, with the flashes it contributed after the filter. */
export interface LightningProductEntry {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly published_at: string | null;
  readonly available_at: string;
  /** Flashes kept by the filter (rated or not), inside the retention window. */
  readonly kept: number;
  /** Flashes the product rated more likely false than true. */
  readonly filtered_out: number;
  /** Kept flashes the product left unrated. */
  readonly unrated: number;
  readonly flashes: readonly LightningDocumentFlash[];
}

export interface LightningDocument {
  readonly schema_version: number;
  readonly source: typeof LIGHTNING_SOURCE;
  readonly filter_version: string;
  readonly generated_at: string;
  readonly covered_from: string | null;
  readonly covered_through: string | null;
  readonly available_at: string | null;
  /** One product per window, ordered by window end. */
  readonly products: readonly LightningProductEntry[];
}

/** The record a product becomes on disk. */
export interface LightningRecord {
  readonly schema_version: number;
  readonly source: typeof LIGHTNING_SOURCE;
  readonly product_id: string;
  readonly start: string;
  readonly end: string;
  readonly published_at: string | null;
  readonly available_at: string;
  readonly flashes: readonly {
    readonly t: string;
    readonly lat: number;
    readonly lon: number;
    readonly radiance: number | null;
    readonly duration_ms: number | null;
    readonly footprint: number | null;
    readonly false_likelihood: number | null;
  }[];
}

/**
 * A record's path: the UTC day of its window end, then the product id. Keyed by product
 * id rather than window so a reprocessed product never overwrites the record of the one
 * it supersedes (or a neighbour's). Characters outside `[A-Za-z0-9._-]` are written as
 * `~XX` (hex), which keeps any id a single safe path segment and is reversible.
 */
export function recordPath(windowEnd: EpochMs, productId: string): string {
  const day = isoFromEpochMs(windowEnd).slice(0, 10).replaceAll('-', '');
  return `${LIGHTNING_RECORD_DIR}/${day}/${encodeProductId(productId)}.json`;
}

export function recordMetaPath(windowEnd: EpochMs, productId: string): string {
  return recordPath(windowEnd, productId).replace(/\.json$/u, '.meta.json');
}

export function encodeProductId(id: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(id)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9._-]/u.test(ch) ? ch : `~${byte.toString(16).padStart(2, '0')}`;
  }
  // A leading dot would make a hidden file or a `..` segment.
  return out.startsWith('.') ? `~2e${out.slice(1)}` : out;
}

export function buildRecord(input: {
  readonly productId: string;
  readonly window: { readonly start: EpochMs; readonly end: EpochMs };
  readonly publishedAtIso?: string | null;
  readonly availableAt: EpochMs;
  readonly flashes: readonly Flash[];
}): LightningRecord {
  const publishedMs = input.publishedAtIso == null ? NaN : Date.parse(input.publishedAtIso);
  return {
    schema_version: LIGHTNING_RECORD_SCHEMA_VERSION,
    source: LIGHTNING_SOURCE,
    product_id: input.productId,
    start: isoFromEpochMs(input.window.start),
    end: isoFromEpochMs(input.window.end),
    published_at: Number.isFinite(publishedMs) ? isoFromEpochMs(publishedMs) : null,
    available_at: isoFromEpochMs(input.availableAt),
    flashes: [...input.flashes].sort(compareFlash).map((f) => ({
      t: new Date(f.at).toISOString(),
      lat: f.lat,
      lon: f.lon,
      radiance: f.radiance,
      duration_ms: f.durationMs,
      footprint: f.footprint,
      false_likelihood: f.falseLikelihood,
    })),
  };
}

export function emptyDocument(
  now: EpochMs,
  filter: VersionedConfig<LightningFilterValues> = LIGHTNING_FILTER,
): LightningDocument {
  return {
    schema_version: LIGHTNING_DOCUMENT_SCHEMA_VERSION,
    source: LIGHTNING_SOURCE,
    filter_version: filter.version,
    generated_at: isoFromEpochMs(now),
    covered_from: null,
    covered_through: null,
    available_at: null,
    products: [],
  };
}

/** The window a product covers, as the key two products of the same window share. */
export function windowKey(p: { readonly start: string; readonly end: string }): string {
  return `${String(Date.parse(p.start))}/${String(Date.parse(p.end))}`;
}

/**
 * Which of two products of the same window the document keeps: the later publication,
 * then the later arrival, then the larger id. A total order, so the merge never depends
 * on the order the products arrived in.
 */
export function supersedes(
  a: { readonly id: string; readonly published_at: string | null; readonly available_at?: string },
  b: { readonly id: string; readonly published_at: string | null; readonly available_at?: string },
): boolean {
  const pa = a.published_at === null ? -Infinity : Date.parse(a.published_at);
  const pb = b.published_at === null ? -Infinity : Date.parse(b.published_at);
  if (pa !== pb) return pa > pb;
  const aa = a.available_at === undefined ? -Infinity : Date.parse(a.available_at);
  const ab = b.available_at === undefined ? -Infinity : Date.parse(b.available_at);
  if (aa !== ab) return aa > ab;
  return a.id > b.id;
}

/**
 * Adds records to a document and drops everything older than the document's retention —
 * products by their window end, flashes by their own time. One product per window: a
 * reprocessed product replaces the one it supersedes ({@link supersedes}) and nothing
 * else. Pure and order-independent: the same set of records merged in any order gives the
 * same document, so a job that restarts halfway through a cycle converges on the next one.
 * The filter is applied here, to records only; products already in `previous` were
 * filtered under the same version (a document under another version does not parse).
 */
export function mergeRecords(
  previous: LightningDocument,
  records: readonly LightningRecord[],
  now: EpochMs,
  filter: VersionedConfig<LightningFilterValues> = LIGHTNING_FILTER,
): LightningDocument {
  const cutoff = now - LIGHTNING_DOCUMENT_RETENTION_MS;
  const byWindow = new Map<string, LightningProductEntry>();
  const offer = (entry: LightningProductEntry): void => {
    const key = windowKey(entry);
    const held = byWindow.get(key);
    if (held === undefined || supersedes(entry, held)) byWindow.set(key, entry);
  };
  for (const product of previous.products) offer(product);
  for (const record of records) offer(entryFromRecord(record, filter.values));
  const products = [...byWindow.values()]
    .filter((p) => Date.parse(p.end) > cutoff)
    .map((p) => trimEntry(p, cutoff))
    .sort((a, b) => a.end.localeCompare(b.end) || a.id.localeCompare(b.id));
  return {
    schema_version: LIGHTNING_DOCUMENT_SCHEMA_VERSION,
    source: LIGHTNING_SOURCE,
    filter_version: filter.version,
    generated_at: isoFromEpochMs(now),
    covered_from: minIso(products.map((p) => p.start)),
    covered_through: maxIso(products.map((p) => p.end)),
    available_at: maxIso(products.map((p) => p.available_at)),
    products,
  };
}

function entryFromRecord(
  record: LightningRecord,
  filter: LightningFilterValues,
): LightningProductEntry {
  const flashes: LightningDocumentFlash[] = [];
  let filteredOut = 0;
  let unrated = 0;
  for (const f of record.flashes) {
    const verdict = judgeFlash(f.false_likelihood, filter);
    if (verdict === 'dropped') {
      filteredOut += 1;
      continue;
    }
    if (verdict === 'kept_unrated') unrated += 1;
    flashes.push({ t: f.t, lat: f.lat, lon: f.lon });
  }
  flashes.sort(compareDocumentFlash);
  return {
    id: record.product_id,
    start: record.start,
    end: record.end,
    published_at: record.published_at,
    available_at: record.available_at,
    kept: flashes.length,
    filtered_out: filteredOut,
    unrated,
    flashes,
  };
}

function trimEntry(entry: LightningProductEntry, cutoff: EpochMs): LightningProductEntry {
  if (entry.flashes.every((f) => Date.parse(f.t) > cutoff)) return entry;
  const flashes = entry.flashes.filter((f) => Date.parse(f.t) > cutoff);
  return { ...entry, kept: flashes.length, flashes };
}

/** Every flash in the document, in time order. */
export function documentFlashes(document: LightningDocument): LightningDocumentFlash[] {
  return document.products.flatMap((p) => p.flashes).sort(compareDocumentFlash);
}

/**
 * Parses a stored document; `null` for anything that is not exactly this shape — or was
 * built under another filter version, which the job then rebuilds from its records.
 */
export function parseLightningDocument(
  text: string,
  filter: VersionedConfig<LightningFilterValues> = LIGHTNING_FILTER,
): LightningDocument | null {
  const raw = parseJson(text);
  if (raw === null) return null;
  if (raw['schema_version'] !== LIGHTNING_DOCUMENT_SCHEMA_VERSION) return null;
  if (raw['source'] !== LIGHTNING_SOURCE) return null;
  if (raw['filter_version'] !== filter.version) return null;
  if (!isIso(raw['generated_at'])) return null;
  for (const key of ['covered_from', 'covered_through', 'available_at'] as const) {
    if (raw[key] !== null && !isIso(raw[key])) return null;
  }
  const products = raw['products'];
  if (!Array.isArray(products)) return null;
  for (const p of products) {
    if (
      !isRecord(p) ||
      typeof p['id'] !== 'string' ||
      !isIso(p['start']) ||
      !isIso(p['end']) ||
      (p['published_at'] !== null && !isIso(p['published_at'])) ||
      !isIso(p['available_at']) ||
      !isCount(p['kept']) ||
      !isCount(p['filtered_out']) ||
      !isCount(p['unrated']) ||
      !areFlashes(p['flashes'])
    ) {
      return null;
    }
  }
  return raw as unknown as LightningDocument;
}

/** Parses a stored record, for re-merging a product the document lost. */
export function parseLightningRecord(text: string): LightningRecord | null {
  const raw = parseJson(text);
  if (raw === null) return null;
  if (raw['schema_version'] !== LIGHTNING_RECORD_SCHEMA_VERSION) return null;
  if (raw['source'] !== LIGHTNING_SOURCE || typeof raw['product_id'] !== 'string') return null;
  if (!isIso(raw['start']) || !isIso(raw['end']) || !isIso(raw['available_at'])) return null;
  if (raw['published_at'] !== null && !isIso(raw['published_at'])) return null;
  const flashes = raw['flashes'];
  if (!areFlashes(flashes)) return null;
  for (const f of flashes as Record<string, unknown>[]) {
    const fl = f['false_likelihood'];
    if (fl !== null && !(typeof fl === 'number' && fl >= 0 && fl <= 1)) return null;
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

/**
 * The overlay body: only the last {@link LIGHTNING_RETENTION_MS}, even though the
 * document keeps longer for the event context. `covered_from` is clamped to the same
 * cut, so the body never claims coverage for flashes it does not carry.
 */
export function selectLightning(
  document: LightningDocument,
  now: EpochMs,
  box: BoundingBox,
): LightningSelection {
  const cutoff = now - LIGHTNING_RETENTION_MS;
  const products = document.products.filter((p) => Date.parse(p.end) > cutoff);
  const through = maxIso(products.map((p) => p.end));
  const from = minIso(products.map((p) => p.start));
  const available = maxIso(products.map((p) => p.available_at));
  if (from === null || through === null || available === null)
    return { ok: false, reason: 'empty' };
  if (now - Date.parse(through) > LIGHTNING_MAX_STALENESS_MS) return { ok: false, reason: 'stale' };
  const flashes = products
    .flatMap((p) => p.flashes)
    .filter((f) => {
      const at = Date.parse(f.t);
      return (
        at > cutoff &&
        at <= now &&
        f.lat >= box.south &&
        f.lat <= box.north &&
        f.lon >= box.west &&
        f.lon <= box.east
      );
    })
    .sort(compareDocumentFlash);
  return {
    ok: true,
    body: {
      schema_version: LIGHTNING_OVERLAY_SCHEMA_VERSION,
      source: document.source,
      covered_from: Date.parse(from) < cutoff ? isoFromEpochMs(cutoff) : from,
      covered_through: through,
      available_at: available,
      products: products.length,
      retention_hours: LIGHTNING_RETENTION_MS / 3_600_000,
      flashes,
    },
  };
}

function compareFlash(a: Flash, b: Flash): number {
  return a.at - b.at || a.lat - b.lat || a.lon - b.lon;
}

function compareDocumentFlash(a: LightningDocumentFlash, b: LightningDocumentFlash): number {
  return a.t.localeCompare(b.t) || a.lat - b.lat || a.lon - b.lon;
}

function parseJson(text: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(raw) ? raw : null;
}

function areFlashes(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const f of value) {
    if (!isRecord(f) || !isIso(f['t']) || !isCoord(f['lat'], 90) || !isCoord(f['lon'], 180)) {
      return false;
    }
  }
  return true;
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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
