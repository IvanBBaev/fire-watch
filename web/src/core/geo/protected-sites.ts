/**
 * Natura 2000 protected sites (V2-F1): the parser and index for the
 * `fire-watch/natura2000@1` asset, and the pure question the event detail asks of it —
 * "is this fire inside a protected site, or how near is the nearest one?".
 *
 * The asset is written by `infra/geodata/natura2000.ts` (its only writer; the format
 * constants are repeated there because that project compiles on Node built-ins alone). A
 * site is `[code, name, typeIndex, parts]`; a part is its outer ring then its holes; a ring
 * is `[lon0, lat0, dLon1, dLat1, …]` in integer `scale` units, implicitly closed.
 *
 * Distances use the local-plane metric the static hot-source mask uses
 * (`STATIC_SOURCE_METRIC`, `clustering_params_v1.metric`): `+ − × ÷ sqrt`, no trig, so the
 * same input gives the same metres on every engine. Inside a part and outside its holes
 * (even–odd) is distance 0.
 *
 * Pure: no I/O, no DOM. The UI module (`ui/protected-sites.ts`) fetches the asset and
 * owns the signals.
 */

import type { LocalPlaneMetric } from '@fire-watch/contracts';

export const PROTECTED_SITES_FORMAT = 'fire-watch/natura2000@1';
export const PROTECTED_SITE_TYPES = ['spa', 'sci', 'spa_sci'] as const;
export type ProtectedSiteType = (typeof PROTECTED_SITE_TYPES)[number];

/** Grid cell size of the lookup index, degrees. */
export const PROTECTED_SITES_GRID_DEG = 0.1;

/**
 * How far the event note looks for a site an event is not inside (V2-F1): beyond this the
 * note says nothing. 5 km is the static-source lookup's own ceiling and a day's run for a
 * wind-driven grass fire — near enough that a reader would want to know.
 */
export const PROTECTED_SITE_NEAR_M = 5000;

/** A ring as flat degrees: `[lon0, lat0, lon1, lat1, …]`, implicitly closed. */
export type FlatRing = readonly number[];

export interface ProtectedSitePart {
  readonly outer: FlatRing;
  readonly holes: readonly FlatRing[];
}

export interface ProtectedSite {
  readonly code: string;
  readonly name: string;
  readonly type: ProtectedSiteType;
  readonly parts: readonly ProtectedSitePart[];
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

export interface ProtectedSites {
  readonly version: string;
  readonly licence: string;
  readonly attribution: string;
  readonly sites: readonly ProtectedSite[];
  /** Grid cell → indexes into `sites` whose bounding box meets the cell. */
  readonly grid: ReadonlyMap<string, readonly number[]>;
}

export const EMPTY_PROTECTED_SITES: ProtectedSites = Object.freeze({
  version: 'none',
  licence: '',
  attribution: '',
  sites: Object.freeze([]),
  grid: new Map(),
});

export class ProtectedSitesFormatError extends Error {
  override readonly name = 'ProtectedSitesFormatError';
}

function fail(message: string): never {
  throw new ProtectedSitesFormatError(`natura2000 asset: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) fail(`"${key}" must be a string`);
  return value;
}

function cellOf(degrees: number): number {
  return Math.floor(degrees / PROTECTED_SITES_GRID_DEG);
}

function cellKey(lonCell: number, latCell: number): string {
  return `${String(lonCell)}:${String(latCell)}`;
}

function decodeRing(raw: unknown, scale: number, where: string): number[] {
  if (!Array.isArray(raw) || raw.length < 6 || raw.length % 2 !== 0) {
    fail(`${where} is not a ring of three or more vertices`);
  }
  const out: number[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < raw.length; i += 2) {
    const dx: unknown = raw[i];
    const dy: unknown = raw[i + 1];
    if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy)) {
      fail(`${where} has a non-integer coordinate`);
    }
    x += dx as number;
    y += dy as number;
    const lon = x / scale;
    const lat = y / scale;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) fail(`${where} is off the globe`);
    out.push(lon, lat);
  }
  return out;
}

/**
 * Parse and index the asset. Throws {@link ProtectedSitesFormatError} on anything
 * malformed — a half-read asset would name some sites and silently miss others.
 */
export function parseProtectedSites(json: unknown): ProtectedSites {
  if (!isRecord(json)) fail('not an object');
  if (json['format'] !== PROTECTED_SITES_FORMAT) {
    fail(`format must be ${JSON.stringify(PROTECTED_SITES_FORMAT)}`);
  }
  const version = requireString(json, 'version');
  const licence = requireString(json, 'licence');
  const attribution = requireString(json, 'attribution');
  const scale = json['scale'];
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale <= 0) {
    fail('"scale" must be a positive integer');
  }
  const types = json['types'];
  if (
    !Array.isArray(types) ||
    types.length !== PROTECTED_SITE_TYPES.length ||
    types.some((type, i) => type !== PROTECTED_SITE_TYPES[i])
  ) {
    fail(`"types" must be ${JSON.stringify(PROTECTED_SITE_TYPES)}`);
  }
  const raw = json['sites'];
  if (!Array.isArray(raw)) fail('"sites" must be an array');
  const sites: ProtectedSite[] = [];
  const grid = new Map<string, number[]>();
  raw.forEach((entry: unknown, index) => {
    const where = `sites[${String(index)}]`;
    if (!Array.isArray(entry) || entry.length !== 4) fail(`${where} is not a site`);
    const [code, name, typeIndex, rawParts] = entry as unknown[];
    if (typeof code !== 'string' || code.length === 0) fail(`${where} has no code`);
    if (typeof name !== 'string' || name.length === 0) fail(`${where} has no name`);
    const type = typeof typeIndex === 'number' ? PROTECTED_SITE_TYPES[typeIndex] : undefined;
    if (type === undefined) fail(`${where} has an unknown type`);
    if (!Array.isArray(rawParts) || rawParts.length === 0) fail(`${where} has no parts`);
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    const parts = rawParts.map((rawPart: unknown, p) => {
      if (!Array.isArray(rawPart) || rawPart.length === 0) fail(`${where} part ${String(p)}`);
      const [outer, ...holes] = rawPart.map((ring: unknown, r) =>
        decodeRing(ring, scale, `${where} part ${String(p)} ring ${String(r)}`),
      ) as [number[], ...number[][]];
      for (let i = 0; i < outer.length; i += 2) {
        const lon = outer[i] as number;
        const lat = outer[i + 1] as number;
        minLon = Math.min(minLon, lon);
        maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
      }
      return { outer, holes };
    });
    const at = sites.length;
    sites.push({ code, name, type, parts, minLon, minLat, maxLon, maxLat });
    for (let x = cellOf(minLon); x <= cellOf(maxLon); x += 1) {
      for (let y = cellOf(minLat); y <= cellOf(maxLat); y += 1) {
        const key = cellKey(x, y);
        const bucket = grid.get(key);
        if (bucket === undefined) grid.set(key, [at]);
        else bucket.push(at);
      }
    }
  });
  return { version, licence, attribution, sites, grid };
}

/** Even–odd test against a flat ring, in degrees (a linear rescale cannot change it). */
export function pointInFlatRing(lon: number, lat: number, ring: FlatRing): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const ax = ring[i] as number;
    const ay = ring[i + 1] as number;
    const bx = ring[j] as number;
    const by = ring[j + 1] as number;
    if (ay > lat !== by > lat) {
      const crossLon = ax + ((lat - ay) * (bx - ax)) / (by - ay);
      if (lon < crossLon) inside = !inside;
    }
  }
  return inside;
}

/** Inside the site: inside one part's outer ring and outside all of that part's holes. */
export function pointInSite(lon: number, lat: number, site: ProtectedSite): boolean {
  if (lon < site.minLon || lon > site.maxLon || lat < site.minLat || lat > site.maxLat) {
    return false;
  }
  return site.parts.some(
    (part) =>
      pointInFlatRing(lon, lat, part.outer) &&
      !part.holes.some((hole) => pointInFlatRing(lon, lat, hole)),
  );
}

function kmPerDegreeLonAt(lat: number, metric: LocalPlaneMetric): number {
  return (
    metric.kmPerDegreeLonAtReference +
    metric.kmPerDegreeLonPerDegreeLat * (lat - metric.referenceLatDeg)
  );
}

/** Squared metres from the origin to segment a–b, both already on the local plane. */
function segment2(ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const length2 = ex * ex + ey * ey;
  const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * ex + ay * ey) / length2));
  const dx = ax + t * ex;
  const dy = ay + t * ey;
  return dx * dx + dy * dy;
}

/**
 * Whole metres from a point to the site: 0 inside it, else to the nearest edge of any
 * ring (a hole's edge counts — a point in a hole is outside, and its nearest boundary may
 * be the hole's).
 */
export function protectedSiteDistanceM(
  site: ProtectedSite,
  lon: number,
  lat: number,
  metric: LocalPlaneMetric,
): number {
  if (pointInSite(lon, lat, site)) return 0;
  const kx = kmPerDegreeLonAt(lat, metric) * 1000;
  const ky = metric.kmPerDegreeLat * 1000;
  let best = Infinity;
  for (const part of site.parts) {
    for (const ring of [part.outer, ...part.holes]) {
      const n = ring.length;
      for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
        const d = segment2(
          ((ring[j] as number) - lon) * kx,
          ((ring[j + 1] as number) - lat) * ky,
          ((ring[i] as number) - lon) * kx,
          ((ring[i + 1] as number) - lat) * ky,
        );
        if (d < best) best = d;
      }
    }
  }
  return Math.round(Math.sqrt(best));
}

/** Indexes of the sites whose bounding box meets the box `radiusM` around the point. */
function candidates(
  sites: ProtectedSites,
  lon: number,
  lat: number,
  radiusM: number,
  metric: LocalPlaneMetric,
): number[] {
  const dLon = radiusM / 1000 / kmPerDegreeLonAt(lat, metric);
  const dLat = radiusM / 1000 / metric.kmPerDegreeLat;
  const found = new Set<number>();
  for (let x = cellOf(lon - dLon); x <= cellOf(lon + dLon); x += 1) {
    for (let y = cellOf(lat - dLat); y <= cellOf(lat + dLat); y += 1) {
      for (const index of sites.grid.get(cellKey(x, y)) ?? []) found.add(index);
    }
  }
  return [...found]
    .filter((index) => {
      const site = sites.sites[index] as ProtectedSite;
      return (
        site.maxLon >= lon - dLon &&
        site.minLon <= lon + dLon &&
        site.maxLat >= lat - dLat &&
        site.minLat <= lat + dLat
      );
    })
    .sort((a, b) => a - b);
}

/** Codes compare as strings; ties are broken by code so the answer never flickers. */
function byCode(a: ProtectedSite, b: ProtectedSite): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/** What the event note says about protected sites. */
export type ProtectedSiteRelation =
  | {
      readonly relation: 'inside';
      readonly site: ProtectedSite;
      /** Positions inside this site, and how many were asked about (1 for the centre). */
      readonly inside: number;
      readonly total: number;
    }
  | { readonly relation: 'near'; readonly site: ProtectedSite; readonly distanceM: number };

/**
 * The event's relation to the Natura 2000 network (V2-F1), from its detections' positions
 * (or, with none, from its centre — pass it as the one position):
 *
 * - any position inside a site → `inside` the site holding the most positions (ties by
 *   code), with the count, so "3 of 5 detections" can be said honestly;
 * - otherwise the nearest site within `radiusM` of any position → `near`, with the
 *   smallest distance (ties by code);
 * - otherwise, or with no positions or no sites loaded, `null`.
 */
export function protectedSiteRelation(
  sites: ProtectedSites,
  positions: readonly { readonly lon: number; readonly lat: number }[],
  metric: LocalPlaneMetric,
  radiusM: number = PROTECTED_SITE_NEAR_M,
): ProtectedSiteRelation | null {
  if (positions.length === 0 || sites.sites.length === 0) return null;
  const insideCounts = new Map<number, number>();
  let nearest: { index: number; distanceM: number } | null = null;
  for (const { lon, lat } of positions) {
    for (const index of candidates(sites, lon, lat, radiusM, metric)) {
      const site = sites.sites[index] as ProtectedSite;
      const distanceM = protectedSiteDistanceM(site, lon, lat, metric);
      if (distanceM === 0) {
        insideCounts.set(index, (insideCounts.get(index) ?? 0) + 1);
      } else if (
        distanceM <= radiusM &&
        (nearest === null ||
          distanceM < nearest.distanceM ||
          (distanceM === nearest.distanceM &&
            byCode(site, sites.sites[nearest.index] as ProtectedSite) < 0))
      ) {
        nearest = { index, distanceM };
      }
    }
  }
  if (insideCounts.size > 0) {
    let best: { site: ProtectedSite; inside: number } | null = null;
    for (const [index, inside] of insideCounts) {
      const site = sites.sites[index] as ProtectedSite;
      if (
        best === null ||
        inside > best.inside ||
        (inside === best.inside && byCode(site, best.site) < 0)
      ) {
        best = { site, inside };
      }
    }
    if (best !== null) {
      return { relation: 'inside', site: best.site, inside: best.inside, total: positions.length };
    }
  }
  if (nearest === null) return null;
  return {
    relation: 'near',
    site: sites.sites[nearest.index] as ProtectedSite,
    distanceM: nearest.distanceM,
  };
}

/** What the map layer draws: one MultiPolygon feature per site. */
export interface ProtectedSitesGeoJson {
  readonly type: 'FeatureCollection';
  readonly features: readonly {
    readonly type: 'Feature';
    readonly properties: { readonly code: string; readonly name: string; readonly type: string };
    readonly geometry: {
      readonly type: 'MultiPolygon';
      readonly coordinates: readonly (readonly (readonly (readonly [number, number])[])[])[];
    };
  }[];
}

/** The sites as GeoJSON for the map layer. */
export function protectedSitesGeoJson(sites: ProtectedSites): ProtectedSitesGeoJson {
  const ring = (flat: FlatRing): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i] as number, flat[i + 1] as number]);
    const first = out[0];
    if (first !== undefined) out.push(first);
    return out;
  };
  return {
    type: 'FeatureCollection',
    features: sites.sites.map((site) => ({
      type: 'Feature' as const,
      properties: { code: site.code, name: site.name, type: site.type },
      geometry: {
        type: 'MultiPolygon' as const,
        coordinates: site.parts.map((part) => [ring(part.outer), ...part.holes.map(ring)]),
      },
    })),
  };
}
