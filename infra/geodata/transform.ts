/**
 * Pure transforms behind the Track F geodata assets (oblast polygons for the region
 * filter, settlement gazetteer for search). No I/O: `cli.ts` downloads and writes; this
 * file turns already-read source bytes into the compact JSON the web app lazy-loads.
 *
 * Both outputs are integer-coded at 1e-3 degrees (about 110 m of latitude, 80 m of
 * longitude at 42° N). That is finer than the sources' own accuracy for the purpose
 * (Natural Earth 10m admin-1 is a 1:10M generalisation; a settlement is a point that
 * stands for a whole village), and it roughly halves the bytes of a decimal encoding.
 */

/** Integer scale of every coordinate in both assets. */
export const COORD_SCALE = 1000;

/**
 * ISO 3166-2:BG — the 28 oblasts (BG-22 is Sofia City, BG-23 Sofia Province). The build
 * fails unless the source has exactly these, each once: a missing or extra polygon would
 * silently misfile fires.
 */
export const OBLAST_ISO_CODES: readonly string[] = Array.from(
  { length: 28 },
  (_, i) => `BG-${String(i + 1).padStart(2, '0')}`,
);

// ---------------------------------------------------------------------------------
// Transliteration and folding. The web app carries the same table
// (`web/src/core/search/transliterate.ts`); this copy only decides which Latin names
// are worth storing as explicit aliases, so a drift between the two costs an alias,
// never a result.
// ---------------------------------------------------------------------------------

/** The official Bulgarian Streamlined System (Transliteration Act 2009), lower case. */
const STREAMLINED: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sht',
  ъ: 'a',
  ь: 'y',
  ю: 'yu',
  я: 'ya',
};

/**
 * The search key: Streamlined Latin, lower case, no diacritics, punctuation to single
 * spaces, plus three folds so the other romanisations people (and GeoNames) use meet
 * the Streamlined one: `ŭ`→`a` (BGN/PCGN and scholarly `ъ`), `kh`→`h` (BGN `х`), and
 * `iya`→`ia` (the Act's word-final rule, applied everywhere so "Sofiya" meets "Sofia").
 */
export function foldName(name: string): string {
  const lower = name.toLowerCase();
  let latin = '';
  for (const ch of lower) latin += STREAMLINED[ch] ?? ch;
  return latin
    .replace(/ŭ/g, 'a')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/kh/g, 'h')
    .replace(/iya/g, 'ia')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------

type Position = readonly [number, number];
type Ring = readonly Position[];

/** Ray-casting point-in-ring (even-odd), coordinates as [lon, lat]. */
export function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as Position;
    const [xj, yj] = ring[j] as Position;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Squared planar distance (degrees, longitude scaled by cos(lat)) to a ring's edges. */
export function distanceToRingSq(lon: number, lat: number, ring: Ring): number {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j] as Position;
    const [x2, y2] = ring[i] as Position;
    const ax = (x1 - lon) * k;
    const ay = y1 - lat;
    const bx = (x2 - lon) * k;
    const by = y2 - lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
    const px = ax + t * dx;
    const py = ay + t * dy;
    best = Math.min(best, px * px + py * py);
  }
  return best;
}

// ---------------------------------------------------------------------------------
// Regions (Natural Earth 10m admin-1, public domain)
// ---------------------------------------------------------------------------------

export interface RegionsAsset {
  readonly v: 1;
  readonly source: string;
  readonly scale: number;
  /**
   * One entry per oblast, sorted by ISO code: `[iso, rings]`, where each ring is a flat
   * delta-coded integer array `[lon0, lat0, dLon1, dLat1, …]` at {@link COORD_SCALE}.
   * The first ring is the outer boundary, any further ones are holes (even-odd rule).
   */
  readonly regions: readonly (readonly [string, readonly (readonly number[])[]])[];
}

interface GeoJsonFeature {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry: {
    readonly type: string;
    readonly coordinates: unknown;
  } | null;
}

/** Quantises and delta-codes a ring, dropping points that collapse onto the previous. */
export function encodeRing(ring: Ring): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  let first = true;
  for (const [lon, lat] of ring) {
    const x = Math.round(lon * COORD_SCALE);
    const y = Math.round(lat * COORD_SCALE);
    if (!first && x === px && y === py) continue;
    out.push(first ? x : x - px, first ? y : y - py);
    px = x;
    py = y;
    first = false;
  }
  return out;
}

/** Inverse of {@link encodeRing}, in degrees. */
export function decodeRing(flat: readonly number[]): [number, number][] {
  const ring: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    x += flat[i] as number;
    y += flat[i + 1] as number;
    ring.push([x / COORD_SCALE, y / COORD_SCALE]);
  }
  return ring;
}

export function buildRegions(
  featureCollection: { readonly features: readonly GeoJsonFeature[] },
  source: string,
): RegionsAsset {
  const byIso = new Map<string, (readonly number[])[]>();
  for (const feature of featureCollection.features) {
    if (feature.properties['adm0_a3'] !== 'BGR') continue;
    const iso = feature.properties['iso_3166_2'];
    if (typeof iso !== 'string' || !OBLAST_ISO_CODES.includes(iso)) {
      throw new Error(`unexpected Bulgarian admin-1 feature ${JSON.stringify(iso)}`);
    }
    if (byIso.has(iso)) throw new Error(`${iso} appears twice`);
    const geometry = feature.geometry;
    if (geometry?.type !== 'Polygon') {
      // Every oblast is one polygon in NE 5.1.2; a MultiPolygon would need the asset
      // format (and the web decoder) to grow, so it is a build failure, not a guess.
      throw new Error(`${iso}: expected a Polygon, got ${geometry?.type ?? 'null'}`);
    }
    const rings = geometry.coordinates as Ring[];
    byIso.set(
      iso,
      rings.map((ring) => encodeRing(ring)),
    );
  }
  const missing = OBLAST_ISO_CODES.filter((iso) => !byIso.has(iso));
  if (missing.length > 0) throw new Error(`missing oblasts: ${missing.join(', ')}`);
  return {
    v: 1,
    source,
    scale: COORD_SCALE,
    regions: OBLAST_ISO_CODES.map((iso) => [iso, byIso.get(iso) ?? []] as const),
  };
}

/**
 * The oblast a point falls in, by ISO code: inside a polygon, else the nearest one
 * within `toleranceKm` (the 1:10M boundaries leave slivers along rivers and the coast),
 * else null.
 */
export function regionOf(
  asset: RegionsAsset,
  lon: number,
  lat: number,
  toleranceKm = 2,
): string | null {
  let nearest: string | null = null;
  let nearestSq = Infinity;
  for (const [iso, flatRings] of asset.regions) {
    const rings = flatRings.map(decodeRing);
    const [outer, ...holes] = rings;
    if (outer === undefined) continue;
    if (pointInRing(lon, lat, outer) && !holes.some((hole) => pointInRing(lon, lat, hole))) {
      return iso;
    }
    const d = distanceToRingSq(lon, lat, outer);
    if (d < nearestSq) {
      nearestSq = d;
      nearest = iso;
    }
  }
  const toleranceDeg = toleranceKm / 111.2;
  return nearestSq <= toleranceDeg * toleranceDeg ? nearest : null;
}

// ---------------------------------------------------------------------------------
// Gazetteer (GeoNames, CC BY 4.0)
// ---------------------------------------------------------------------------------

/**
 * Populated-place feature codes kept. Left out: PPLX (sections of a place — Sofia
 * neighbourhoods would crowd out villages), PPLQ/PPLH/PPLW (abandoned, historical,
 * destroyed), PPLCH (historical capital).
 */
export const KEPT_FEATURE_CODES = new Set([
  'PPLC',
  'PPLA',
  'PPLA2',
  'PPLA3',
  'PPLA4',
  'PPL',
  'PPLL',
  'PPLF',
  'PPLS',
  'PPLR',
]);

/** Ranking: lower is shown first when several places match equally well. */
export function rankOf(featureCode: string, population: number): number {
  if (featureCode === 'PPLC') return 0;
  if (featureCode === 'PPLA') return 1;
  if (featureCode === 'PPLA2') return 2;
  if (population >= 5000 || featureCode === 'PPLA3') return 3;
  return 4;
}

/**
 * One settlement: `[name, lat, lon, oblast, rank]` or, when GeoNames' Latin name is
 * not simply the Streamlined transliteration of `name`, `[name, lat, lon, oblast, rank,
 * latinAlias]`. `name` is Bulgarian Cyrillic (GeoNames `bg` alternate name) except for
 * the handful of places GeoNames has no Bulgarian name for. `oblast` is the ISO 3166-2
 * number (1–28) or 0 when the point is in no oblast polygon.
 */
export type GazetteerRow =
  | readonly [string, number, number, number, number]
  | readonly [string, number, number, number, number, string];

export interface GazetteerAsset {
  readonly v: 1;
  readonly source: string;
  readonly scale: number;
  readonly places: readonly GazetteerRow[];
}

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[A-Za-z]/;

interface Place {
  readonly id: string;
  readonly latinName: string;
  readonly lat: number;
  readonly lon: number;
  readonly featureCode: string;
  readonly population: number;
  readonly alternateNames: readonly string[];
}

/** Parses the GeoNames `geoname` table (tab-separated, one feature per line). */
export function parsePlaces(geonamesTsv: string): Place[] {
  const places: Place[] = [];
  for (const line of geonamesTsv.split('\n')) {
    if (line.length === 0) continue;
    const c = line.split('\t');
    if (c[6] !== 'P' || !KEPT_FEATURE_CODES.has(c[7] ?? '')) continue;
    places.push({
      id: c[0] ?? '',
      latinName: c[1] ?? '',
      lat: Number(c[4]),
      lon: Number(c[5]),
      featureCode: c[7] ?? '',
      population: Number(c[14] ?? '0') || 0,
      alternateNames: (c[3] ?? '').split(',').filter((name) => name.length > 0),
    });
  }
  return places;
}

/**
 * Bulgarian names from the `alternatenames` table, per geonameid: Cyrillic `bg` rows,
 * the preferred one first. (GeoNames tags some Latin spellings `bg` too; those are
 * dropped here.) Historic rows are skipped.
 */
export function parseBulgarianNames(alternateTsv: string): Map<string, string[]> {
  const byId = new Map<string, { preferred: string[]; other: string[] }>();
  for (const line of alternateTsv.split('\n')) {
    if (line.length === 0) continue;
    const c = line.split('\t');
    if (c[2] !== 'bg') continue;
    const name = (c[3] ?? '').trim();
    if (!CYRILLIC.test(name) || LATIN.test(name)) continue;
    if (c[7] === '1') continue; // isHistoric
    const id = c[1] ?? '';
    const entry = byId.get(id) ?? { preferred: [], other: [] };
    (c[4] === '1' ? entry.preferred : entry.other).push(name);
    byId.set(id, entry);
  }
  const out = new Map<string, string[]>();
  for (const [id, { preferred, other }] of byId) {
    out.set(id, [...new Set([...preferred, ...other])]);
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * COORD_SCALE);
}

export function buildGazetteer(
  geonamesTsv: string,
  alternateTsv: string,
  regions: RegionsAsset,
  source: string,
): GazetteerAsset {
  const bulgarian = parseBulgarianNames(alternateTsv);
  const rows: { row: GazetteerRow; rank: number; key: string }[] = [];
  const seen = new Set<string>();
  for (const place of parsePlaces(geonamesTsv)) {
    const bgNames = bulgarian.get(place.id) ?? place.alternateNames.filter((n) => CYRILLIC.test(n));
    const name = bgNames[0] ?? place.latinName;
    if (name.length === 0 || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) continue;
    const lat = round(place.lat);
    const lon = round(place.lon);
    // GeoNames carries a few exact duplicates (same name, same point, two ids).
    const dedupe = `${name}|${lat}|${lon}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const iso = regionOf(regions, place.lon, place.lat);
    const oblast = iso === null ? 0 : Number(iso.slice(3));
    const rank = rankOf(place.featureCode, place.population);
    const alias = foldName(place.latinName) === foldName(name) ? null : place.latinName;
    const row: GazetteerRow =
      alias === null ? [name, lat, lon, oblast, rank] : [name, lat, lon, oblast, rank, alias];
    rows.push({ row, rank, key: name });
  }
  rows.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key, 'bg') || a.row[1] - b.row[1]);
  return { v: 1, source, scale: COORD_SCALE, places: rows.map(({ row }) => row) };
}
