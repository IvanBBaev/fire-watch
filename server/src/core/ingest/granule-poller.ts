/**
 * The geostationary poll cycle (TASKS C3) — one slot in, one immutable run out.
 *
 * The same shape as the FIRMS poller and for the same reason: nothing here writes, so a
 * recorded run replays through the identical code path (ADR-002 D7). What differs is the
 * three failure modes a binary product has that a CSV does not, and each of them is a
 * distinct outcome rather than a shared "error":
 *
 * - the slot is **missing** — a fixed grid always has an address, so an absent granule is
 *   a gap the archive can name, not an absence of information;
 * - the granule is **undecodable** — the sandbox crashed, timed out, flooded or refused,
 *   or the payload that came back was not a payload. The bytes are kept for quarantine
 *   (C2) and the ingest cycle moves on, because a poisoned granule that stops the cycle is
 *   a denial of service against every other source;
 * - the fetch itself **failed** — that one is ours, and it is the only one worth paging on.
 *
 * The disk is not the box. LSA-502 covers everything MSG can see, from Iceland to South
 * Africa, so the polling bbox is applied *here* rather than trusted to the provider — a
 * whole-disk granule landing unfiltered would be several thousand rows of somebody else's
 * fires per slot, all of them permanent.
 */

import { SOURCE_REGISTRY, SOURCE_REGISTRY_VERSION, type SourceId } from '@fire-watch/contracts';

import { POLLING_BBOX, type BoundingBox } from '../config/polling-bbox.js';
import { assertTotalOrder, orderBatch } from '../determinism/batch-order.js';
import type { DetectionUidFn } from '../ports/firms-client.js';
import type { GranuleDecoder, GranuleRef } from '../ports/granule-decoder.js';
import type { GranuleSource } from '../ports/granule-source.js';
import { parseGranulePayload, type GranuleRow } from './granule-payload.js';

export type GranuleSlotOutcome = 'ok' | 'missing' | 'undecodable' | 'failed';

/** A decoded row, identified and stamped with the instant the granule reached us. */
export interface IngestedGranuleDetection extends GranuleRow {
  readonly source: SourceId;
  readonly detectionUid: string;
  readonly availableAt: number;
}

export interface GranuleRowRejection {
  /** 1-based, as counted in the payload the decoder produced. */
  readonly rowIndex: number;
  readonly reason: string;
}

/** What the ingest cycle needs in order to keep a granule it could not read. */
export interface GranuleQuarantine {
  readonly reason: string;
  readonly bytes: Uint8Array;
  readonly name: string;
}

export interface GranuleSlotRun {
  readonly source: SourceId;
  readonly slotIso: string;
  readonly outcome: GranuleSlotOutcome;
  /** Set on `failed`, `missing` and `undecodable`, and only then. */
  readonly error?: string;
  /** The provider's filename, once there was one. */
  readonly granuleName: string | null;
  readonly availableAt: number | null;
  readonly sourceRegistryVersion: string;
  readonly pollingBboxVersion: string;
  /** In the fixed order `(available_at, source, lat, lon, detection_uid)`. */
  readonly detections: readonly IngestedGranuleDetection[];
  readonly rejections: readonly GranuleRowRejection[];
  /** Rows of the full disk that fell outside the polling box. Expected, and large. */
  readonly outsideBbox: number;
  /** Rows the granule repeated within itself, after canonicalization. */
  readonly duplicatesWithinBatch: number;
  /** The bytes to keep, when the granule could not be read. */
  readonly quarantine: GranuleQuarantine | null;
}

export interface PollGranuleDeps {
  readonly granules: GranuleSource;
  readonly decoder: GranuleDecoder;
  readonly detectionUid: DetectionUidFn;
  /** Defaults to `polling_bbox_v1`; a replay pins the version it ran under. */
  readonly bbox?: typeof POLLING_BBOX;
}

export async function pollGranuleSlot(
  source: SourceId,
  slotIso: string,
  deps: PollGranuleDeps,
): Promise<GranuleSlotRun> {
  const entry = SOURCE_REGISTRY[source];
  if (entry.productTier !== 'GEO') {
    // Wiring bug, not an outage: a polar source has no slot grid to address, and a run
    // recorded against one would put a granule gap into a source that never has granules.
    throw new RangeError(`${source} is not a geostationary granule source`);
  }

  const bbox = deps.bbox ?? POLLING_BBOX;
  const base = {
    source,
    slotIso,
    sourceRegistryVersion: SOURCE_REGISTRY_VERSION,
    pollingBboxVersion: bbox.version,
  } as const;
  const empty = {
    detections: [],
    rejections: [],
    outsideBbox: 0,
    duplicatesWithinBatch: 0,
    quarantine: null,
  } as const;

  let fetched;
  try {
    fetched = await deps.granules.fetchSlot(source, slotIso);
  } catch (error) {
    // A port that throws is still a recorded observation. The contract says it should
    // not, and this is what keeps one impolite adapter from ending the cycle.
    return {
      ...base,
      ...empty,
      outcome: 'failed',
      error: describe(error),
      granuleName: null,
      availableAt: null,
    };
  }

  if (fetched.outcome !== 'ok' || fetched.bytes === null || fetched.availableAt === null) {
    return {
      ...base,
      ...empty,
      outcome: fetched.outcome === 'missing' ? 'missing' : 'failed',
      error: fetched.error ?? `granule for ${slotIso} was not delivered`,
      granuleName: fetched.name,
      availableAt: fetched.availableAt,
    };
  }

  const name = fetched.name ?? `${source}-${slotIso}`;
  const availableAt = fetched.availableAt;
  const ref: GranuleRef = { source, kind: 'frp', slotIso, name };
  const undecodable = (reason: string): GranuleSlotRun => ({
    ...base,
    ...empty,
    outcome: 'undecodable',
    error: reason,
    granuleName: name,
    availableAt,
    quarantine: { reason, bytes: fetched.bytes ?? new Uint8Array(), name },
  });

  const decoded = await deps.decoder.decode(ref, fetched.bytes);
  if (decoded.outcome !== 'ok' || decoded.payload === null) {
    return undecodable(`decoder ${decoded.outcome}: ${decoded.error ?? 'no payload'}`);
  }

  const parsed = parseGranulePayload(ref, decoded.payload);
  if (!parsed.ok) return undecodable(`payload refused: ${parsed.reason}`);

  const seen = new Set<string>();
  const detections: IngestedGranuleDetection[] = [];
  const rejections: GranuleRowRejection[] = [];
  let outsideBbox = 0;
  let duplicatesWithinBatch = 0;

  for (const [index, row] of parsed.rows.entries()) {
    if (!withinBbox(row, bbox.values)) {
      outsideBbox += 1;
      continue;
    }
    let detectionUid: string;
    try {
      detectionUid = deps.detectionUid({
        source,
        acqTsIso: row.acqTsIso,
        lat: row.latCanonical,
        lon: row.lonCanonical,
      });
    } catch (error) {
      // One unusable row is not an unusable granule. It is, however, worth recording:
      // coordinates that cannot be hashed came from somewhere.
      rejections.push({ rowIndex: index + 1, reason: describe(error) });
      continue;
    }
    if (seen.has(detectionUid)) {
      duplicatesWithinBatch += 1;
      continue;
    }
    seen.add(detectionUid);
    detections.push({ ...row, source, detectionUid, availableAt });
  }

  const ordered = orderBatch(detections);
  assertTotalOrder(ordered);

  return {
    ...base,
    outcome: 'ok',
    granuleName: name,
    availableAt,
    detections: ordered,
    rejections,
    outsideBbox,
    duplicatesWithinBatch,
    quarantine: null,
  };
}

/**
 * Inclusive on every edge, on the canonical text rather than on the decoder's doubles —
 * the string is what the uid was hashed from, so it is also what decides membership.
 * ADR-002 D3: the edge is a fixed decision, not a floating-point coincidence.
 */
function withinBbox(row: GranuleRow, bbox: BoundingBox): boolean {
  const lat = Number(row.latCanonical);
  const lon = Number(row.lonCanonical);
  return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
