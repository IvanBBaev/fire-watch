/**
 * The static hot-source mask (TASKS F16; 03-geodata §5.2.4, 11-data-science §3.6/§6.1/§6.2):
 * the asset's wire format, its parser, and the one lookup both tiers ask it.
 *
 * ## Why it lives in contracts
 *
 * Two readers ask the same question of the same file. The server's scorer asks "is every
 * detection of this event on a known hot source?" (the §3.6 hard override); the web's event
 * detail asks "is this event near one?" (an honest caveat, never a filter). If each tier had
 * its own point-in-polygon, a rounding or winding disagreement would make the map say
 * "near a solar park" about an event the scorer did not mask, or the reverse. One
 * implementation, platform-neutral, is the only way the two answers are about the same
 * geometry.
 *
 * ## The asset
 *
 * `web/src/assets/geodata/static-sources.json`, built by `pnpm run geodata:static-sources`
 * from OpenStreetMap (ODbL 1.0 — the file is a Derivative Database and carries the licence
 * and attribution in its header; docs/licenses/openstreetmap-static-sources.md). Every
 * coordinate is an integer at `scale` (1e-4°, about 11 m of latitude — finer than a
 * 375 m pixel by a factor of thirty, coarse enough to halve the bytes). A source is
 * `[kindIndex, lon0, lat0, dLon1, dLat1, …]`: the first vertex absolute, every later one a
 * delta from its predecessor. One vertex is a point (a flare, a plant too small to keep
 * three vertices); three or more are a ring, implicitly closed. A multipolygon's outer
 * rings are separate entries; inner rings are dropped, so a hole reads as masked — the
 * conservative direction for a mask whose only effect is a caveat or an override that
 * needs *every* detection inside.
 *
 * No OSM element id is carried: nothing here or downstream may key a record on one (the
 * collective-database boundary of docs/licenses/openstreetmap-basemap.md), and the
 * snapshot's `osm_base` plus response hash (docs/data/DATASETS.md DS-5) already pin every
 * element exactly.
 *
 * ## Distances
 *
 * No trigonometry, for the same reason as `server/src/core/clustering/geometry.ts`:
 * `Math.sin`/`Math.cos` are implementation-approximated, and a hit decided by the last bit
 * of a cosine is not a hit two engines agree on. Around the query point the plane is the
 * clustering metric's local tangent plane (km per degree of latitude, and of longitude
 * linear in latitude), evaluated once at the query's latitude; over the ≤ 5 km a query
 * reaches, that is well under a metre from the ellipsoid. Distances are returned in whole
 * metres, so a comparison against a radius is an integer comparison.
 */

/** The kinds, in the asset's index order. Adding one is a format change (`FORMAT`). */
export const STATIC_SOURCE_KINDS = ['solar', 'thermal_power', 'industrial', 'flare'] as const;
export type StaticSourceKind = (typeof STATIC_SOURCE_KINDS)[number];

/** The format tag the parser accepts. A different layout is a different tag. */
export const STATIC_SOURCE_FORMAT = 'fire-watch/static-sources@1';

/**
 * The web's caveat rule (F16 step 3): an event whose point lies within this many metres
 * of any source gets "may not be a fire" in its detail. Display only — it hides nothing
 * and does not touch the score. One kilometre is about two and a half VIIRS pixels: close
 * enough that a hot pixel there plausibly *is* the plant, far enough to cover the
 * geolocation error of a single detection. A founder number, versioned so a change is
 * visible.
 */
export const STATIC_SOURCE_CAVEAT = Object.freeze({
  version: 'static_source_caveat_v1',
  radiusM: 1000,
});

/**
 * The local plane distances are measured on. Structurally the clustering metric
 * (`clustering_params_v1.metric`, server): the server passes that object itself; the web,
 * which cannot import server config, uses {@link STATIC_SOURCE_METRIC}, and a server test
 * pins the two to the same numbers.
 */
export interface LocalPlaneMetric {
  readonly referenceLatDeg: number;
  readonly kmPerDegreeLat: number;
  readonly kmPerDegreeLonAtReference: number;
  readonly kmPerDegreeLonPerDegreeLat: number;
}

/** `clustering_params_v1.metric`'s numbers (WGS-84 series at 42.7° N). */
export const STATIC_SOURCE_METRIC: LocalPlaneMetric = Object.freeze({
  referenceLatDeg: 42.7,
  kmPerDegreeLat: 111.085,
  kmPerDegreeLonAtReference: 81.936,
  kmPerDegreeLonPerDegreeLat: -1.3146,
});

/** Degrees; `lat` north, `lon` east. */
export interface LonLat {
  readonly lon: number;
  readonly lat: number;
}

export interface StaticSource {
  readonly kind: StaticSourceKind;
  /** One vertex: a point. Three or more: a ring, implicitly closed. */
  readonly vertices: readonly LonLat[];
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

export interface StaticSourceMask {
  /** The asset's own version string (the OSM snapshot it was cut from). */
  readonly version: string;
  readonly licence: string;
  readonly attribution: string;
  readonly sources: readonly StaticSource[];
  /** Grid cell → indexes into `sources`; see {@link GRID_DEG}. */
  readonly grid: ReadonlyMap<string, readonly number[]>;
}

/** Grid cell size of the lookup index, degrees. Any radius ≤ 5 km spans ≤ 3 cells. */
export const GRID_DEG = 0.1;

/** The largest radius a lookup may ask for. Keeps the grid walk bounded. */
export const MAX_LOOKUP_RADIUS_M = 5000;

/** The empty mask: what a caller holds when no asset is loaded. Nothing is near it. */
export const EMPTY_STATIC_SOURCE_MASK: StaticSourceMask = Object.freeze({
  version: 'none',
  licence: '',
  attribution: '',
  sources: Object.freeze([]),
  grid: new Map(),
});

export class StaticSourceFormatError extends Error {
  override readonly name = 'StaticSourceFormatError';
}

function fail(message: string): never {
  throw new StaticSourceFormatError(`static-sources asset: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) fail(`"${key}" must be a string`);
  return value;
}

function cellKey(lonCell: number, latCell: number): string {
  return `${String(lonCell)}:${String(latCell)}`;
}

function cellOf(degrees: number): number {
  return Math.floor(degrees / GRID_DEG);
}

/**
 * Parse and index the asset. Throws {@link StaticSourceFormatError} on anything malformed —
 * a mask that half-loaded would override some plants and not others with no one told.
 */
export function parseStaticSourceMask(json: unknown): StaticSourceMask {
  if (!isRecord(json)) fail('not an object');
  if (json['format'] !== STATIC_SOURCE_FORMAT) {
    fail(`format must be ${JSON.stringify(STATIC_SOURCE_FORMAT)}`);
  }
  const version = requireString(json, 'version');
  const licence = requireString(json, 'licence');
  const attribution = requireString(json, 'attribution');
  const scale = json['scale'];
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale <= 0) {
    fail('"scale" must be a positive integer');
  }
  const kinds = json['kinds'];
  if (
    !Array.isArray(kinds) ||
    kinds.length !== STATIC_SOURCE_KINDS.length ||
    kinds.some((kind, i) => kind !== STATIC_SOURCE_KINDS[i])
  ) {
    fail(`"kinds" must be ${JSON.stringify(STATIC_SOURCE_KINDS)}`);
  }
  const raw = json['sources'];
  if (!Array.isArray(raw)) fail('"sources" must be an array');

  const sources: StaticSource[] = [];
  const grid = new Map<string, number[]>();
  raw.forEach((entry: unknown, index) => {
    const where = `sources[${String(index)}]`;
    if (!Array.isArray(entry) || entry.length < 3) fail(`${where} is not a source`);
    const [kindIndex, ...coords] = entry as unknown[];
    const kind = typeof kindIndex === 'number' ? STATIC_SOURCE_KINDS[kindIndex] : undefined;
    if (kind === undefined) fail(`${where} has an unknown kind`);
    if (coords.length % 2 !== 0) fail(`${where} has an odd coordinate count`);
    const vertexCount = coords.length / 2;
    if (vertexCount === 2) fail(`${where} has two vertices: neither a point nor a ring`);
    const vertices: LonLat[] = [];
    let lonInt = 0;
    let latInt = 0;
    for (let i = 0; i < coords.length; i += 2) {
      const dLon = coords[i];
      const dLat = coords[i + 1];
      if (!Number.isSafeInteger(dLon) || !Number.isSafeInteger(dLat)) {
        fail(`${where} has a non-integer coordinate`);
      }
      lonInt += dLon as number;
      latInt += dLat as number;
      const lon = lonInt / scale;
      const lat = latInt / scale;
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) fail(`${where} is off the globe`);
      vertices.push({ lon, lat });
    }
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const v of vertices) {
      minLon = Math.min(minLon, v.lon);
      minLat = Math.min(minLat, v.lat);
      maxLon = Math.max(maxLon, v.lon);
      maxLat = Math.max(maxLat, v.lat);
    }
    const at = sources.length;
    sources.push({ kind, vertices, minLon, minLat, maxLon, maxLat });
    for (let x = cellOf(minLon); x <= cellOf(maxLon); x += 1) {
      for (let y = cellOf(minLat); y <= cellOf(maxLat); y += 1) {
        const key = cellKey(x, y);
        const bucket = grid.get(key);
        if (bucket === undefined) grid.set(key, [at]);
        else bucket.push(at);
      }
    }
  });
  return { version, licence, attribution, sources, grid };
}

function kmPerDegreeLonAt(lat: number, metric: LocalPlaneMetric): number {
  return (
    metric.kmPerDegreeLonAtReference +
    metric.kmPerDegreeLonPerDegreeLat * (lat - metric.referenceLatDeg)
  );
}

/**
 * Is `point` inside the ring (even–odd rule, in degrees)? A linear rescaling of the axes
 * cannot change the answer, so the ring is tested unprojected. A point exactly on an edge
 * may go either way here; {@link staticSourceDistanceM} does not care, because a point on
 * an edge is at distance 0 from it anyway.
 */
export function pointInRing(point: LonLat, ring: readonly LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    if (a.lat > point.lat !== b.lat > point.lat) {
      const crossLon = a.lon + ((point.lat - a.lat) * (b.lon - a.lon)) / (b.lat - a.lat);
      if (point.lon < crossLon) inside = !inside;
    }
  }
  return inside;
}

/**
 * Distance in whole metres from `point` to the source: 0 inside a ring or on its edge,
 * else to the nearest edge (or to the point). Measured on the local plane at `point`'s
 * latitude — `+ − × ÷ sqrt` only.
 */
export function staticSourceDistanceM(
  source: StaticSource,
  point: LonLat,
  metric: LocalPlaneMetric,
): number {
  const { vertices } = source;
  if (vertices.length >= 3 && pointInRing(point, vertices)) return 0;
  const kx = kmPerDegreeLonAt(point.lat, metric) * 1000;
  const ky = metric.kmPerDegreeLat * 1000;
  const project = (v: LonLat): readonly [number, number] => [
    (v.lon - point.lon) * kx,
    (v.lat - point.lat) * ky,
  ];
  let best = Infinity;
  if (vertices.length === 1) {
    const only = vertices[0];
    if (only === undefined) return Infinity;
    const [x, y] = project(only);
    best = x * x + y * y;
  } else {
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
      const a = vertices[j];
      const b = vertices[i];
      if (a === undefined || b === undefined) continue;
      const [ax, ay] = project(a);
      const [bx, by] = project(b);
      const ex = bx - ax;
      const ey = by - ay;
      const length2 = ex * ex + ey * ey;
      // The segment's closest point to the origin (the query), clamped to the segment.
      const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * ex + ay * ey) / length2));
      const cx = ax + t * ex;
      const cy = ay + t * ey;
      best = Math.min(best, cx * cx + cy * cy);
    }
  }
  return Math.round(Math.sqrt(best));
}

export interface StaticSourceHit {
  readonly source: StaticSource;
  readonly distanceM: number;
}

/**
 * Every source of an allowed kind within `radiusM` of `point`, nearest first; ties on
 * distance go to the earlier source in the asset, so the order is a function of the file,
 * never of the grid's iteration order.
 */
export function staticSourcesWithin(
  mask: StaticSourceMask,
  point: LonLat,
  radiusM: number,
  metric: LocalPlaneMetric,
  kinds: readonly StaticSourceKind[] = STATIC_SOURCE_KINDS,
): readonly StaticSourceHit[] {
  if (!(radiusM >= 0) || radiusM > MAX_LOOKUP_RADIUS_M) {
    throw new RangeError(
      `radius must be within [0, ${String(MAX_LOOKUP_RADIUS_M)}] m, got ${String(radiusM)}`,
    );
  }
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return [];
  if (mask.sources.length === 0) return [];
  // Degrees the radius spans, with a generous margin: the grid only has to over-select.
  const kmLon = kmPerDegreeLonAt(point.lat, metric);
  const dLat = (radiusM / 1000 / metric.kmPerDegreeLat) * 1.5 + 1e-9;
  const dLon = (radiusM / 1000 / Math.max(kmLon, 1)) * 1.5 + 1e-9;
  const candidates = new Set<number>();
  for (let x = cellOf(point.lon - dLon); x <= cellOf(point.lon + dLon); x += 1) {
    for (let y = cellOf(point.lat - dLat); y <= cellOf(point.lat + dLat); y += 1) {
      for (const index of mask.grid.get(cellKey(x, y)) ?? []) candidates.add(index);
    }
  }
  const hits: { readonly index: number; readonly hit: StaticSourceHit }[] = [];
  for (const index of candidates) {
    const source = mask.sources[index];
    if (source === undefined || !kinds.includes(source.kind)) continue;
    if (
      point.lon < source.minLon - dLon ||
      point.lon > source.maxLon + dLon ||
      point.lat < source.minLat - dLat ||
      point.lat > source.maxLat + dLat
    ) {
      continue;
    }
    const distanceM = staticSourceDistanceM(source, point, metric);
    if (distanceM <= radiusM) hits.push({ index, hit: { source, distanceM } });
  }
  hits.sort((a, b) => a.hit.distanceM - b.hit.distanceM || a.index - b.index);
  return hits.map((h) => h.hit);
}

/** The nearest of {@link staticSourcesWithin}, or `null`. */
export function nearestStaticSource(
  mask: StaticSourceMask,
  point: LonLat,
  radiusM: number,
  metric: LocalPlaneMetric,
  kinds: readonly StaticSourceKind[] = STATIC_SOURCE_KINDS,
): StaticSourceHit | null {
  return staticSourcesWithin(mask, point, radiusM, metric, kinds)[0] ?? null;
}
