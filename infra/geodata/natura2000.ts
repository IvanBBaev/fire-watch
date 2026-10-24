/**
 * The Natura 2000 protected-site transform (V2-F1): the EEA Natura 2000 map service's
 * GeoJSON pages in, the compact `fire-watch/natura2000@1` asset out.
 *
 * Pure: no I/O, no clock, no randomness — the same pages always yield the same bytes, so a
 * refresh's diff is exactly what changed in the EEA release. The CLI
 * (`natura2000-cli.ts`) owns the download, the cache, the hashes and the file.
 *
 * The wire format is parsed by `web/src/core/geo/protected-sites.ts`; this module is its
 * only writer. It does not import from the web because this project compiles on its own
 * (`infra/geodata/tsconfig.json`, Node built-ins only), so the format constants are
 * repeated there and a web test parses the committed asset.
 *
 * What is kept, and why:
 *
 * - **Sites.** Every Natura 2000 site whose geometry meets the served box — SPAs (Birds
 *   Directive, `SITETYPE` A), SCIs/SACs (Habitats Directive, B) and sites that are both
 *   (C). Code, name and type only: the event note names the site and nothing else.
 * - **Geometry.** Each ring is clipped to the served box (Sutherland–Hodgman), rounded to
 *   `SCALE` (1e-3°, ~110 m) and simplified with Douglas–Peucker at `SIMPLIFY_UNITS` of that
 *   grid. Outer rings are wound counter-clockwise and holes clockwise (lon/lat, y up), so
 *   MapLibre's ring classification reads the holes as holes.
 * - **Nothing silently disappears.** A part or hole smaller than `MIN_AREA_UNITS2` is
 *   dropped (a sliver a VIIRS pixel cannot resolve), but a site always keeps its largest
 *   part, however small, so every site in the box can still be named.
 */

export const FORMAT = 'fire-watch/natura2000@1';

/** Site types, by index in the asset: `SITETYPE` A, B and C. */
export const SITE_TYPES = ['spa', 'sci', 'spa_sci'] as const;
export type SiteType = (typeof SITE_TYPES)[number];

const SITETYPE_CODES: Readonly<Record<string, SiteType>> = { A: 'spa', B: 'sci', C: 'spa_sci' };

/** The served box (W S E N), degrees — the same box the ingest filters to. */
export const SERVED_BBOX = [20, 39, 31, 46] as const;

/** Integer coordinate grid: 1e-3 degrees (~111 m of latitude, ~80 m of longitude at 43°N). */
export const SCALE = 1000;

/**
 * Douglas–Peucker tolerance, in `SCALE` units (2 → ~220 m of latitude): below a VIIRS
 * pixel's 375 m, and under the 0.1 km the event note rounds a distance to only at its
 * worst, which a shape's boundary — drawn on 1:100 000 maps — never carried anyway.
 */
export const SIMPLIFY_UNITS = 2;

/** Parts and holes smaller than this, in `SCALE` units² (~0.07 km² at 43°N), are dropped. */
export const MIN_AREA_UNITS2 = 8;

/** The map service's layer 2 ("Natura 2000 sites"), the one every page is read from. */
export const SERVICE_URL =
  'https://bio.discomap.eea.europa.eu/arcgis/rest/services/ProtectedSites/Natura2000Sites/MapServer';
export const SITES_LAYER = 2;
export const PAGE_SIZE = 100;

/** The query URL for one page; the order is fixed so the paging is stable. */
export function pageUrl(offset: number): string {
  const [w, s, e, n] = SERVED_BBOX;
  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${String(w)},${String(s)},${String(e)},${String(n)}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'SITECODE,SITENAME,SITETYPE,MS,RELEASE_DATE',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    orderByFields: 'SITECODE',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
  });
  return `${SERVICE_URL}/${String(SITES_LAYER)}/query?${params.toString()}`;
}

type Position = readonly number[];

export interface SiteFeature {
  readonly properties: {
    readonly SITECODE: string;
    readonly SITENAME: string;
    readonly SITETYPE: string;
    readonly MS?: string;
    readonly RELEASE_DATE?: number | null;
  };
  readonly geometry:
    | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly Position[])[] }
    | {
        readonly type: 'MultiPolygon';
        readonly coordinates: readonly (readonly (readonly Position[])[])[];
      }
    | null;
}

export interface Provenance {
  readonly source: string;
  /** The dataset's release as the service describes it (e.g. `2024`). */
  readonly release: string;
  /** SHA-256 over the page bodies, in page order. */
  readonly pagesSha256: string;
}

/** One ring: `[lon0, lat0, dLon1, dLat1, …]` in `SCALE` units, without the closing vertex. */
export type EncodedRing = readonly number[];
/** One part: the outer ring, then its holes. */
export type EncodedPolygon = readonly EncodedRing[];
/** One site: `[code, name, typeIndex, parts]`. */
export type EncodedSite = readonly [string, string, number, readonly EncodedPolygon[]];

export interface Natura2000Asset {
  readonly format: typeof FORMAT;
  readonly version: string;
  readonly licence: 'CC-BY-4.0';
  readonly attribution: string;
  readonly source: string;
  readonly release: string;
  readonly release_date: string | null;
  readonly pages_sha256: string;
  readonly bbox: typeof SERVED_BBOX;
  readonly scale: number;
  readonly types: typeof SITE_TYPES;
  readonly counts: Readonly<Record<SiteType, number>>;
  readonly dropped: { readonly outside: number; readonly parts: number; readonly holes: number };
  readonly sites: readonly EncodedSite[];
}

export const ATTRIBUTION = 'Natura 2000 sites © European Environment Agency (EEA), CC BY 4.0';

type Pt = readonly [number, number];
type IntPoint = readonly [number, number];

function clipEdge(
  points: readonly Pt[],
  inside: (p: Pt) => boolean,
  cross: (a: Pt, b: Pt) => Pt,
): Pt[] {
  const out: Pt[] = [];
  let previous = points[points.length - 1];
  if (previous === undefined) return out;
  for (const p of points) {
    if (inside(p)) {
      if (!inside(previous)) out.push(cross(previous, p));
      out.push(p);
    } else if (inside(previous)) {
      out.push(cross(previous, p));
    }
    previous = p;
  }
  return out;
}

/** Sutherland–Hodgman clip of a ring (closing vertex optional) to the served box. */
export function clipRing(ring: readonly Pt[]): Pt[] {
  const [w, s, e, n] = SERVED_BBOX;
  const atX =
    (x: number) =>
    (a: Pt, b: Pt): Pt => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const atY =
    (y: number) =>
    (a: Pt, b: Pt): Pt => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
  let r: Pt[] = [...ring];
  r = clipEdge(r, (p) => p[0] >= w, atX(w));
  r = clipEdge(r, (p) => p[0] <= e, atX(e));
  r = clipEdge(r, (p) => p[1] >= s, atY(s));
  r = clipEdge(r, (p) => p[1] <= n, atY(n));
  return r;
}

function samePoint(a: IntPoint, b: IntPoint): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Round to the grid, drop repeats and the closing duplicate. */
function quantize(ring: readonly Pt[]): IntPoint[] {
  const out: IntPoint[] = [];
  for (const [x, y] of ring) {
    const p: IntPoint = [Math.round(x * SCALE), Math.round(y * SCALE)];
    const last = out[out.length - 1];
    if (last === undefined || !samePoint(last, p)) out.push(p);
  }
  while (out.length > 1 && samePoint(out[0] as IntPoint, out[out.length - 1] as IntPoint)) {
    out.pop();
  }
  return out;
}

/** Squared distance from `p` to segment `a`–`b`, in grid units². */
function segmentDistance2(p: IntPoint, a: IntPoint, b: IntPoint): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const length2 = ex * ex + ey * ey;
  const t =
    length2 === 0
      ? 0
      : Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / length2));
  const dx = a[0] + t * ex - p[0];
  const dy = a[1] + t * ey - p[1];
  return dx * dx + dy * dy;
}

/** Douglas–Peucker on an open polyline; keeps both ends. Iterative, so no stack depth. */
export function simplifyLine(points: readonly IntPoint[], tolerance: number): IntPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  const tolerance2 = tolerance * tolerance;
  while (stack.length > 0) {
    const [from, to] = stack.pop() as [number, number];
    const a = points[from] as IntPoint;
    const b = points[to] as IntPoint;
    let worst = -1;
    let worstAt = -1;
    for (let i = from + 1; i < to; i += 1) {
      const d = segmentDistance2(points[i] as IntPoint, a, b);
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    if (worstAt !== -1 && worst > tolerance2) {
      keep[worstAt] = true;
      stack.push([from, worstAt], [worstAt, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Simplify a ring given without its closing vertex. It is cut at vertex 0 and at the vertex
 * farthest from it, and each half is simplified as a line, so the ring's extent survives.
 */
export function simplifyRing(ring: readonly IntPoint[], tolerance: number): IntPoint[] {
  if (ring.length <= 3) return [...ring];
  const first = ring[0] as IntPoint;
  let far = 1;
  let farD = -1;
  ring.forEach((p, i) => {
    const d = (p[0] - first[0]) ** 2 + (p[1] - first[1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  });
  const left = simplifyLine(ring.slice(0, far + 1), tolerance);
  const right = simplifyLine([...ring.slice(far), first], tolerance);
  return [...left, ...right.slice(1, -1)];
}

/** Signed shoelace area in grid units²; positive when counter-clockwise (y up). */
export function signedArea(ring: readonly IntPoint[]): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i === 0 ? ring.length - 1 : i - 1] as IntPoint;
    const b = ring[i] as IntPoint;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return twice / 2;
}

/**
 * Clip, quantize and simplify. `null` when nothing of the ring lies in the box; otherwise
 * the simplified ring, or — when simplification collapses it — `collapsed: true` with the
 * smallest honest stand-in (the quantized ring, else one grid cell at its first vertex),
 * which the size rule keeps only as a site's last part.
 */
function prepareRing(
  ring: readonly Position[],
): { readonly ring: IntPoint[]; readonly collapsed: boolean } | null {
  const clipped = clipRing(ring.map((p) => [p[0] ?? 0, p[1] ?? 0] as Pt));
  if (clipped.length < 3) return null;
  const quantized = quantize(clipped);
  const simplified = simplifyRing(quantized, SIMPLIFY_UNITS);
  if (simplified.length >= 3 && signedArea(simplified) !== 0) {
    return { ring: simplified, collapsed: false };
  }
  if (quantized.length >= 3 && signedArea(quantized) !== 0) {
    return { ring: quantized, collapsed: true };
  }
  const [x, y] = quantized[0] ?? [0, 0];
  return {
    ring: [
      [x, y],
      [x + 1, y],
      [x + 1, y + 1],
      [x, y + 1],
    ],
    collapsed: true,
  };
}

/** Wind a ring counter-clockwise (`ccw`) or clockwise. */
function wound(ring: IntPoint[], ccw: boolean): IntPoint[] {
  return signedArea(ring) > 0 === ccw ? ring : [...ring].reverse();
}

function encodeRing(ring: readonly IntPoint[]): EncodedRing {
  const out: number[] = [];
  let previous: IntPoint = [0, 0];
  for (const p of ring) {
    out.push(p[0] - previous[0], p[1] - previous[1]);
    previous = p;
  }
  return out;
}

interface PreparedPart {
  readonly area: number;
  readonly rings: EncodedRing[];
}

/** One site's parts, after the size rule; empty when nothing of it lies in the box. */
export function prepareSite(feature: SiteFeature): {
  readonly parts: EncodedPolygon[];
  readonly droppedParts: number;
  readonly droppedHoles: number;
} {
  const geometry = feature.geometry;
  const polygons =
    geometry === null
      ? []
      : geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.coordinates;
  const parts: PreparedPart[] = [];
  let droppedHoles = 0;
  for (const polygon of polygons) {
    const [outerRaw, ...holesRaw] = polygon;
    if (outerRaw === undefined) continue;
    const outer = prepareRing(outerRaw);
    if (outer === null) continue;
    const rings: EncodedRing[] = [encodeRing(wound(outer.ring, true))];
    for (const holeRaw of holesRaw) {
      const hole = prepareRing(holeRaw);
      if (hole === null) continue;
      if (hole.collapsed || Math.abs(signedArea(hole.ring)) < MIN_AREA_UNITS2) {
        droppedHoles += 1;
        continue;
      }
      rings.push(encodeRing(wound(hole.ring, false)));
    }
    // A collapsed part ranks below every real one, so it is kept only as a site's last.
    const area = Math.abs(signedArea(outer.ring));
    parts.push({
      area: outer.collapsed ? Math.min(area, MIN_AREA_UNITS2) - MIN_AREA_UNITS2 : area,
      rings,
    });
  }
  if (parts.length === 0) return { parts: [], droppedParts: 0, droppedHoles };
  let largest = 0;
  parts.forEach((part, i) => {
    if (part.area > (parts[largest] as PreparedPart).area) largest = i;
  });
  const kept = parts.filter((part, i) => i === largest || part.area >= MIN_AREA_UNITS2);
  return {
    parts: kept.map((part) => part.rings),
    droppedParts: parts.length - kept.length,
    droppedHoles,
  };
}

/** Build the asset. Feature order across pages does not matter; the output is sorted. */
export function buildNatura2000(
  features: readonly SiteFeature[],
  provenance: Provenance,
): Natura2000Asset {
  const sorted = [...features].sort((a, b) =>
    a.properties.SITECODE < b.properties.SITECODE
      ? -1
      : a.properties.SITECODE > b.properties.SITECODE
        ? 1
        : 0,
  );
  const sites: EncodedSite[] = [];
  const counts = Object.fromEntries(SITE_TYPES.map((t) => [t, 0])) as Record<SiteType, number>;
  let outside = 0;
  let droppedParts = 0;
  let droppedHoles = 0;
  let latestRelease: number | null = null;
  const seen = new Set<string>();
  for (const feature of sorted) {
    const { SITECODE: code, SITENAME: name, SITETYPE: typeCode } = feature.properties;
    if (seen.has(code)) continue;
    seen.add(code);
    const type = SITETYPE_CODES[typeCode];
    if (type === undefined) throw new Error(`${code}: unknown SITETYPE "${typeCode}"`);
    const prepared = prepareSite(feature);
    droppedParts += prepared.droppedParts;
    droppedHoles += prepared.droppedHoles;
    if (prepared.parts.length === 0) {
      outside += 1;
      continue;
    }
    const released = feature.properties.RELEASE_DATE;
    if (typeof released === 'number' && (latestRelease === null || released > latestRelease)) {
      latestRelease = released;
    }
    counts[type] += 1;
    sites.push([code, name.trim(), SITE_TYPES.indexOf(type), prepared.parts]);
  }
  return {
    format: FORMAT,
    version: `natura2000_${provenance.release}`,
    licence: 'CC-BY-4.0',
    attribution: ATTRIBUTION,
    source: provenance.source,
    release: provenance.release,
    release_date:
      latestRelease === null ? null : new Date(latestRelease).toISOString().slice(0, 10),
    pages_sha256: provenance.pagesSha256,
    bbox: SERVED_BBOX,
    scale: SCALE,
    types: SITE_TYPES,
    counts,
    dropped: { outside, parts: droppedParts, holes: droppedHoles },
    sites,
  };
}

/**
 * Serialize with one site per line, so a yearly refresh diffs as added, removed and
 * re-drawn sites rather than as one changed line of half a megabyte.
 */
export function serializeNatura2000(asset: Natura2000Asset): string {
  const { sites, ...header } = asset;
  const head = JSON.stringify(header).slice(0, -1);
  const body = sites.map((s) => JSON.stringify(s)).join(',\n');
  return `${head},"sites":[\n${body}\n]}\n`;
}
