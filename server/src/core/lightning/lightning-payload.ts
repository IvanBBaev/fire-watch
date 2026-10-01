/**
 * Decoder text → flashes (TASKS F18). The lightning twin of `parseGranulePayload`.
 *
 * The decoder child parsed hostile bytes; its stdout is therefore untrusted too (see the
 * `GranuleDecoder` port, rule 2). This is the only place that text becomes values, and it
 * trusts nothing it can check: the format tag, that the window is the one the ref asked
 * for, that every flash time is a UTC instant inside that window (± the child's own
 * tolerance), that every position is a finite coordinate. One bad row refuses the whole
 * payload — a decoder that emits one impossible flash has not earned belief in the rest.
 */

import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import type { LightningGranuleRef } from '../ports/lightning-decoder.js';

/** Must equal `PAYLOAD_FORMAT` in `mtg-li-flash-decoder.ts`; a test holds them together. */
export const LIGHTNING_PAYLOAD_FORMAT = 'fire-watch.lightning.v1';

/** Must equal the child's `WINDOW_TOLERANCE_MS`. */
export const LIGHTNING_WINDOW_TOLERANCE_MS = 2 * 60_000;

/** A payload with more rows than this is not a clipped 10-minute product. */
export const MAX_PAYLOAD_FLASHES = 200_000;

export interface Flash {
  /** Epoch milliseconds of the flash's first event. */
  readonly at: EpochMs;
  readonly lat: number;
  readonly lon: number;
  readonly radiance: number | null;
  readonly durationMs: number | null;
  readonly footprint: number | null;
}

export interface DecoderCounts {
  readonly flashes: number;
  readonly clippedOut: number;
  readonly droppedWithoutPosition: number;
  readonly droppedWithoutTime: number;
  readonly droppedOutsideWindow: number;
}

export type LightningPayloadRead =
  | {
      readonly ok: true;
      readonly window: { readonly start: EpochMs; readonly end: EpochMs };
      readonly flashes: readonly Flash[];
      readonly counts: DecoderCounts;
    }
  | { readonly ok: false; readonly reason: string };

export function parseLightningPayload(
  ref: LightningGranuleRef,
  text: string,
): LightningPayloadRead {
  const window = parseInterval(ref.slotIso);
  if (window === null) return refuse(`ref window ${JSON.stringify(ref.slotIso)} is malformed`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('payload is not JSON');
  }
  if (!isRecord(parsed)) return refuse('payload is not an object');
  if (parsed['format'] !== LIGHTNING_PAYLOAD_FORMAT) {
    return refuse(
      `payload format ${JSON.stringify(parsed['format'])} is not ${LIGHTNING_PAYLOAD_FORMAT}`,
    );
  }
  const payloadWindow = parsed['window'];
  if (
    !isRecord(payloadWindow) ||
    typeof payloadWindow['start'] !== 'string' ||
    typeof payloadWindow['end'] !== 'string' ||
    safeEpoch(payloadWindow['start']) !== window.start ||
    safeEpoch(payloadWindow['end']) !== window.end
  ) {
    return refuse('payload window is not the window the product was fetched for');
  }
  const rows = parsed['flashes'];
  if (!Array.isArray(rows)) return refuse('payload has no flashes array');
  if (rows.length > MAX_PAYLOAD_FLASHES) {
    return refuse(
      `payload has ${String(rows.length)} flashes, over ${String(MAX_PAYLOAD_FLASHES)}`,
    );
  }
  const earliest = window.start - LIGHTNING_WINDOW_TOLERANCE_MS;
  const latest = window.end + LIGHTNING_WINDOW_TOLERANCE_MS;
  const flashes: Flash[] = [];
  for (const [i, row] of rows.entries()) {
    if (!isRecord(row)) return refuse(`flash ${String(i)} is not an object`);
    const at = typeof row['t'] === 'string' ? safeEpoch(row['t']) : null;
    if (at === null || at < earliest || at > latest) {
      return refuse(`flash ${String(i)} time is missing or outside the window`);
    }
    const lat = row['lat'];
    const lon = row['lon'];
    if (!isFiniteIn(lat, 90) || !isFiniteIn(lon, 180)) {
      return refuse(`flash ${String(i)} position is not a coordinate`);
    }
    const radiance = optionalNonNegative(row['radiance']);
    const durationMs = optionalNonNegative(row['durationMs']);
    const footprint = optionalNonNegative(row['footprint']);
    if (radiance === undefined || durationMs === undefined || footprint === undefined) {
      return refuse(`flash ${String(i)} has a malformed optional field`);
    }
    flashes.push({ at, lat, lon, radiance, durationMs, footprint });
  }
  const counts = readCounts(parsed['decoder'], rows.length);
  if (counts === null) return refuse('payload decoder counts are malformed');
  return { ok: true, window, flashes, counts };
}

/** `start/end` → epoch milliseconds, or `null`. */
export function parseInterval(slotIso: string): { start: EpochMs; end: EpochMs } | null {
  const parts = slotIso.split('/');
  if (parts.length !== 2) return null;
  const start = safeEpoch(parts[0] ?? '');
  const end = safeEpoch(parts[1] ?? '');
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

function readCounts(value: unknown, emitted: number): DecoderCounts | null {
  if (!isRecord(value)) return null;
  const keys = [
    'flashes',
    'clippedOut',
    'droppedWithoutPosition',
    'droppedWithoutTime',
    'droppedOutsideWindow',
  ] as const;
  const out: Record<string, number> = {};
  for (const key of keys) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return null;
    out[key] = n;
  }
  const counts = out as unknown as DecoderCounts;
  const accounted =
    emitted +
    counts.clippedOut +
    counts.droppedWithoutPosition +
    counts.droppedWithoutTime +
    counts.droppedOutsideWindow;
  // The child's arithmetic must close: every flash in the file is emitted or counted.
  return accounted === counts.flashes ? counts : null;
}

function safeEpoch(iso: string): EpochMs | null {
  try {
    return epochMsFromIso(iso);
  } catch {
    return null;
  }
}

function isFiniteIn(value: unknown, bound: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= bound;
}

/** `null` passes through; a non-negative finite number passes; anything else is `undefined`. */
function optionalNonNegative(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(reason: string): LightningPayloadRead {
  return { ok: false, reason };
}
