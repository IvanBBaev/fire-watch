/**
 * The stored Copernicus EMS activation document (TASKS V2-E3): where the refresh job writes
 * it, and the one freshness rule the route applies before serving it.
 *
 * The document is the contracts `CemsOverlayBody` without `attribution` (the route adds
 * the credit, rendered from the registry, at serve time), written as canonical JSON with a
 * sha256 sidecar like every other overlay document.
 */

import {
  CEMS_CODE_RE,
  isCemsInstant,
  parseCemsOverlay,
  type CemsOverlayBody,
} from '@fire-watch/contracts';

import { epochMsFromIso, type EpochMs } from '../ports/clock.js';

export const CEMS_DIR = 'overlays/cems';
export const CEMS_CURRENT_PATH = `${CEMS_DIR}/current.json`;
export const CEMS_CURRENT_META_PATH = `${CEMS_DIR}/current.meta.json`;
export const CEMS_PROVIDER = 'copernicus-ems';
/**
 * The refresh job's own memory, never served: `{code: lastUpdate}` for each candidate whose
 * detail put it outside coverage, so its detail is not read again until it changes.
 */
export const CEMS_OUTSIDE_PATH = `${CEMS_DIR}/outside.json`;

/**
 * Past this age of `available_at` (the last successful list read) the route answers 503.
 * Six missed hourly cycles: an activation list that old may lack a fire's activation, and
 * a badge that is missing because the job stopped would read as "no activation".
 */
export const CEMS_MAX_STALENESS_MS = 6 * 3_600_000;

export function parseCemsDocument(text: string): CemsOverlayBody | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const body = parseCemsOverlay(raw);
  return body === null || body.attribution !== undefined ? null : body;
}

export type CemsSelection =
  | { readonly ok: true; readonly body: CemsOverlayBody }
  | { readonly ok: false; readonly reason: 'stale' };

export function selectCems(document: CemsOverlayBody, now: EpochMs): CemsSelection {
  if (now - epochMsFromIso(document.available_at) > CEMS_MAX_STALENESS_MS) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true, body: document };
}

/** `{code: lastUpdate}`; anything malformed reads as empty. */
export function parseCemsOutside(text: string): Map<string, string> {
  const known = new Map<string, string>();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return known;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return known;
  for (const [code, lastUpdate] of Object.entries(raw)) {
    if (CEMS_CODE_RE.test(code) && isCemsInstant(lastUpdate)) known.set(code, lastUpdate);
  }
  return known;
}
