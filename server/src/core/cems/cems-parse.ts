/**
 * Parsing the Copernicus EMS Rapid Mapping dashboard API (TASKS V2-E3; DATA-SOURCES §V2-E3)
 * into what the overlay document carries, and the coverage rule that decides which
 * activations the product keeps.
 *
 * ## What the API sends, and what is done with it
 *
 *   * **Instants are naive** (`2026-09-15T13:00:00`, sometimes with microseconds). The
 *     portal shows them as UTC and the activation reports are in UTC, so they are read as
 *     UTC, the fraction truncated to milliseconds, and written with an explicit `Z`. An
 *     instant that already carries `Z` or `+00:00` is accepted; any other offset is refused.
 *   * **Geometry is WKT** in lon/lat (EPSG:4326): the centroid a `POINT`, each AOI's extent
 *     a `POLYGON` (a `MULTIPOLYGON` is accepted). Only the bounding box of an AOI is kept,
 *     rounded outward to 1e-4°, so it never shrinks below the drawn area.
 *   * **A list entry that does not parse is skipped and counted**, not fatal: one odd row
 *     from upstream must not hide every other activation. A page whose envelope does not
 *     parse is fatal for the cycle.
 *   * **`category` is filtered again** even though the query asks for Wildfire: the query
 *     parameter is the portal's, not a documented contract.
 */

import { CEMS_CODE_RE, isCemsInstant, type CemsBox } from '@fire-watch/contracts';

import { expandBboxKm, type BoundingBox } from '../config/polling-bbox.js';

/** One wildfire activation as the list page describes it. */
export interface CemsListEntry {
  readonly code: string;
  readonly name: string;
  readonly event_time: string;
  readonly activation_time: string;
  readonly last_update: string;
  readonly closed: boolean;
  readonly countries: readonly string[];
  readonly centroid: readonly [number, number];
}

export type CemsListParse =
  | {
      readonly ok: true;
      readonly entries: readonly CemsListEntry[];
      /** Entries that were not wildfires. */
      readonly otherCategory: number;
      /** Entries that did not parse. */
      readonly skipped: number;
      /** Whether the API says another page follows. */
      readonly hasNext: boolean;
    }
  | { readonly ok: false; readonly reason: string };

export type CemsDetailParse =
  | { readonly ok: true; readonly restricted: boolean; readonly aois: readonly CemsBox[] }
  | { readonly ok: false; readonly reason: string };

export function parseCemsList(body: string): CemsListParse {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'the activation list is not JSON' };
  }
  if (!isRecord(raw) || !Array.isArray(raw['results'])) {
    return { ok: false, reason: 'the activation list has no results array' };
  }
  const next = raw['next'];
  if (next !== null && typeof next !== 'string') {
    return { ok: false, reason: 'the activation list has a malformed next link' };
  }
  const entries: CemsListEntry[] = [];
  let otherCategory = 0;
  let skipped = 0;
  for (const item of raw['results']) {
    if (isRecord(item) && item['category'] !== 'Wildfire') {
      otherCategory += 1;
      continue;
    }
    const entry = parseListEntry(item);
    if (entry === null) skipped += 1;
    else entries.push(entry);
  }
  return { ok: true, entries, otherCategory, skipped, hasNext: next !== null };
}

function parseListEntry(item: unknown): CemsListEntry | null {
  if (!isRecord(item)) return null;
  const { code, name, closed, countries } = item;
  if (typeof code !== 'string' || !CEMS_CODE_RE.test(code)) return null;
  if (typeof name !== 'string' || typeof closed !== 'boolean') return null;
  if (!Array.isArray(countries) || !countries.every((c) => typeof c === 'string')) return null;
  const eventTime = cemsInstant(item['eventTime']);
  const activationTime = cemsInstant(item['activationTime']);
  const lastUpdate = cemsInstant(item['lastUpdate']);
  if (eventTime === null || activationTime === null || lastUpdate === null) return null;
  const centroid = parseWktPoint(item['centroid']);
  if (centroid === null) return null;
  return {
    code,
    name: name.trim(),
    event_time: eventTime,
    activation_time: activationTime,
    last_update: lastUpdate,
    closed,
    countries: countries,
    centroid,
  };
}

/**
 * One activation's detail. `restricted` when the activation is flagged sensitive (its AOIs
 * are then not kept even if present). A detail whose code is not the one asked for, or an
 * AOI whose extent does not parse, fails the whole detail — a partial AOI set would match
 * some events and silently miss others.
 */
export function parseCemsDetail(body: string, code: string): CemsDetailParse {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: `the ${code} detail is not JSON` };
  }
  if (!isRecord(raw) || !Array.isArray(raw['results'])) {
    return { ok: false, reason: `the ${code} detail has no results array` };
  }
  const result: unknown = raw['results'].find(
    (entry: unknown) => isRecord(entry) && entry['code'] === code,
  );
  if (!isRecord(result)) return { ok: false, reason: `the ${code} detail does not describe it` };
  if (result['sensitive'] === true) return { ok: true, restricted: true, aois: [] };
  const rawAois = result['aois'];
  if (!Array.isArray(rawAois)) return { ok: false, reason: `the ${code} detail has no AOI list` };
  const aois: CemsBox[] = [];
  for (const aoi of rawAois) {
    const box = isRecord(aoi) ? wktBox(aoi['extent']) : null;
    if (box === null) return { ok: false, reason: `an AOI of ${code} has no readable extent` };
    aois.push(box);
  }
  return { ok: true, restricted: false, aois };
}

const NAIVE_INSTANT_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|\+00:00)?$/;

/** A Copernicus instant as explicit UTC (see the module note), or `null`. */
export function cemsInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = NAIVE_INSTANT_RE.exec(value);
  if (match === null) return null;
  const fraction = match[2] === undefined ? '' : `.${match[2].slice(0, 3).padEnd(3, '0')}`;
  const iso = `${match[1] ?? ''}${fraction === '.000' ? '' : fraction}Z`;
  return isCemsInstant(iso) ? iso : null;
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?`;
const POINT_RE = new RegExp(String.raw`^POINT\s*\(\s*(${NUMBER})\s+(${NUMBER})\s*\)$`);

export function parseWktPoint(value: unknown): readonly [number, number] | null {
  if (typeof value !== 'string') return null;
  const match = POINT_RE.exec(value.trim());
  if (match === null) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  return validLonLat(lon, lat) ? [lon, lat] : null;
}

/** The bounding box of a WKT `POLYGON`/`MULTIPOLYGON`, rounded outward to 1e-4°. */
export function wktBox(value: unknown): CemsBox | null {
  if (typeof value !== 'string') return null;
  const match = /^(MULTIPOLYGON|POLYGON)\s*(\(.*\))$/s.exec(value.trim());
  if (match === null) return null;
  const inner = (match[2] ?? '').replace(/[()]/g, ' ');
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const vertex of inner.split(',')) {
    const parts = vertex.trim().split(/\s+/);
    if (parts.length < 2 || parts.length > 3) return null;
    if (!parts.every((part) => new RegExp(`^${NUMBER}$`).test(part))) return null;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!validLonLat(lon, lat)) return null;
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  if (!Number.isFinite(west)) return null;
  return [floor4(west), floor4(south), ceil4(east), ceil4(north)];
}

function floor4(value: number): number {
  return Math.floor(value * 1e4) / 1e4;
}

function ceil4(value: number): number {
  return Math.ceil(value * 1e4) / 1e4;
}

function validLonLat(lon: number, lat: number): boolean {
  return (
    Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
  );
}

/**
 * How far outside the served box an activation's centroid may lie and still have its
 * detail read: an activation centred in a neighbouring country can have an AOI that
 * reaches into coverage (EMSR822's three AOIs are 350 km apart).
 */
export const CEMS_CANDIDATE_BUFFER_KM = 100;

/** Whether the list entry is worth a detail read at all. */
export function isCemsCandidate(entry: CemsListEntry, coverage: BoundingBox): boolean {
  return inBox(entry.centroid, expandBboxKm(coverage, CEMS_CANDIDATE_BUFFER_KM));
}

/** Kept when the centroid is in coverage or any AOI box meets it. */
export function isCemsInCoverage(
  centroid: readonly [number, number],
  aois: readonly CemsBox[],
  coverage: BoundingBox,
): boolean {
  if (inBox(centroid, coverage)) return true;
  return aois.some(
    ([west, south, east, north]) =>
      west <= coverage.east &&
      east >= coverage.west &&
      south <= coverage.north &&
      north >= coverage.south,
  );
}

function inBox(point: readonly [number, number], box: BoundingBox): boolean {
  return (
    point[0] >= box.west && point[0] <= box.east && point[1] >= box.south && point[1] <= box.north
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
