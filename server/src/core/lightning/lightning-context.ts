/**
 * The per-event lightning context (TASKS F18): how many merged MTG-LI flashes fell within
 * a radius of an event in the hours before its first detection.
 *
 * **Context, never cause** (GLOSSARY §5.2). Nothing here says lightning started a fire;
 * the number is offered next to the event the way weather is, and the copy says LI misses
 * some flashes.
 *
 * **"No lightning data" is not "no lightning".** A count is only stored when every minute
 * of the window is covered by a merged product ({@link coverage}); a window with a hole is
 * waited on while the hole could still fill, and stored as `unavailable` once its start
 * has left the document's retention. A `complete` row with zero flashes is a statement
 * about the data; an `unavailable` row is a statement that there is none.
 *
 * Runs in the lightning loop after each refresh, against the document that refresh just
 * wrote. Pure evaluation ({@link evaluateLightningContext}) plus a thin pass that reads the
 * document and the pending events and saves the answers.
 */

import { LIGHTNING_CONTEXT, type LightningContextValues } from '../config/lightning-context.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import type { Clock, EpochMs } from '../ports/clock.js';
import type {
  LightningContextCandidate,
  LightningContextRow,
  LightningContextStore,
} from '../ports/lightning-context-store.js';
import type { PayloadReader } from '../ports/payload-reader.js';
import {
  LIGHTNING_CURRENT_PATH,
  LIGHTNING_DOCUMENT_RETENTION_MS,
  parseLightningDocument,
  type LightningDocument,
} from './lightning-document.js';

const HOUR_MS = 3_600_000;
const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

export function greatCircleKm(
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The covered spans of a document, merged across abutting products (gaps up to
 * `maxGapMs` close). A span never starts before the document's own retention cut, because
 * flashes older than that were trimmed even where their product was kept.
 */
export function coverage(
  document: LightningDocument,
  maxGapMs: number,
): { readonly from: EpochMs; readonly to: EpochMs }[] {
  const floor = Date.parse(document.generated_at) - LIGHTNING_DOCUMENT_RETENTION_MS;
  const spans = document.products
    .map((p) => ({ from: Math.max(Date.parse(p.start), floor), to: Date.parse(p.end) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  const merged: { from: EpochMs; to: EpochMs }[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span.from - last.to <= maxGapMs) {
      last.to = Math.max(last.to, span.to);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * The answer for one event, or `null` while it is still worth waiting for: the window is
 * not yet covered but its start is still inside the document's retention.
 */
export function evaluateLightningContext(
  event: LightningContextCandidate,
  document: LightningDocument | null,
  now: EpochMs,
  config: VersionedConfig<LightningContextValues> = LIGHTNING_CONTEXT,
): LightningContextRow | null {
  const { radiusKm, windowHours, maxGapSeconds } = config.values;
  const windowTo = event.firstDetectedAt;
  const windowFrom = windowTo - windowHours * HOUR_MS;
  const base = {
    eventId: event.eventId,
    windowFrom,
    windowTo,
    radiusKm,
    paramsVersion: config.version,
    computedAt: now,
  };
  const covered =
    document !== null &&
    coverage(document, maxGapSeconds * 1000).some((s) => s.from <= windowFrom && s.to >= windowTo);
  if (document !== null && covered) {
    let flashCount = 0;
    let nearestKm: number | null = null;
    for (const product of document.products) {
      if (Date.parse(product.end) < windowFrom || Date.parse(product.start) > windowTo) continue;
      for (const flash of product.flashes) {
        const at = Date.parse(flash.t);
        if (at < windowFrom || at > windowTo) continue;
        const km = greatCircleKm(event, flash);
        if (km > radiusKm) continue;
        flashCount += 1;
        nearestKm = nearestKm === null ? km : Math.min(nearestKm, km);
      }
    }
    return {
      ...base,
      status: 'complete',
      flashCount,
      nearestKm: nearestKm === null ? null : Math.round(nearestKm * 10) / 10,
      filterVersion: document.filter_version,
    };
  }
  if (windowFrom > now - LIGHTNING_DOCUMENT_RETENTION_MS) return null;
  return {
    ...base,
    status: 'unavailable',
    flashCount: null,
    nearestKm: null,
    filterVersion: document?.filter_version ?? 'none',
  };
}

export interface LightningContextDeps {
  readonly store: LightningContextStore;
  readonly reader: PayloadReader;
  readonly clock: Clock;
}

export interface LightningContextReport {
  readonly pending: number;
  readonly complete: number;
  readonly unavailable: number;
  readonly waiting: number;
  /** `null` when the pass ran; otherwise why it did not, or where it stopped. */
  readonly error: string | null;
}

/** One pass: answer every pending event that can be answered now. Never throws. */
export async function runLightningContextPass(
  deps: LightningContextDeps,
  config: VersionedConfig<LightningContextValues> = LIGHTNING_CONTEXT,
): Promise<LightningContextReport> {
  const empty = { pending: 0, complete: 0, unavailable: 0, waiting: 0 };
  let document: LightningDocument | null;
  try {
    const text = await deps.reader.readText(LIGHTNING_CURRENT_PATH);
    document = text === null ? null : parseLightningDocument(text);
  } catch (error: unknown) {
    // An unreadable document must not turn into a wave of "unavailable" rows.
    return { ...empty, error: `document unreadable: ${describe(error)}` };
  }
  try {
    const pending = await deps.store.pendingEvents(config.version, config.values.batchSize);
    const now = deps.clock.now();
    const rows = pending
      .map((event) => evaluateLightningContext(event, document, now, config))
      .filter((row): row is LightningContextRow => row !== null);
    if (rows.length > 0) await deps.store.save(rows);
    const complete = rows.filter((r) => r.status === 'complete').length;
    return {
      pending: pending.length,
      complete,
      unavailable: rows.length - complete,
      waiting: pending.length - rows.length,
      error: null,
    };
  } catch (error: unknown) {
    return { ...empty, error: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
