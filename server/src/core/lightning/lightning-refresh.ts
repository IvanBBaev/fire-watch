/**
 * One lightning refresh (TASKS F18; DATA-SOURCES §F18): find the LFL products of the last
 * six hours, fetch and decode the ones not yet recorded, and rebuild the merged document
 * the route serves.
 *
 * ## Cost discipline
 *
 * * The search is public and cheap; it runs every cycle.
 * * A product is downloaded **once**: its record's existence is the "done" mark. The token
 *   lives in the client and is asked for lazily on the first download, so a cycle with
 *   nothing new makes no authenticated request at all.
 * * At most {@link MAX_DOWNLOADS_PER_CYCLE} downloads per cycle, newest first — after an
 *   outage the map catches up on the present before the past, and one cycle never turns
 *   into a burst of 40 full-disc fetches.
 * * No retries inside a cycle; the next cycle (5 min later) is the retry. A 401/403 stops
 *   the cycle's remaining downloads — a revoked key does not deserve a dozen more tries.
 *
 * ## Failure shape
 *
 * Nothing is thrown out of {@link runLightningRefresh}. A product that fails to download
 * or decode is reported and left unrecorded, so the next cycle tries it again; a product
 * whose decode was *refused* is recorded as refused in its sidecar only (no flashes), so a
 * file the decoder will always reject is not fetched every five minutes forever. The merged
 * document is rewritten whenever the set of merged products or the retention cut changes.
 */

import { canonicalJson } from '../determinism/canonical-json.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../ports/clock.js';
import type {
  LightningClient,
  LightningProduct,
  LightningSearch,
} from '../ports/lightning-client.js';
import {
  LIGHTNING_KIND,
  LIGHTNING_SOURCE,
  type LightningDecoder,
  type LightningGranuleRef,
} from '../ports/lightning-decoder.js';
import type { PayloadReader } from '../ports/payload-reader.js';
import type { PayloadStore } from '../ports/payload-store.js';
import {
  LIGHTNING_CURRENT_META_PATH,
  LIGHTNING_CURRENT_PATH,
  LIGHTNING_RETENTION_MS,
  buildRecord,
  emptyDocument,
  mergeRecords,
  parseLightningDocument,
  parseLightningRecord,
  recordMetaPath,
  recordPath,
  type LightningDocument,
  type LightningRecord,
} from './lightning-document.js';
import { parseInterval, parseLightningPayload } from './lightning-payload.js';

/** Products are 10 minutes; a 5-minute cycle sees each one within 5 min of publication. */
export const LIGHTNING_REFRESH_INTERVAL_MS = 5 * 60_000;

export const MAX_DOWNLOADS_PER_CYCLE = 12;

/** The search looks this far past the retention window, for a product straddling its edge. */
const SEARCH_MARGIN_MS = 10 * 60_000;

export interface LightningRefreshDeps {
  readonly client: LightningClient;
  readonly decoder: LightningDecoder;
  readonly payloads: PayloadStore;
  readonly reader: PayloadReader;
  readonly clock: Clock;
}

export type LightningProductOutcome =
  'recorded' | 'download_failed' | 'decode_failed' | 'refused' | 'write_failed' | 'not_attempted';

export interface LightningProductResult {
  readonly id: string;
  readonly end: string;
  readonly outcome: LightningProductOutcome;
  readonly flashes: number | null;
  readonly error: string | null;
}

export interface LightningRefreshReport {
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs;
  /** `null` when the search answered. */
  readonly searchError: string | null;
  readonly found: number;
  readonly alreadyRecorded: number;
  readonly products: readonly LightningProductResult[];
  /** Whether the merged document was rewritten this cycle. */
  readonly documentWritten: boolean;
  readonly documentError: string | null;
  /** The merged document's `covered_through` after this cycle. */
  readonly coveredThrough: string | null;
}

/** Degraded when the search failed, the document could not be written, or a fetch failed. */
export function lightningRefreshFailed(report: LightningRefreshReport): boolean {
  return (
    report.searchError !== null ||
    report.documentError !== null ||
    report.products.some((p) => p.outcome !== 'recorded' && p.outcome !== 'refused')
  );
}

export async function runLightningRefresh(
  deps: LightningRefreshDeps,
): Promise<LightningRefreshReport> {
  const startedAt = deps.clock.now();
  const search: LightningSearch = await safeSearch(deps, startedAt);

  let previous: LightningDocument;
  let documentError: string | null = null;
  try {
    const text = await deps.reader.readText(LIGHTNING_CURRENT_PATH);
    previous = (text === null ? null : parseLightningDocument(text)) ?? emptyDocument(startedAt);
  } catch (error: unknown) {
    previous = emptyDocument(startedAt);
    documentError = `document unreadable: ${describeError(error)}`;
  }
  const merged = new Set(previous.products.map((p) => p.id));

  const results: LightningProductResult[] = [];
  const newRecords: LightningRecord[] = [];
  let found = 0;
  let alreadyRecorded = 0;
  if (search.ok) {
    const cutoff = startedAt - LIGHTNING_RETENTION_MS;
    const candidates = dedupe(search.products)
      .map((product) => ({
        product,
        window: parseInterval(`${product.window.startIso}/${product.window.endIso}`),
      }))
      .filter(
        (c): c is { product: LightningProduct; window: { start: EpochMs; end: EpochMs } } =>
          c.window !== null && c.window.end > cutoff,
      )
      .sort((a, b) => b.window.end - a.window.end || a.product.id.localeCompare(b.product.id));
    found = candidates.length;

    let downloads = 0;
    let stopped: string | null = null;
    for (const { product, window } of candidates) {
      if (merged.has(product.id)) {
        alreadyRecorded += 1;
        continue;
      }
      const existing = await readExisting(deps, window.end, product.id);
      if (existing === 'refused') {
        alreadyRecorded += 1;
        continue;
      }
      if (existing !== null) {
        alreadyRecorded += 1;
        newRecords.push(existing);
        continue;
      }
      if (stopped !== null || downloads >= MAX_DOWNLOADS_PER_CYCLE) {
        results.push(result(product, window.end, 'not_attempted', null, stopped));
        continue;
      }
      downloads += 1;
      const outcome = await fetchOne(deps, product, window);
      results.push(outcome.result);
      if (outcome.record !== null) newRecords.push(outcome.record);
      if (outcome.authFailed) stopped = 'stopped after an authentication refusal';
    }
  }

  const now = deps.clock.now();
  const next = mergeRecords(previous, newRecords, now);
  let documentWritten = false;
  if (documentError === null && changed(previous, next)) {
    try {
      const written = await deps.payloads.writeText(
        LIGHTNING_CURRENT_PATH,
        `${canonicalJson(next)}\n`,
      );
      await deps.payloads.writeText(
        LIGHTNING_CURRENT_META_PATH,
        `${canonicalJson({
          sha256: written.sha256,
          bytes: written.bytes,
          generated_at: next.generated_at,
          covered_through: next.covered_through,
          products: next.products.length,
          flashes: next.flashes.length,
        })}\n`,
      );
      documentWritten = true;
    } catch (error: unknown) {
      documentError = `document write failed: ${describeError(error)}`;
    }
  }

  return {
    startedAt,
    finishedAt: deps.clock.now(),
    searchError: search.ok ? null : describeSearchFailure(search),
    found,
    alreadyRecorded,
    products: results,
    documentWritten,
    documentError,
    coveredThrough: next.covered_through,
  };
}

async function safeSearch(deps: LightningRefreshDeps, now: EpochMs): Promise<LightningSearch> {
  try {
    return await deps.client.search({
      startIso: isoFromEpochMs(now - LIGHTNING_RETENTION_MS - SEARCH_MARGIN_MS),
      endIso: isoFromEpochMs(now),
    });
  } catch (error: unknown) {
    return { ok: false, status: null, error: describeError(error) };
  }
}

/**
 * A record already on disk (merged into the document before it was lost, or written by a
 * cycle that died before the document), `'refused'` for a product whose sidecar says the
 * decoder refused it, or `null` for a product never seen.
 */
async function readExisting(
  deps: LightningRefreshDeps,
  windowEnd: EpochMs,
  productId: string,
): Promise<LightningRecord | 'refused' | null> {
  try {
    const text = await deps.reader.readText(recordPath(windowEnd));
    if (text !== null) {
      const record = parseLightningRecord(text);
      if (record?.product_id === productId) return record;
      return null;
    }
    const meta = await deps.reader.readText(recordMetaPath(windowEnd));
    if (meta !== null) {
      const parsed = JSON.parse(meta) as { outcome?: unknown; product_id?: unknown };
      if (parsed.outcome === 'refused' && parsed.product_id === productId) return 'refused';
    }
  } catch {
    // An unreadable record is refetched; the store's own failure shows on the write.
  }
  return null;
}

async function fetchOne(
  deps: LightningRefreshDeps,
  product: LightningProduct,
  window: { readonly start: EpochMs; readonly end: EpochMs },
): Promise<{
  readonly result: LightningProductResult;
  readonly record: LightningRecord | null;
  readonly authFailed: boolean;
}> {
  const download = await deps.client.downloadBody(product).catch((error: unknown) => ({
    ok: false as const,
    status: null,
    error: describeError(error),
  }));
  if (!download.ok) {
    return {
      result: result(product, window.end, 'download_failed', null, download.error),
      record: null,
      authFailed: download.status === 401 || download.status === 403,
    };
  }
  const ref: LightningGranuleRef = {
    source: LIGHTNING_SOURCE,
    kind: LIGHTNING_KIND,
    slotIso: `${new Date(window.start).toISOString()}/${new Date(window.end).toISOString()}`,
    name: product.bodyName,
  };
  const decoded = await deps.decoder.decode(ref, download.bytes);
  const provenance = {
    product_id: product.id,
    body_name: product.bodyName,
    start: isoFromEpochMs(window.start),
    end: isoFromEpochMs(window.end),
    published_at: product.publishedAtIso,
    available_at: isoFromEpochMs(download.availableAt),
    md5_published: product.md5,
    raw_sha256: download.sha256,
    raw_bytes: download.bytes.byteLength,
    decode_ms: decoded.durationMs,
  };
  if (decoded.outcome !== 'ok') {
    if (decoded.outcome === 'refused') {
      const error = await writeMeta(deps, window.end, {
        ...provenance,
        outcome: 'refused',
        reason: decoded.error,
      });
      return {
        result: result(product, window.end, 'refused', null, error ?? decoded.error),
        record: null,
        authFailed: false,
      };
    }
    return {
      result: result(product, window.end, 'decode_failed', null, decoded.error ?? decoded.outcome),
      record: null,
      authFailed: false,
    };
  }
  const read = parseLightningPayload(ref, decoded.payload ?? '');
  if (!read.ok) {
    return {
      result: result(product, window.end, 'decode_failed', null, `payload: ${read.reason}`),
      record: null,
      authFailed: false,
    };
  }
  const record = buildRecord({
    productId: product.id,
    window,
    availableAt: download.availableAt,
    flashes: read.flashes,
  });
  try {
    await deps.payloads.writeText(recordPath(window.end), `${canonicalJson(record)}\n`);
    const error = await writeMeta(deps, window.end, {
      ...provenance,
      outcome: 'recorded',
      counts: read.counts,
      flashes_in_box: read.flashes.length,
    });
    if (error !== null) throw new Error(error);
  } catch (error: unknown) {
    return {
      result: result(product, window.end, 'write_failed', null, describeError(error)),
      record: null,
      authFailed: false,
    };
  }
  return {
    result: result(product, window.end, 'recorded', read.flashes.length, null),
    record,
    authFailed: false,
  };
}

async function writeMeta(
  deps: LightningRefreshDeps,
  windowEnd: EpochMs,
  meta: Record<string, unknown>,
): Promise<string | null> {
  try {
    await deps.payloads.writeText(recordMetaPath(windowEnd), `${canonicalJson(meta)}\n`);
    return null;
  } catch (error: unknown) {
    return `sidecar write failed: ${describeError(error)}`;
  }
}

function changed(previous: LightningDocument, next: LightningDocument): boolean {
  if (previous.products.length !== next.products.length) return true;
  if (previous.flashes.length !== next.flashes.length) return true;
  return previous.products.some((p, i) => p.id !== next.products[i]?.id);
}

function dedupe(products: readonly LightningProduct[]): LightningProduct[] {
  const byId = new Map<string, LightningProduct>();
  for (const product of products) if (!byId.has(product.id)) byId.set(product.id, product);
  return [...byId.values()];
}

function result(
  product: LightningProduct,
  end: EpochMs,
  outcome: LightningProductOutcome,
  flashes: number | null,
  error: string | null,
): LightningProductResult {
  return { id: product.id, end: isoFromEpochMs(end), outcome, flashes, error };
}

function describeSearchFailure(search: Extract<LightningSearch, { ok: false }>): string {
  return search.status === null ? search.error : `HTTP ${String(search.status)}: ${search.error}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
