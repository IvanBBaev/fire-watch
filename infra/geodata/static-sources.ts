/**
 * The static hot-source mask transform (TASKS F16; 03-geodata §5.2.4, 11-data-science §6.2):
 * an Overpass `out geom` response in, the compact `fire-watch/static-sources@1` asset out.
 *
 * Pure: no I/O, no clock, no randomness — the same response always yields the same bytes,
 * so a refresh's diff is exactly what changed in OpenStreetMap. The CLI
 * (`static-sources-cli.ts`) owns the download, the hashes and the file.
 *
 * The wire format is documented, and parsed, by `packages/contracts/src/static-sources.ts`;
 * this module is its only writer. It does not import contracts because this project
 * compiles on its own (`infra/geodata/tsconfig.json`, Node built-ins only), so the format
 * constants are repeated here and a contracts test parses the committed asset.
 *
 * What is kept, and why:
 *
 * - **Kinds.** `solar` (`power=plant` + `plant:source=solar`, the §6.2 seed), `thermal_power`
 *   (`power=plant` burning coal, lignite, gas, oil, biomass, waste or diesel — Maritsa Iztok
 *   and its peers, the §5.2.4 curated list's backbone), `industrial` (steel, refinery,
 *   cement, metallurgy, smelter, foundry — Neftochim, Devnya, Kremikovtzi, Pernik) and
 *   `flare` (`man_made=flare`). Quarries, mines and landfills are left out: they are hot
 *   sometimes, burn for real sometimes, and are a founder call, not a default.
 * - **Geometry.** Nodes become points; closed ways become rings; a multipolygon's outer
 *   members are stitched into rings. Inner rings are dropped (the hole reads as masked).
 *   An open way or an outer ring that will not close is dropped and counted, never guessed.
 * - **Precision.** Coordinates are rounded to `SCALE` (1e-4°, ~11 m) and simplified with
 *   Douglas–Peucker at `SIMPLIFY_UNITS` of that grid. A ring that collapses below three
 *   distinct vertices (a rooftop-sized plant) becomes a point at its first vertex, so no
 *   mapped source silently disappears.
 * - **No OSM ids.** The element ids are not written: a fifth of the bytes, and nothing
 *   reads them. Provenance is the snapshot (`osm_base` + response hash), which pins every
 *   element exactly; a curation override, when one exists, keys on location.
 */

export const FORMAT = 'fire-watch/static-sources@1';
export const KINDS = ['solar', 'thermal_power', 'industrial', 'flare'] as const;
export type Kind = (typeof KINDS)[number];

/** The served box (W S E N), degrees — the same box the ingest filters to. */
export const SERVED_BBOX = [20, 39, 31, 46] as const;

/** Integer coordinate grid: 1e-4 degrees. */
export const SCALE = 10_000;

/**
 * Douglas–Peucker tolerance, in `SCALE` units (3 → ~33 m of latitude, ~25 m of longitude):
 * a tenth of a 375 m VIIRS pixel, so no hit or caveat a pixel can resolve moves; the
 * bytes it saves over 1 unit are a fifth of the file.
 */
export const SIMPLIFY_UNITS = 3;

const THERMAL_FUELS = new Set(['coal', 'lignite', 'gas', 'oil', 'biomass', 'waste', 'diesel']);
const INDUSTRIES = new Set(['steel', 'refinery', 'cement', 'metallurgy', 'smelter', 'foundry']);

/**
 * The Overpass QL the CLI sends. Part of the provenance: its SHA-256 is recorded in the
 * asset, so two assets from different queries can never be mistaken for one another.
 */
export const OVERPASS_QUERY =
  '[out:json][timeout:270][bbox:39,20,46,31];(' +
  'nwr["power"="plant"]["plant:source"="solar"];' +
  'nwr["power"="plant"]["plant:source"~"^(coal|lignite|gas|oil|biomass|waste|diesel)$"];' +
  'nwr["man_made"="flare"];' +
  'nwr["industrial"~"^(steel|refinery|cement|metallurgy|smelter|foundry)$"];' +
  ');out geom qt;';

interface OverpassPoint {
  readonly lat: number;
  readonly lon: number;
}

interface OverpassMember {
  readonly type: string;
  readonly role: string;
  readonly geometry?: readonly OverpassPoint[];
}

export interface OverpassElement {
  readonly type: 'node' | 'way' | 'relation';
  readonly id: number;
  readonly lat?: number;
  readonly lon?: number;
  readonly tags?: Readonly<Record<string, string>>;
  readonly geometry?: readonly (OverpassPoint | null)[];
  readonly members?: readonly OverpassMember[];
}

export interface OverpassResponse {
  readonly osm3s: { readonly timestamp_osm_base: string };
  readonly elements: readonly OverpassElement[];
}

export interface Provenance {
  readonly source: string;
  readonly querySha256: string;
  readonly responseSha256: string;
}

/** One output entry: `[kindIndex, lon0, lat0, dLon1, dLat1, …]`. */
export type EncodedSource = readonly number[];

export interface StaticSourcesAsset {
  readonly format: typeof FORMAT;
  readonly version: string;
  readonly licence: 'ODbL-1.0';
  readonly attribution: string;
  readonly source: string;
  readonly osm_base: string;
  readonly query_sha256: string;
  readonly response_sha256: string;
  readonly bbox: typeof SERVED_BBOX;
  readonly scale: number;
  readonly kinds: typeof KINDS;
  readonly counts: Readonly<Record<Kind, number>>;
  readonly dropped: { readonly open: number; readonly unclosedOuter: number };
  readonly sources: readonly EncodedSource[];
}

type IntPoint = readonly [number, number];

/** The kind an element's tags make it, or `null` when it is none of ours. */
export function kindOf(tags: Readonly<Record<string, string>> | undefined): Kind | null {
  if (tags === undefined) return null;
  if (tags['man_made'] === 'flare') return 'flare';
  if (tags['power'] === 'plant') {
    const fuel = tags['plant:source'];
    if (fuel === 'solar') return 'solar';
    if (fuel !== undefined && THERMAL_FUELS.has(fuel)) return 'thermal_power';
  }
  const industrial = tags['industrial'];
  if (industrial !== undefined && INDUSTRIES.has(industrial)) return 'industrial';
  return null;
}

function toInt(p: OverpassPoint): IntPoint {
  return [Math.round(p.lon * SCALE), Math.round(p.lat * SCALE)];
}

function samePoint(a: IntPoint, b: IntPoint): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function dedupe(points: readonly IntPoint[]): IntPoint[] {
  const out: IntPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last === undefined || !samePoint(last, p)) out.push(p);
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

/** Drop the closing duplicate and consecutive repeats; `null` when the ring does not close. */
function openRing(points: readonly IntPoint[]): IntPoint[] | null {
  const deduped = dedupe(points);
  const first = deduped[0];
  const last = deduped[deduped.length - 1];
  if (first === undefined || last === undefined || !samePoint(first, last)) return null;
  return deduped.slice(0, -1);
}

/**
 * Stitch a multipolygon's outer member ways into closed rings (endpoint matching, either
 * direction). Returns the rings that closed and the number of fragments that did not.
 */
export function assembleRings(ways: readonly (readonly IntPoint[])[]): {
  readonly rings: IntPoint[][];
  readonly unclosed: number;
} {
  const pending = ways.map((w) => dedupe(w)).filter((w) => w.length >= 2);
  const rings: IntPoint[][] = [];
  let unclosed = 0;
  while (pending.length > 0) {
    let chain = pending.shift() as IntPoint[];
    let grew = true;
    while (!samePoint(chain[0] as IntPoint, chain[chain.length - 1] as IntPoint) && grew) {
      grew = false;
      const end = chain[chain.length - 1] as IntPoint;
      for (let i = 0; i < pending.length; i += 1) {
        const way = pending[i] as IntPoint[];
        if (samePoint(way[0] as IntPoint, end)) {
          chain = [...chain, ...way.slice(1)];
        } else if (samePoint(way[way.length - 1] as IntPoint, end)) {
          chain = [...chain, ...[...way].reverse().slice(1)];
        } else {
          continue;
        }
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    const ring = openRing(chain);
    if (ring === null || ring.length < 3) unclosed += 1;
    else rings.push(ring);
  }
  return { rings, unclosed };
}

function encode(kind: Kind, points: readonly IntPoint[]): EncodedSource {
  const out: number[] = [KINDS.indexOf(kind)];
  let previous: IntPoint = [0, 0];
  for (const p of points) {
    out.push(p[0] - previous[0], p[1] - previous[1]);
    previous = p;
  }
  return out;
}

/** A simplified ring, or a point when the plant is too small to keep three vertices. */
function shapeOf(ring: readonly IntPoint[]): IntPoint[] {
  const simplified = simplifyRing(ring, SIMPLIFY_UNITS);
  return simplified.length >= 3 ? simplified : [ring[0] as IntPoint];
}

const TYPE_ORDER = { node: 0, way: 1, relation: 2 } as const;

/** Build the asset. Element order in the response does not matter; the output is sorted. */
export function buildStaticSources(
  response: OverpassResponse,
  provenance: Provenance,
): StaticSourcesAsset {
  const elements = [...response.elements].sort(
    (a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.id - b.id,
  );
  const entries: { kind: Kind; sortKey: [number, number, number]; source: EncodedSource }[] = [];
  let open = 0;
  let unclosedOuter = 0;
  for (const element of elements) {
    const kind = kindOf(element.tags);
    if (kind === null) continue;
    const sortKey: [number, number, number] = [
      KINDS.indexOf(kind),
      TYPE_ORDER[element.type],
      element.id,
    ];
    if (element.type === 'node') {
      if (element.lat === undefined || element.lon === undefined) continue;
      const p = toInt({ lat: element.lat, lon: element.lon });
      entries.push({ kind, sortKey, source: encode(kind, [p]) });
    } else if (element.type === 'way') {
      const geometry = (element.geometry ?? []).filter((p): p is OverpassPoint => p !== null);
      const ring = openRing(geometry.map(toInt));
      if (ring === null || ring.length < 1) {
        open += 1;
        continue;
      }
      entries.push({ kind, sortKey, source: encode(kind, shapeOf(ring)) });
    } else {
      const outers = (element.members ?? [])
        .filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === ''))
        .map((m) => (m.geometry ?? []).map(toInt));
      const { rings, unclosed } = assembleRings(outers);
      unclosedOuter += unclosed;
      for (const ring of rings)
        entries.push({ kind, sortKey, source: encode(kind, shapeOf(ring)) });
    }
  }
  // Stable sort: rings of one relation keep their assembly order.
  entries.sort(
    (a, b) =>
      a.sortKey[0] - b.sortKey[0] || a.sortKey[1] - b.sortKey[1] || a.sortKey[2] - b.sortKey[2],
  );
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
  for (const entry of entries) counts[entry.kind] += 1;
  const osmBase = response.osm3s.timestamp_osm_base;
  return {
    format: FORMAT,
    version: `osm-${osmBase.slice(0, 10)}`,
    licence: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    source: provenance.source,
    osm_base: osmBase,
    query_sha256: provenance.querySha256,
    response_sha256: provenance.responseSha256,
    bbox: SERVED_BBOX,
    scale: SCALE,
    kinds: KINDS,
    counts,
    dropped: { open, unclosedOuter },
    sources: entries.map((e) => e.source),
  };
}

/**
 * Serialize with one source per line, so a quarterly refresh diffs as added and removed
 * plants rather than as one changed line of a quarter-megabyte.
 */
export function serializeStaticSources(asset: StaticSourcesAsset): string {
  const { sources, ...header } = asset;
  const head = JSON.stringify(header).slice(0, -1);
  const body = sources.map((s) => JSON.stringify(s)).join(',\n');
  return `${head},"sources":[\n${body}\n]}\n`;
}
