/**
 * Golden-fixture fire candidates from the EFFIS burnt-area archive (TASKS D5, the A6
 * fixture-sourcing half; IMPLEMENTATION-PLAN "verify historical EFFIS burnt-area archive
 * access, pin the S1–S6 fire dates against it").
 *
 * EFFIS WFS `modis.ba.poly.<YEAR>` GeoJSON in, the `fire-watch/effis-ba-candidates@1`
 * selection out: for each pre-merge scenario (GATES §1.1 S1–S6), the real burnt-area
 * records whose shape fits the scenario, ranked, each traceable to an EFFIS id in a
 * fetched file whose sha256 the selection carries.
 *
 * Pure: no I/O, no clock — the same files always yield the same bytes. The CLI
 * (`effis-ba-candidates-cli.ts`) owns the download, the hashes and the file.
 *
 * What a burnt-area record can and cannot say:
 *
 * - `FIREDATE`/`FINALDATE` are the first and last mapping dates of the perimeter, not the
 *   ignition and extinction (DATA-SOURCES §D1). They pick the replay window; the FIRMS
 *   detections inside it are what a fixture replays.
 * - There is no wildfire/agricultural flag. The land-cover shares (`AGRIAREAS` …) are
 *   percentages of the burnt area by land cover — a proxy, not a label.
 * - Separate perimeters that touch with overlapping dates are the archive's trace of two
 *   fronts meeting (S2) or of one fire crossing a border (S1); a perimeter is never split
 *   by EFFIS at a border, so a straddling one is the direct S1 evidence.
 * - A reignition (S6) is only visible as a second perimeter beside the first one after its
 *   `FINALDATE`; a quiet spell inside one perimeter's window leaves no trace at all.
 *
 * S4 (industrial static source) and S5 (single-detection noise) leave no burnt area by
 * definition, so they get no candidates — the selection says so instead of omitting them.
 */

export const FORMAT = 'fire-watch/effis-ba-candidates@1';

/** Bump when a rule below changes: the committed selection names the rules it applied. */
export const RULES_VERSION = 'effis_ba_candidates_v1';

/** The archive years D5 reads — the label years DS-3 names (2020–2025). */
export const YEARS = [2020, 2021, 2022, 2023, 2024, 2025] as const;

/** `polling_bbox_v1` (W S E N): the box the ingest polls; the WFS request is cut to it. */
export const REQUEST_BBOX = [20, 39, 31, 46] as const;

export const WFS_ENDPOINT = 'https://maps.effis.emergency.copernicus.eu/effis';

/** The exact GetFeature URL for one archive year (WFS 1.1.0 takes lat,lon axis order). */
export function layerUrl(year: number): string {
  const [w, s, e, n] = REQUEST_BBOX;
  return (
    `${WFS_ENDPOINT}?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature` +
    `&TYPENAME=modis.ba.poly.${String(year)}&OUTPUTFORMAT=geojson` +
    `&BBOX=${String(s)},${String(w)},${String(n)},${String(e)},urn:ogc:def:crs:EPSG::4326`
  );
}

type LonLat = readonly [number, number];
type Ring = readonly LonLat[];

/**
 * The selection rules, as data. Anchors are approximate place coordinates used only to
 * rank candidates by how close they are to the place the scenario is named after.
 */
export const RULES = {
  limit: 5,
  /** Vertices sampled per perimeter for the border test (an even stride; deterministic). */
  maxSampledVertices: 200,
  S1: {
    anchor: [23.61, 41.39] as LonLat, // Slavyanka, the BG–GR border
    /** A perimeter straddles when this share of its vertices lies on each side. */
    minSideShare: 0.1,
    pairGapKm: 1,
    dateSlackDays: 1,
  },
  S2: {
    anchor: [26.2, 41.95] as LonLat, // Sakar, between Harmanli and Topolovgrad
    provinces: ['Хасково', 'Ямбол'],
    minAreaHa: 100,
    pairGapKm: 1,
    dateSlackDays: 1,
  },
  S3: { minAgriPct: 95, minAreaHa: 20 },
  S6: { minAreaHa: 1000, minDurationHours: 48, reignitionGapKm: 3, reignitionWithinDays: 14 },
} as const;

// ---------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------

export interface BaFire {
  readonly id: string;
  readonly layer: string;
  readonly country: string;
  readonly province: string;
  readonly commune: string;
  readonly fireDate: string;
  readonly finalDate: string;
  readonly lastUpdate: string;
  readonly areaHa: number;
  /** `AGRIAREAS`, percent of the burnt area; `null` when EFFIS left it blank. */
  readonly agriPct: number | null;
  /** Outer rings of every polygonal member (holes do not matter to any rule here). */
  readonly rings: readonly Ring[];
}

interface Geometry {
  readonly type: string;
  readonly coordinates?: unknown;
  readonly geometries?: readonly Geometry[];
}

interface Feature {
  readonly properties?: Record<string, unknown> | null;
  readonly geometry?: Geometry | null;
}

export interface FeatureCollection {
  readonly type?: string;
  readonly features: readonly Feature[];
}

function text(props: Record<string, unknown>, key: string): string {
  const v = props[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function numberOrNull(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function outerRings(geometry: Geometry): Ring[] {
  // A GeometryCollection carries the perimeter plus line and point debris; only its
  // polygonal members are the burnt area.
  if (geometry.type === 'GeometryCollection') {
    return (geometry.geometries ?? []).flatMap(outerRings);
  }
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates as readonly Ring[];
    return rings[0] === undefined ? [] : [rings[0]];
  }
  if (geometry.type === 'MultiPolygon') {
    const polygons = geometry.coordinates as readonly (readonly Ring[])[];
    return polygons.flatMap((rings) => (rings[0] === undefined ? [] : [rings[0]]));
  }
  return [];
}

export interface ParsedLayer {
  readonly fires: readonly BaFire[];
  /** Features with no polygonal geometry or no id — counted, never guessed. */
  readonly dropped: number;
}

export function parseLayer(layer: string, collection: FeatureCollection): ParsedLayer {
  const fires: BaFire[] = [];
  let dropped = 0;
  for (const feature of collection.features) {
    const props = feature.properties ?? {};
    const rings = feature.geometry ? outerRings(feature.geometry) : [];
    const id = text(props, 'id');
    if (id === '' || rings.length === 0) {
      dropped += 1;
      continue;
    }
    fires.push({
      id,
      layer,
      country: text(props, 'COUNTRY'),
      province: text(props, 'PROVINCE'),
      commune: text(props, 'COMMUNE'),
      fireDate: text(props, 'FIREDATE'),
      finalDate: text(props, 'FINALDATE'),
      lastUpdate: text(props, 'LASTUPDATE'),
      areaHa: numberOrNull(text(props, 'AREA_HA')) ?? 0,
      agriPct: numberOrNull(text(props, 'AGRIAREAS')),
      rings,
    });
  }
  return { fires, dropped };
}

// ---------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------

type Box = readonly [w: number, s: number, e: number, n: number];

function vertices(fire: BaFire): LonLat[] {
  return fire.rings.flatMap((ring) => [...ring]);
}

export function bboxOf(points: readonly LonLat[]): Box {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of points) {
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  return [w, s, e, n];
}

/** Vertex mean — a label position, not an area centroid. */
export function centroidOf(points: readonly LonLat[]): LonLat {
  let x = 0;
  let y = 0;
  for (const [lon, lat] of points) {
    x += lon;
    y += lat;
  }
  return [x / points.length, y / points.length];
}

/** Equirectangular distance — exact enough at the kilometre thresholds used here. */
export function distanceKm(a: LonLat, b: LonLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111.2;
}

function boxGapKm(a: Box, b: Box): number {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  const k = Math.cos((((a[1] + a[3]) / 2) * Math.PI) / 180);
  return Math.hypot(dx * k, dy) * 111.2;
}

/** Nearest vertex-to-vertex distance between two perimeters (0 when they share one). */
export function vertexGapKm(a: readonly LonLat[], b: readonly LonLat[], limitKm: number): number {
  if (boxGapKm(bboxOf(a), bboxOf(b)) > limitKm) return Infinity;
  let best = Infinity;
  for (const p of a) {
    for (const q of b) {
      const d = distanceKm(p, q);
      if (d < best) best = d;
    }
  }
  return best;
}

function sample(points: readonly LonLat[], max: number): LonLat[] {
  const stride = Math.max(1, Math.ceil(points.length / max));
  return points.filter((_, i) => i % stride === 0);
}

// ---------------------------------------------------------------------------------
// The Bulgaria outline (the oblast asset `infra/geodata` already builds)
// ---------------------------------------------------------------------------------

/** `web/src/assets/geodata/oblasts.json`: `{scale, regions: [iso, flatRings[]][]}`. */
export interface RegionsAsset {
  readonly source?: string;
  readonly scale: number;
  readonly regions: readonly (readonly [string, readonly (readonly number[])[]])[];
}

interface OutlinePart {
  readonly outer: Ring;
  readonly holes: readonly Ring[];
  readonly box: Box;
}

export interface Outline {
  readonly parts: readonly OutlinePart[];
  readonly box: Box;
}

function decodeRing(flat: readonly number[], scale: number): Ring {
  const ring: LonLat[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    x += flat[i] as number;
    y += flat[i + 1] as number;
    ring.push([x / scale, y / scale]);
  }
  return ring;
}

export function outlineFromRegions(asset: RegionsAsset): Outline {
  const parts: OutlinePart[] = [];
  for (const [, flatRings] of asset.regions) {
    const [outer, ...holes] = flatRings.map((flat) => decodeRing(flat, asset.scale));
    if (outer === undefined || outer.length < 3) continue;
    parts.push({ outer, holes, box: bboxOf(outer) });
  }
  const corners = parts.flatMap((p): LonLat[] => [
    [p.box[0], p.box[1]],
    [p.box[2], p.box[3]],
  ]);
  return { parts, box: bboxOf(corners) };
}

function pointInRing([lon, lat]: LonLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as LonLat;
    const [xj, yj] = ring[j] as LonLat;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function insideOutline(point: LonLat, outline: Outline): boolean {
  const [lon, lat] = point;
  const [w, s, e, n] = outline.box;
  if (lon < w || lon > e || lat < s || lat > n) return false;
  return outline.parts.some(
    (part) =>
      lon >= part.box[0] &&
      lon <= part.box[2] &&
      lat >= part.box[1] &&
      lat <= part.box[3] &&
      pointInRing(point, part.outer) &&
      !part.holes.some((hole) => pointInRing(point, hole)),
  );
}

// ---------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** EFFIS writes `YYYY-MM-DD HH:MM:SS[.ffffff]` with no zone; read as UTC, compared only. */
export function parseEffisDate(raw: string): number {
  const ms = Date.parse(`${raw.slice(0, 19).replace(' ', 'T')}Z`);
  if (Number.isNaN(ms)) throw new RangeError(`not an EFFIS date: ${raw}`);
  return ms;
}

function windowsOverlap(a: BaFire, b: BaFire, slackDays: number): boolean {
  const slack = slackDays * DAY_MS;
  return (
    parseEffisDate(a.fireDate) <= parseEffisDate(b.finalDate) + slack &&
    parseEffisDate(b.fireDate) <= parseEffisDate(a.finalDate) + slack
  );
}

function durationHours(fire: BaFire): number {
  return (parseEffisDate(fire.finalDate) - parseEffisDate(fire.fireDate)) / HOUR_MS;
}

// ---------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------

export interface FireRecord {
  readonly effis_id: string;
  readonly layer: string;
  readonly country: string;
  readonly province: string;
  readonly commune: string;
  readonly firedate: string;
  readonly finaldate: string;
  readonly lastupdate: string;
  readonly area_ha: number;
  readonly agri_pct: number | null;
  /** Vertex mean, 1e-4°. */
  readonly centroid: LonLat;
  /** W S E N, 1e-4°. */
  readonly bbox: Box;
}

export interface Candidate {
  readonly rank: number;
  readonly evidence: string;
  readonly fires: readonly FireRecord[];
}

export type ScenarioStatus = 'candidates' | 'no_fitting_fire';

export interface ScenarioSelection {
  readonly scenario: string;
  readonly status: ScenarioStatus;
  readonly rule: string;
  readonly note: string;
  readonly candidates: readonly Candidate[];
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const round2 = (v: number): number => Math.round(v * 100) / 100;

export function fireRecord(fire: BaFire): FireRecord {
  const points = vertices(fire);
  const [w, s, e, n] = bboxOf(points);
  const [cx, cy] = centroidOf(points);
  return {
    effis_id: fire.id,
    layer: fire.layer,
    country: fire.country,
    province: fire.province,
    commune: fire.commune,
    firedate: fire.fireDate,
    finaldate: fire.finalDate,
    lastupdate: fire.lastUpdate,
    area_ha: fire.areaHa,
    agri_pct: fire.agriPct === null ? null : round2(fire.agriPct),
    centroid: [round4(cx), round4(cy)],
    bbox: [round4(w), round4(s), round4(e), round4(n)],
  };
}

interface Scored {
  readonly sortKey: readonly (number | string)[];
  readonly evidence: string;
  readonly fires: readonly BaFire[];
}

function compareKeys(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as number | string;
    const y = b[i] as number | string;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

function ranked(scored: readonly Scored[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const s of [...scored].sort((a, b) => compareKeys(a.sortKey, b.sortKey))) {
    const key = s.fires
      .map((f) => f.id)
      .sort()
      .join('+');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rank: out.length + 1, evidence: s.evidence, fires: s.fires.map(fireRecord) });
    if (out.length === RULES.limit) break;
  }
  return out;
}

const km = (v: number): string => `${v.toFixed(2)} km`;

function anchorKm(fire: BaFire, anchor: LonLat): number {
  return distanceKm(centroidOf(vertices(fire)), anchor);
}

/** Pairs of fires within `gapKm` whose date windows overlap (± `slackDays`). */
function touchingPairs(
  pool: readonly BaFire[],
  gapKm: number,
  slackDays: number,
  accept: (a: BaFire, b: BaFire) => boolean,
): { a: BaFire; b: BaFire; gap: number }[] {
  const pairs: { a: BaFire; b: BaFire; gap: number }[] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i] as BaFire;
      const b = pool[j] as BaFire;
      if (!accept(a, b) || !windowsOverlap(a, b, slackDays)) continue;
      const gap = vertexGapKm(vertices(a), vertices(b), gapKm);
      if (gap <= gapKm) pairs.push({ a, b, gap });
    }
  }
  return pairs;
}

export function selectS1(fires: readonly BaFire[], outline: Outline): ScenarioSelection {
  const r = RULES.S1;
  const [w, s, e, n] = outline.box;
  const near = fires.filter((f) => {
    const box = bboxOf(vertices(f));
    return box[2] >= w && box[0] <= e && box[3] >= s && box[1] <= n;
  });
  const scored: Scored[] = [];
  for (const fire of near) {
    const points = sample(vertices(fire), RULES.maxSampledVertices);
    const inside = points.filter((p) => insideOutline(p, outline)).length;
    const share = inside / points.length;
    if (Math.min(share, 1 - share) < r.minSideShare) continue;
    scored.push({
      sortKey: [anchorKm(fire, r.anchor), fire.id],
      evidence:
        `straddle: ${String(inside)} of ${String(points.length)} sampled perimeter vertices ` +
        `inside the Bulgaria outline; ${km(anchorKm(fire, r.anchor))} from the Slavyanka anchor`,
      fires: [fire],
    });
  }
  const pairs = touchingPairs(
    near,
    r.pairGapKm,
    r.dateSlackDays,
    (a, b) => (a.country === 'BG') !== (b.country === 'BG'),
  );
  for (const { a, b, gap } of pairs) {
    const d = Math.min(anchorKm(a, r.anchor), anchorKm(b, r.anchor));
    scored.push({
      sortKey: [d, a.id, b.id],
      evidence:
        `cross-border pair: ${a.country} and ${b.country} perimeters ${km(gap)} apart with ` +
        `overlapping dates; ${km(d)} from the Slavyanka anchor`,
      fires: [a, b],
    });
  }
  const candidates = ranked(scored);
  return {
    scenario: 'S1',
    status: candidates.length > 0 ? 'candidates' : 'no_fitting_fire',
    rule:
      `a perimeter with >= ${String(r.minSideShare * 100)} % of its sampled vertices on each ` +
      `side of the Bulgaria outline, or a BG and a non-BG perimeter <= ${String(r.pairGapKm)} km ` +
      `apart with dates overlapping +- ${String(r.dateSlackDays)} d; nearest the Slavyanka ` +
      `anchor first`,
    note:
      'The outline is Natural Earth 1:10M; along the Danube its generalisation can put a ' +
      'Romanian bank inside it, which is why the ranking is by distance from Slavyanka.',
    candidates,
  };
}

export function selectS2(fires: readonly BaFire[]): ScenarioSelection {
  const r = RULES.S2;
  const pool = fires.filter(
    (f) =>
      f.country === 'BG' &&
      f.areaHa >= r.minAreaHa &&
      r.provinces.some((p) => f.province.includes(p)),
  );
  const pairs = touchingPairs(pool, r.pairGapKm, r.dateSlackDays, () => true);
  const scored = pairs.map(({ a, b, gap }) => {
    const d = Math.min(anchorKm(a, r.anchor), anchorKm(b, r.anchor));
    return {
      sortKey: [d, a.id, b.id],
      evidence:
        `two perimeters (${String(a.areaHa)} ha + ${String(b.areaHa)} ha) ${km(gap)} apart ` +
        `with overlapping dates; ${km(d)} from the Sakar anchor`,
      fires: [a, b],
    };
  });
  const candidates = ranked(scored);
  return {
    scenario: 'S2',
    status: candidates.length > 0 ? 'candidates' : 'no_fitting_fire',
    rule:
      `two BG perimeters in ${r.provinces.join('/')}, each >= ${String(r.minAreaHa)} ha, ` +
      `<= ${String(r.pairGapKm)} km apart with dates overlapping +- ` +
      `${String(r.dateSlackDays)} d; nearest the Sakar anchor first`,
    note:
      'Two touching perimeters are the archive trace of two fronts that met; whether the ' +
      'FIRMS detections first formed two clusters and then merged is what the replay window ' +
      'has to show.',
    candidates,
  };
}

export function selectS3(fires: readonly BaFire[]): ScenarioSelection {
  const r = RULES.S3;
  const scored = fires
    .filter(
      (f) =>
        f.country === 'BG' &&
        f.areaHa >= r.minAreaHa &&
        f.agriPct !== null &&
        f.agriPct >= r.minAgriPct,
    )
    .map((fire) => ({
      sortKey: [-fire.areaHa, fire.id],
      evidence: `${String(round2(fire.agriPct ?? 0))} % of ${String(fire.areaHa)} ha on agricultural land`,
      fires: [fire],
    }));
  const candidates = ranked(scored);
  return {
    scenario: 'S3',
    status: candidates.length > 0 ? 'candidates' : 'no_fitting_fire',
    rule: `a BG perimeter >= ${String(r.minAreaHa)} ha with AGRIAREAS >= ${String(r.minAgriPct)} %; largest first`,
    note:
      'AGRIAREAS is a land-cover share, not a burn-type label: EFFIS BA has no agricultural ' +
      'flag. S3 stays blocked on LAND_COVER (D10) whatever is picked here.',
    candidates,
  };
}

export function selectS6(fires: readonly BaFire[]): ScenarioSelection {
  const r = RULES.S6;
  const scored: Scored[] = [];
  for (const fire of fires) {
    if (fire.country !== 'BG' || fire.areaHa < r.minAreaHa) continue;
    const hours = durationHours(fire);
    if (hours < r.minDurationHours) continue;
    const end = parseEffisDate(fire.finalDate);
    const later = fires.filter((other) => {
      if (other.id === fire.id) return false;
      const start = parseEffisDate(other.fireDate);
      return start > end && start <= end + r.reignitionWithinDays * DAY_MS;
    });
    const reignitions = later
      .map((other) => ({
        other,
        gap: vertexGapKm(vertices(fire), vertices(other), r.reignitionGapKm),
      }))
      .filter((x) => x.gap <= r.reignitionGapKm)
      .sort((a, b) => a.gap - b.gap || compareKeys([a.other.id], [b.other.id]));
    const first = reignitions[0];
    scored.push({
      // A megafire with a recorded reignition outranks every one without.
      sortKey: [first === undefined ? 1 : 0, -fire.areaHa, fire.id],
      evidence:
        `${String(fire.areaHa)} ha mapped over ${String(Math.round(hours))} h; ` +
        (first === undefined
          ? `no perimeter starts within ${String(r.reignitionGapKm)} km in the ` +
            `${String(r.reignitionWithinDays)} d after FINALDATE`
          : `reignition: perimeter ${first.other.id} starts ${km(first.gap)} away after FINALDATE`),
      fires: first === undefined ? [fire] : [fire, first.other],
    });
  }
  const candidates = ranked(scored);
  const anyReignition = candidates.some((c) => c.fires.length > 1);
  return {
    scenario: 'S6',
    status: candidates.length > 0 ? 'candidates' : 'no_fitting_fire',
    rule:
      `a BG perimeter >= ${String(r.minAreaHa)} ha mapped over >= ` +
      `${String(r.minDurationHours)} h; one with a later perimeter <= ` +
      `${String(r.reignitionGapKm)} km away starting within ${String(r.reignitionWithinDays)} d ` +
      `after its FINALDATE ranks first, then largest first`,
    note: anyReignition
      ? 'Reignition pairs are listed as two fires.'
      : 'No candidate has a reignition perimeter: the archive shows the megafires, not the ' +
        'cooling and reignition inside one perimeter. Those have to be found in the FIRMS ' +
        'detections over a candidate window before the fixture can be cut from it.',
    candidates,
  };
}

export function noFittingFire(scenario: string, rule: string, note: string): ScenarioSelection {
  return { scenario, status: 'no_fitting_fire', rule, note, candidates: [] };
}

export function selectAll(fires: readonly BaFire[], outline: Outline): ScenarioSelection[] {
  return [
    selectS1(fires, outline),
    selectS2(fires),
    selectS3(fires),
    noFittingFire(
      'S4',
      'none — not a burnt-area scenario',
      'An industrial static source is a persistent hot spot that never burns an area; the ' +
        'DS-5 static-source mask, not the BA archive, is where S4 sites come from.',
    ),
    noFittingFire(
      'S5',
      'none — not a burnt-area scenario',
      'A single spurious detection leaves no burnt area by definition, so the archive cannot ' +
        'contain one; S5 stays constructed.',
    ),
    selectS6(fires),
  ];
}

// ---------------------------------------------------------------------------------
// The asset
// ---------------------------------------------------------------------------------

export interface SourceFile {
  readonly layer: string;
  readonly url: string;
  readonly fetched_at: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly features: number;
  readonly dropped: number;
}

export interface CandidatesAsset {
  readonly format: typeof FORMAT;
  readonly rules: typeof RULES_VERSION;
  readonly task: string;
  readonly attribution: string;
  readonly licence: string;
  readonly outline: string;
  readonly caveats: readonly string[];
  readonly out_of_scope: Readonly<Record<string, string>>;
  readonly sources: readonly SourceFile[];
  readonly scenarios: readonly ScenarioSelection[];
}

export function buildCandidates(
  sources: readonly SourceFile[],
  fires: readonly BaFire[],
  outline: Outline,
  outlineSource: string,
): CandidatesAsset {
  const years = YEARS.map(String);
  return {
    format: FORMAT,
    rules: RULES_VERSION,
    task: 'TASKS D5 (A6 fixture sourcing): candidates only — which one becomes each fixture is a founder decision',
    attribution: `© European Union, ${years[0] ?? ''}–${years[years.length - 1] ?? ''}, European Forest Fire Information System (EFFIS)`,
    licence: 'CC BY 4.0',
    outline: outlineSource,
    caveats: [
      'FIREDATE/FINALDATE are the first and last mapping dates of the perimeter, not ignition and extinction; EFFIS states no time zone.',
      'EFFIS BA has no wildfire/agricultural flag; agri_pct is the AGRIAREAS land-cover share.',
      'EFFIS revises perimeters (LASTUPDATE); the sha256 of each source file pins the version read.',
    ],
    out_of_scope: {
      'availability.json':
        'not built: it models NRT lag sampled from a measured distribution (C9/WP1), and no measured lag exists yet',
      'S7-S16': 'not sourced here: the pre-season set and the suites are D6',
    },
    sources,
    scenarios: selectAll(fires, outline),
  };
}

/** Stable bytes: header fields pretty, one fire record per line. */
export function serializeCandidates(asset: CandidatesAsset): string {
  const { sources, scenarios, ...header } = asset;
  const lines: string[] = ['{'];
  for (const [key, value] of Object.entries(header)) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push('  "sources": [');
  lines.push(sources.map((s) => `    ${JSON.stringify(s)}`).join(',\n'));
  lines.push('  ],');
  lines.push('  "scenarios": [');
  const blocks = scenarios.map((scenario) => {
    const { candidates, ...head } = scenario;
    const headText = JSON.stringify(head).slice(0, -1);
    if (candidates.length === 0) return `    ${headText},"candidates":[]}`;
    const body = candidates
      .map((c) => {
        const fires = c.fires.map((f) => `        ${JSON.stringify(f)}`).join(',\n');
        return `      {"rank":${String(c.rank)},"evidence":${JSON.stringify(c.evidence)},"fires":[\n${fires}\n      ]}`;
      })
      .join(',\n');
    return `    ${headText},"candidates":[\n${body}\n    ]}`;
  });
  lines.push(blocks.join(',\n'));
  lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
