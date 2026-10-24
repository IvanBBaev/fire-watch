/**
 * The estimated outline of one event, drawn from its own VIIRS/MODIS detections (V2-A4).
 *
 * **What this is.** The union of the pixel footprints the satellites flagged, closed across
 * gaps narrower than two closing radii, with enclosed gaps filled. It is labelled
 * "estimated outline from satellite detections" everywhere it is shown: never an official
 * perimeter, never a statement about where the fire will go.
 *
 * **Why a raster.** The footprints are laid on the identity engine's planar metric
 * (`+ − × ÷ √` only, no trigonometry), rasterised on a fixed grid, closed with a square
 * structuring element, and traced back into rings along cell edges. Every step is integer
 * work on the grid or exactly specified IEEE arithmetic, so the same detections draw the
 * same bytes on every machine and every replay — the property the replay harness checks.
 *
 * **The area and its uncertainty.** The area is the count of covered cells. Its band is the
 * traced perimeter times the largest footprint half-extent used: an edge can sit anywhere
 * inside the pixel that put it there. A pixel is flagged when part of it burns, so the
 * whole band leans toward overstatement at the edges, and a burn the satellite did not see
 * is missing altogether; the copy says both.
 *
 * Simplifications, stated so the next reader can retune them: footprints are axis-aligned
 * rectangles (scan east–west, track north–south — true to within the orbit's inclination
 * over Bulgaria), and the plane's longitudinal scale is taken once, at the event's mean
 * latitude.
 */

import type { FireOutlineValues, OutlineFootprint } from '../config/fire-outline.js';
import { formatCanonicalDegrees } from '../clustering/geometry.js';

/** One member detection, as the outline needs it. Coordinates are the stored 5-dp values. */
export interface OutlineDetection {
  readonly uid: string;
  readonly sourceId: string;
  readonly lat: number;
  readonly lon: number;
  readonly scanKm: number | null;
  readonly trackKm: number | null;
}

/** GeoJSON MultiPolygon positions: polygons → rings → `[lon, lat]`. */
export type MultiPolygonCoordinates = readonly (readonly (readonly (readonly [
  number,
  number,
])[])[])[];

export interface OutlineGeometry {
  readonly type: 'MultiPolygon';
  readonly coordinates: MultiPolygonCoordinates;
}

export interface FireOutline {
  /** Null when no detection of the event came from a source that draws outlines. */
  readonly geometry: OutlineGeometry | null;
  readonly areaHa: number | null;
  readonly areaLowHa: number | null;
  readonly areaHighHa: number | null;
  /** How far any edge may sit from where it is drawn: the largest footprint half-extent used. */
  readonly edgeUncertaintyKm: number | null;
  /** Detections whose footprints were drawn. */
  readonly footprints: number;
}

export const EMPTY_OUTLINE: FireOutline = Object.freeze({
  geometry: null,
  areaHa: null,
  areaLowHa: null,
  areaHighHa: null,
  edgeUncertaintyKm: null,
  footprints: 0,
});

interface Rect {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/**
 * Draws the outline. Order of `detections` does not matter: they are sorted by uid first,
 * which is the only order the arithmetic below ever sees.
 */
export function drawFireOutline(
  detections: readonly OutlineDetection[],
  params: FireOutlineValues,
): FireOutline {
  const eligible = detections
    .filter((d) => footprintOf(d, params) !== null)
    .toSorted((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  if (eligible.length === 0) return EMPTY_OUTLINE;

  // The plane: origin at the south-west corner of the detections, one longitudinal scale
  // at their mean latitude.
  let lat0 = Infinity;
  let lon0 = Infinity;
  let latSum = 0;
  for (const d of eligible) {
    assertCoordinate(d);
    lat0 = Math.min(lat0, d.lat);
    lon0 = Math.min(lon0, d.lon);
    latSum += d.lat;
  }
  const meanLat = latSum / eligible.length;
  const metric = params.metric;
  const kLat = metric.kmPerDegreeLat;
  const kLon =
    metric.kmPerDegreeLonAtReference +
    metric.kmPerDegreeLonPerDegreeLat * (meanLat - metric.referenceLatDeg);

  let halfExtentMax = 0;
  const rects: Rect[] = eligible.map((d) => {
    const fp = footprintOf(d, params) as { scanKm: number; trackKm: number };
    const hx = fp.scanKm / 2;
    const hy = fp.trackKm / 2;
    halfExtentMax = Math.max(halfExtentMax, hx, hy);
    const cx = (d.lon - lon0) * kLon;
    const cy = (d.lat - lat0) * kLat;
    return { x0: cx - hx, x1: cx + hx, y0: cy - hy, y1: cy + hy };
  });

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x0);
    maxX = Math.max(maxX, r.x1);
    minY = Math.min(minY, r.y0);
    maxY = Math.max(maxY, r.y1);
  }

  // The grid: a margin of the closing radius plus two cells on every side, so the closing
  // never touches the border and the border is always background.
  const { cell, radius, nx, ny } = gridFor(maxX - minX, maxY - minY, params);
  const pad = radius + 2;
  const gx0 = minX - pad * cell;
  const gy0 = minY - pad * cell;

  const grid = new Uint8Array(nx * ny);
  for (const r of rects) {
    // Cell (i, j) is covered when its centre lies inside the footprint, edges included.
    const i0 = Math.max(0, Math.ceil((r.x0 - gx0) / cell - 0.5));
    const i1 = Math.min(nx - 1, Math.floor((r.x1 - gx0) / cell - 0.5));
    const j0 = Math.max(0, Math.ceil((r.y0 - gy0) / cell - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((r.y1 - gy0) / cell - 0.5));
    for (let j = j0; j <= j1; j += 1) {
      grid.fill(1, j * nx + i0, j * nx + i1 + 1);
    }
  }

  const closed = erode(dilate(grid, nx, ny, radius), nx, ny, radius);
  removeSaddles(closed, nx, ny);
  fillHoles(closed, nx, ny);

  let cells = 0;
  for (const v of closed) cells += v;
  if (cells === 0) return EMPTY_OUTLINE;

  const rings = traceRings(closed, nx, ny);
  let perimeterEdges = 0;
  for (const ring of rings) perimeterEdges += ring.edges;

  const polygons = rings
    .map((ring) => simplifyRing(dropCollinear(ring.vertices), params.maxVerticesPerRing))
    .map((vertices) =>
      dedupeConsecutive(
        vertices.map(([i, j]): Position => [
          Number(formatCanonicalDegrees(lon0 + (gx0 + i * cell) / kLon)),
          Number(formatCanonicalDegrees(lat0 + (gy0 + j * cell) / kLat)),
        ]),
      ),
    )
    .map((ring) => ({ ring, area: ring.length >= 3 ? signedArea(ring) : 0 }))
    .filter(({ area }) => area > 0)
    .toSorted((a, b) => b.area - a.area || compareRings(a.ring, b.ring))
    .slice(0, params.maxPolygons)
    .map(({ ring }) => [[...ring, ring[0] as Position]]);

  // Unreachable while a cell is far wider than the 5-dp grid, but an area without a shape
  // to show it on would be a number nobody can check.
  if (polygons.length === 0) return { ...EMPTY_OUTLINE, footprints: eligible.length };

  const areaKm2 = cells * cell * cell;
  const bandKm2 = perimeterEdges * cell * halfExtentMax;
  return {
    geometry: { type: 'MultiPolygon', coordinates: polygons },
    areaHa: roundHa(areaKm2 * 100),
    areaLowHa: roundHa(Math.max(0, areaKm2 - bandKm2) * 100),
    areaHighHa: roundHa((areaKm2 + bandKm2) * 100),
    edgeUncertaintyKm: Math.round(halfExtentMax * 1000) / 1000,
    footprints: eligible.length,
  };
}

function footprintOf(
  d: OutlineDetection,
  params: FireOutlineValues,
): { scanKm: number; trackKm: number } | null {
  const bySource: Readonly<Record<string, OutlineFootprint | null | undefined>> =
    params.footprintBySource;
  const rule = bySource[d.sourceId];
  if (rule === undefined || rule === null) return null;
  return {
    scanKm: positiveOr(d.scanKm, rule.defaultScanKm),
    trackKm: positiveOr(d.trackKm, rule.defaultTrackKm),
  };
}

function positiveOr(value: number | null, fallback: number): number {
  return value !== null && Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertCoordinate(d: OutlineDetection): void {
  if (!Number.isFinite(d.lat) || !Number.isFinite(d.lon)) {
    throw new RangeError(`detection ${d.uid} has a non-finite coordinate`);
  }
}

/** Tenths of a hectare: finer than any footprint can resolve, coarse enough to read. */
function roundHa(ha: number): number {
  return Math.round(ha * 10) / 10;
}

interface Grid {
  readonly cell: number;
  readonly radius: number;
  readonly nx: number;
  readonly ny: number;
}

/**
 * The finest cell (the configured one, doubled as often as needed) whose padded grid over
 * a `widthKm` × `heightKm` extent stays within `maxGridCells`.
 */
function gridFor(widthKm: number, heightKm: number, params: FireOutlineValues): Grid {
  for (let cell = params.cellKm; ; cell *= 2) {
    const radius = Math.ceil(params.closingKm / cell);
    const pad = radius + 2;
    const nx = Math.ceil(widthKm / cell) + 2 * pad;
    const ny = Math.ceil(heightKm / cell) + 2 * pad;
    if (nx * ny <= params.maxGridCells) return { cell, radius, nx, ny };
  }
}

/** Separable square max-filter (dilation) of the given radius, in cells. */
function dilate(src: Uint8Array, nx: number, ny: number, r: number): Uint8Array {
  return filter(src, nx, ny, r, (hits) => hits > 0);
}

/** Separable square min-filter (erosion); cells beyond the border count as background. */
function erode(src: Uint8Array, nx: number, ny: number, r: number): Uint8Array {
  const full = 2 * r + 1;
  return filter(src, nx, ny, r, (hits) => hits === full);
}

/**
 * One square morphological pass: a cell is set when `keep` accepts the number of set cells
 * in its window, rows first and then columns. Cells beyond the border count as unset, which
 * is exact here because the grid's margin keeps every footprint, dilated, off the border.
 */
function filter(
  src: Uint8Array,
  nx: number,
  ny: number,
  r: number,
  keep: (hits: number) => boolean,
): Uint8Array {
  if (r === 0) return src.slice();
  const pass = (
    from: Uint8Array,
    length: number,
    lines: number,
    at: (line: number, k: number) => number,
  ): Uint8Array => {
    const to = new Uint8Array(nx * ny);
    const prefix = new Int32Array(length + 1);
    for (let line = 0; line < lines; line += 1) {
      for (let k = 0; k < length; k += 1) {
        prefix[k + 1] = (prefix[k] as number) + (from[at(line, k)] as number);
      }
      for (let k = 0; k < length; k += 1) {
        const hits =
          (prefix[Math.min(length, k + r + 1)] as number) - (prefix[Math.max(0, k - r)] as number);
        if (keep(hits)) to[at(line, k)] = 1;
      }
    }
    return to;
  };
  const rows = pass(src, nx, ny, (j, i) => j * nx + i);
  return pass(rows, ny, nx, (i, j) => j * nx + i);
}

/**
 * Fills every 2×2 block whose set cells touch only diagonally. Afterwards 4- and
 * 8-connectivity agree for both the shape and the background, so every traced vertex has
 * exactly one way out and every ring is simple. Cells only ever turn on, so this ends.
 */
function removeSaddles(grid: Uint8Array, nx: number, ny: number): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let j = 0; j + 1 < ny; j += 1) {
      for (let i = 0; i + 1 < nx; i += 1) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        if (grid[a] === grid[d] && grid[b] === grid[c] && grid[a] !== grid[b]) {
          grid[a] = 1;
          grid[b] = 1;
          grid[c] = 1;
          grid[d] = 1;
          changed = true;
        }
      }
    }
  }
}

/** Sets every unset cell the border cannot reach: an outline has no holes. */
function fillHoles(grid: Uint8Array, nx: number, ny: number): void {
  const outside = new Uint8Array(nx * ny);
  const stack: number[] = [];
  const push = (k: number): void => {
    if (grid[k] === 0 && outside[k] === 0) {
      outside[k] = 1;
      stack.push(k);
    }
  };
  for (let i = 0; i < nx; i += 1) {
    push(i);
    push((ny - 1) * nx + i);
  }
  for (let j = 0; j < ny; j += 1) {
    push(j * nx);
    push(j * nx + nx - 1);
  }
  for (let k = stack.pop(); k !== undefined; k = stack.pop()) {
    const i = k % nx;
    if (i > 0) push(k - 1);
    if (i < nx - 1) push(k + 1);
    if (k >= nx) push(k - nx);
    if (k < (ny - 1) * nx) push(k + nx);
  }
  for (let k = 0; k < grid.length; k += 1) {
    if (outside[k] === 0) grid[k] = 1;
  }
}

type GridVertex = readonly [number, number];
type Position = readonly [number, number];

interface TracedRing {
  /** Grid vertices, counter-clockwise, not closed. */
  readonly vertices: readonly GridVertex[];
  /** Cell edges walked: the ring's length in cells. */
  readonly edges: number;
}

/**
 * Walks every boundary between a set cell and an unset one, the set cell on the left, so
 * outer rings come out counter-clockwise (RFC 7946 §3.1.6). Rings start at their lowest
 * row-major vertex, which fixes their bytes.
 */
function traceRings(grid: Uint8Array, nx: number, ny: number): TracedRing[] {
  const vx = nx + 1;
  const next = new Int32Array(vx * (ny + 1)).fill(-1);
  const isSet = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < nx && j < ny && grid[j * nx + i] === 1;
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      if (!isSet(i, j)) continue;
      if (!isSet(i, j - 1)) next[j * vx + i] = j * vx + i + 1;
      if (!isSet(i + 1, j)) next[j * vx + i + 1] = (j + 1) * vx + i + 1;
      if (!isSet(i, j + 1)) next[(j + 1) * vx + i + 1] = (j + 1) * vx + i;
      if (!isSet(i - 1, j)) next[(j + 1) * vx + i] = j * vx + i;
    }
  }
  const rings: TracedRing[] = [];
  for (let start = 0; start < next.length; start += 1) {
    if (next[start] === -1) continue;
    const vertices: GridVertex[] = [];
    let at = start;
    let edges = 0;
    do {
      vertices.push([at % vx, Math.floor(at / vx)]);
      const to = next[at] as number;
      next[at] = -1;
      at = to;
      edges += 1;
    } while (at !== start && at !== -1);
    rings.push({ vertices, edges });
  }
  return rings;
}

/** Drops vertices that sit on the straight line between their neighbours. */
function dropCollinear(ring: readonly GridVertex[]): GridVertex[] {
  const n = ring.length;
  const out: GridVertex[] = [];
  for (let k = 0; k < n; k += 1) {
    const [px, py] = ring[(k + n - 1) % n] as GridVertex;
    const [x, y] = ring[k] as GridVertex;
    const [qx, qy] = ring[(k + 1) % n] as GridVertex;
    if ((x - px) * (qy - y) - (y - py) * (qx - x) !== 0) out.push([x, y]);
  }
  return out;
}

/**
 * Douglas–Peucker on a closed ring, only when it is longer than `maxVertices`: the
 * tolerance starts at one cell and doubles until the ring fits. A ring that already fits
 * is returned as traced.
 */
function simplifyRing(ring: readonly GridVertex[], maxVertices: number): readonly GridVertex[] {
  if (ring.length <= maxVertices) return ring;
  let tolerance = 1;
  for (;;) {
    const simplified = douglasPeuckerClosed(ring, tolerance);
    if (simplified.length <= maxVertices || simplified.length <= 4) return simplified;
    tolerance *= 2;
  }
}

function douglasPeuckerClosed(ring: readonly GridVertex[], tolerance: number): GridVertex[] {
  // Split at the first vertex and the vertex farthest from it, then simplify both halves.
  const [fx, fy] = ring[0] as GridVertex;
  let far = 0;
  let farDistance = -1;
  for (let k = 1; k < ring.length; k += 1) {
    const [x, y] = ring[k] as GridVertex;
    const d = (x - fx) ** 2 + (y - fy) ** 2;
    if (d > farDistance) {
      farDistance = d;
      far = k;
    }
  }
  const keep = new Uint8Array(ring.length + 1);
  keep[0] = 1;
  keep[far] = 1;
  const closed: readonly GridVertex[] = [...ring, [fx, fy]];
  const stack: [number, number][] = [
    [0, far],
    [far, ring.length],
  ];
  for (let span = stack.pop(); span !== undefined; span = stack.pop()) {
    const [a, b] = span;
    const [ax, ay] = closed[a] as GridVertex;
    const [bx, by] = closed[b] as GridVertex;
    const length = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    let worst = -1;
    let worstDistance = tolerance;
    for (let k = a + 1; k < b; k += 1) {
      const [x, y] = closed[k] as GridVertex;
      const d =
        length === 0
          ? Math.sqrt((x - ax) ** 2 + (y - ay) ** 2)
          : Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / length;
      if (d > worstDistance) {
        worstDistance = d;
        worst = k;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return ring.filter((_, k) => keep[k] === 1);
}

/** Drops repeated positions the 5-dp rounding produced, and an explicit closing position. */
function dedupeConsecutive(ring: readonly Position[]): Position[] {
  const out: Position[] = [];
  for (const p of ring) {
    const last = out.at(-1);
    if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  const head = out[0];
  const tail = out.at(-1);
  if (out.length > 1 && head !== undefined && tail !== undefined) {
    if (head[0] === tail[0] && head[1] === tail[1]) out.pop();
  }
  return out;
}

/** Shoelace area of an open ring in squared degrees; positive when counter-clockwise. */
function signedArea(ring: readonly Position[]): number {
  let sum = 0;
  for (let k = 0; k < ring.length; k += 1) {
    const [x0, y0] = ring[k] as Position;
    const [x1, y1] = ring[(k + 1) % ring.length] as Position;
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

function compareRings(a: readonly Position[], b: readonly Position[]): number {
  const [ax, ay] = a[0] as Position;
  const [bx, by] = b[0] as Position;
  return ax - bx || ay - by;
}
