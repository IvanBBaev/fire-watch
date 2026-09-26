/**
 * The pure planning core of the self-hosted basemap (TASKS G1; ADR-001 A1.1).
 *
 * Everything the tile build decides before it touches a byte lives here, as data and
 * pure functions: which tiles an extract covers (bbox × zoom → tile ranges and an exact
 * count), where each tile lands in the bucket (the key layout), and the HTTP headers an
 * object is served with. The CLI and `build.sh` only execute what this module plans, so
 * the plan can be tested on tiny inputs and read by a reviewer without running anything.
 *
 * **Extract shape.** One `pmtiles extract` takes one bbox and one max zoom. A Balkan box
 * at z14 plus a Europe-wide context box at low zoom is two extracts over the same
 * archive, exploded into the same tree: a tile both cover is byte-identical in both, so
 * the union is well-defined and the count below is the count of distinct tiles.
 *
 * **Key layout** (bucket-relative, no leading slash):
 *   tiles/<version>/<z>/<x>/<y>.mvt              vector tiles, immutable
 *   fonts/<version>/<fontstack>/<start>-<end>.pbf glyph ranges, immutable
 *   dem/terrarium/<z>/<x>/<y>.png                 Terrarium DEM mirror, immutable
 * Every prefix that can change carries a version, so every object is cached for a year
 * and a new build is a new prefix; the only thing that moves on deploy is the client
 * config naming the prefix (ADR-001 "style JSON URL swap"). The rule the E3 mirror
 * follows applies here too: data first, pointer last — the config is switched only
 * after the upload of the tree it names has finished.
 */

/** Degrees, WGS84. Same field names as `polling_bbox_v1` (server/src/core/config). */
export interface BoundingBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** One `pmtiles extract` run: a box and the zoom band it is cut at. */
export interface ExtractTier {
  readonly name: string;
  readonly bbox: BoundingBox;
  readonly minzoom: number;
  readonly maxzoom: number;
}

/** Inclusive tile index ranges at one zoom. */
export interface TileRange {
  readonly z: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface TileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

/** ADR-001 A1.1: "max z14". MapLibre overzooms the z14 tiles past it. */
export const MAX_TILE_ZOOM = 14;

/** The Web-Mercator latitude limit; a bbox edge past it is clamped, not rejected. */
export const MERCATOR_MAX_LAT = 85.0511287798066;

/**
 * The default extract (a founder decision, see the G1 report): the Balkans at full
 * detail, Europe as low-zoom context so panning out never shows an empty world.
 *
 * `balkans` contains the polled FIRMS box (`polling_bbox_v1`: 20/39 to 31/46) with about
 * a degree of margin, so a fire at the poll edge still sits on detailed tiles; it also
 * contains Bulgaria + 100 km (COVERED_AREA) and the Slavyanka/Greek border fixture S1.
 */
export const DEFAULT_EXTRACT_TIERS: readonly ExtractTier[] = [
  {
    name: 'europe',
    bbox: { west: -25, south: 34, east: 45, north: 72 },
    minzoom: 0,
    maxzoom: 8,
  },
  {
    name: 'balkans',
    bbox: { west: 18.5, south: 37.5, east: 32.5, north: 47.5 },
    minzoom: 0,
    maxzoom: MAX_TILE_ZOOM,
  },
];

export function assertBoundingBox(bbox: BoundingBox, where = 'bbox'): void {
  for (const [name, value] of Object.entries(bbox)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`${where}.${name} must be a finite number, got ${String(value)}`);
    }
  }
  if (bbox.west >= bbox.east) {
    throw new RangeError(`${where}: west (${bbox.west}) must be strictly west of east (${bbox.east})`);
  }
  if (bbox.south >= bbox.north) {
    throw new RangeError(
      `${where}: south (${bbox.south}) must be strictly south of north (${bbox.north})`,
    );
  }
  if (bbox.west < -180 || bbox.east > 180 || bbox.south < -90 || bbox.north > 90) {
    throw new RangeError(`${where}: outside [-180, 180] × [-90, 90]`);
  }
}

export function assertTier(tier: ExtractTier): void {
  assertBoundingBox(tier.bbox, `tier ${tier.name}`);
  for (const [name, zoom] of [
    ['minzoom', tier.minzoom],
    ['maxzoom', tier.maxzoom],
  ] as const) {
    if (!Number.isInteger(zoom) || zoom < 0 || zoom > MAX_TILE_ZOOM) {
      throw new RangeError(
        `tier ${tier.name}: ${name} must be an integer in [0, ${MAX_TILE_ZOOM}], got ${zoom}`,
      );
    }
  }
  if (tier.minzoom > tier.maxzoom) {
    throw new RangeError(`tier ${tier.name}: minzoom ${tier.minzoom} > maxzoom ${tier.maxzoom}`);
  }
}

/** The slippy-map tile containing a point; edges are inclusive of the west/north tile. */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const rad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/** The tiles a bbox touches at zoom `z` — what `pmtiles extract --bbox` keeps. */
export function tileRange(bbox: BoundingBox, z: number): TileRange {
  assertBoundingBox(bbox);
  const northWest = lonLatToTile(bbox.west, bbox.north, z);
  const southEast = lonLatToTile(bbox.east, bbox.south, z);
  return { z, minX: northWest.x, maxX: southEast.x, minY: northWest.y, maxY: southEast.y };
}

export function rangeSize(range: TileRange): number {
  return (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
}

/** Merged, sorted, disjoint inclusive intervals. */
function unionIntervals(intervals: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [low, high] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else out.push([low, high]);
  }
  return out;
}

/** Ranges of every tier that includes zoom `z`. */
export function rangesAtZoom(tiers: readonly ExtractTier[], z: number): TileRange[] {
  return tiers
    .filter((tier) => tier.minzoom <= z && z <= tier.maxzoom)
    .map((tier) => tileRange(tier.bbox, z));
}

/** Per-row x intervals of the union of `ranges` (one zoom). Rows are sorted by y. */
function rowIntervals(ranges: readonly TileRange[]): Array<readonly [number, Array<[number, number]>]> {
  const rows = new Map<number, Array<readonly [number, number]>>();
  for (const range of ranges) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      const row = rows.get(y) ?? [];
      row.push([range.minX, range.maxX]);
      rows.set(y, row);
    }
  }
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, intervals]) => [y, unionIntervals(intervals)] as const);
}

export interface TileCountEstimate {
  /** Distinct tiles per zoom over the union of all tiers. */
  readonly byZoom: ReadonlyArray<{ readonly z: number; readonly tiles: number }>;
  readonly total: number;
  readonly maxzoom: number;
}

/**
 * The exact number of distinct tiles the tiers cover — an upper bound on what the extract
 * holds (Protomaps omits nothing inside the bbox, but a run-length ocean tile is still one
 * object per z/x/y once exploded). This is the PUT count of an upload, which is what R2
 * bills (class A operations).
 */
export function countTiles(tiers: readonly ExtractTier[]): TileCountEstimate {
  if (tiers.length === 0) throw new RangeError('no extract tiers');
  tiers.forEach(assertTier);
  const maxzoom = Math.max(...tiers.map((tier) => tier.maxzoom));
  const byZoom: Array<{ z: number; tiles: number }> = [];
  for (let z = 0; z <= maxzoom; z += 1) {
    let tiles = 0;
    for (const [, intervals] of rowIntervals(rangesAtZoom(tiers, z))) {
      for (const [low, high] of intervals) tiles += high - low + 1;
    }
    byZoom.push({ z, tiles });
  }
  return { byZoom, total: byZoom.reduce((sum, row) => sum + row.tiles, 0), maxzoom };
}

/** Every distinct tile the tiers cover, zoom by zoom, row by row. Lazy: z14 is large. */
export function* enumerateTiles(tiers: readonly ExtractTier[]): Generator<TileCoord> {
  tiers.forEach(assertTier);
  const maxzoom = Math.max(...tiers.map((tier) => tier.maxzoom));
  for (let z = 0; z <= maxzoom; z += 1) {
    for (const [y, intervals] of rowIntervals(rangesAtZoom(tiers, z))) {
      for (const [low, high] of intervals) {
        for (let x = low; x <= high; x += 1) yield { z, x, y };
      }
    }
  }
}

/** True when some tier covers the tile — the explode step's sanity check per tile. */
export function tierCovers(tiers: readonly ExtractTier[], tile: TileCoord): boolean {
  return rangesAtZoom(tiers, tile.z).some(
    (range) =>
      tile.x >= range.minX && tile.x <= range.maxX && tile.y >= range.minY && tile.y <= range.maxY,
  );
}

// ---------------------------------------------------------------------------------------
// Key layout and headers.

/** The three tree kinds this build writes to the bucket. */
export type TilesetKind = 'vector' | 'glyphs' | 'dem';

/** How an object of one kind is served. Every field becomes a response header. */
export interface ObjectHeaders {
  readonly contentType: string;
  /** Set only when the stored bytes are compressed and the browser must inflate them. */
  readonly contentEncoding: string | null;
  readonly cacheControl: string;
}

/**
 * One year, immutable: every key below sits under a version prefix (or, for the DEM, is
 * an upstream-fixed dataset), so the bytes at a key never change. A client revisiting a
 * view makes no request at all — this is what keeps a traffic spike off the bucket.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * The IANA-registered MVT type. Protomaps tiles are gzip-compressed inside the archive and
 * exploded as-is, so the object carries `Content-Encoding: gzip` and the browser inflates;
 * the bucket never re-compresses.
 */
export const VECTOR_TILE_CONTENT_TYPE = 'application/vnd.mapbox-vector-tile';
export const GLYPH_CONTENT_TYPE = 'application/x-protobuf';
export const DEM_CONTENT_TYPE = 'image/png';

export function headersFor(kind: TilesetKind, tileCompression: 'gzip' | 'none' = 'gzip'): ObjectHeaders {
  switch (kind) {
    case 'vector':
      return {
        contentType: VECTOR_TILE_CONTENT_TYPE,
        contentEncoding: tileCompression === 'gzip' ? 'gzip' : null,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      };
    case 'glyphs':
      return { contentType: GLYPH_CONTENT_TYPE, contentEncoding: null, cacheControl: IMMUTABLE_CACHE_CONTROL };
    case 'dem':
      return { contentType: DEM_CONTENT_TYPE, contentEncoding: null, cacheControl: IMMUTABLE_CACHE_CONTROL };
  }
}

/**
 * The E3 mirror's key rule (`server/src/core/snapshot/mirror-plan.ts`), restated because
 * infra imports nothing from `server/`: segments of `[A-Za-z0-9._-]`, no empty, `.` or
 * `..` segment. Glyph fontstack segments additionally allow a space ("Noto Sans
 * Regular") — MapLibre requests the percent-encoded name and the bucket's public
 * hostname decodes it back to this key.
 */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/u;
const FONTSTACK_SEGMENT_RE = /^[A-Za-z0-9._-][A-Za-z0-9._ -]*[A-Za-z0-9._-]$/u;

export function isValidKey(key: string, options: { allowSpaces?: boolean } = {}): boolean {
  if (key.length === 0 || key.length > 512) return false;
  const segment = options.allowSpaces === true ? FONTSTACK_SEGMENT_RE : SEGMENT_RE;
  return key
    .split('/')
    .every((part) => part !== '.' && part !== '..' && (SEGMENT_RE.test(part) || segment.test(part)));
}

/**
 * A build version: a UTC calendar date plus an optional suffix, e.g. `20260924` or
 * `20260924-2`. Dates sort, so the newest prefix is obvious in a bucket listing.
 */
const VERSION_RE = /^\d{8}(?:-[a-z0-9]{1,16})?$/u;

export function assertVersion(version: string): void {
  if (!VERSION_RE.test(version)) {
    throw new RangeError(`version ${JSON.stringify(version)} must look like 20260924 or 20260924-2`);
  }
}

export function vectorTilePrefix(version: string): string {
  assertVersion(version);
  return `tiles/${version}`;
}

export function vectorTileKey(version: string, tile: TileCoord): string {
  return `${vectorTilePrefix(version)}/${tile.z}/${tile.x}/${tile.y}.mvt`;
}

export function glyphPrefix(version: string): string {
  assertVersion(version);
  return `fonts/${version}`;
}

export const DEM_PREFIX = 'dem/terrarium';

export function demTileKey(tile: TileCoord): string {
  return `${DEM_PREFIX}/${tile.z}/${tile.x}/${tile.y}.png`;
}

/** What the client config must hold once a build is live (`ClientConfig.outdoorBasemap`). */
export interface ClientUrlTemplates {
  readonly tilesUrl: string;
  readonly glyphsUrl: string;
  readonly demTilesUrl: string;
}

/** The URL templates for a public hostname, e.g. `https://tiles.example.org`. */
export function clientUrlTemplates(
  publicBaseUrl: string,
  tilesVersion: string,
  glyphsVersion: string,
): ClientUrlTemplates {
  const base = new URL(publicBaseUrl);
  if (base.protocol !== 'https:') throw new RangeError('the public tile host must be https');
  const root = base.href.replace(/\/+$/u, '');
  return {
    tilesUrl: `${root}/${vectorTilePrefix(tilesVersion)}/{z}/{x}/{y}.mvt`,
    glyphsUrl: `${root}/${glyphPrefix(glyphsVersion)}/{fontstack}/{range}.pbf`,
    demTilesUrl: `${root}/${DEM_PREFIX}/{z}/{x}/{y}.png`,
  };
}

// ---------------------------------------------------------------------------------------
// Upload plan.

/** One directory copy: a local tree to a bucket prefix, every object with one header set. */
export interface UploadStep {
  readonly label: string;
  readonly localDir: string;
  readonly prefix: string;
  readonly headers: ObjectHeaders;
  /** Objects this step writes, when known — the PUT count R2 bills. */
  readonly objects: number | null;
}

export interface UploadPlanInput {
  readonly tilesDir: string;
  readonly tilesVersion: string;
  readonly tileCount: number;
  readonly tileCompression: 'gzip' | 'none';
  readonly glyphsDir: string | null;
  readonly glyphsVersion: string | null;
  readonly glyphCount: number | null;
}

/**
 * Data only — there is no pointer object in the bucket: the pointer is the client config,
 * switched after these steps succeed. Glyphs go first because a style naming a new tile
 * version renders nothing without them, never the other way round.
 */
export function planUpload(input: UploadPlanInput): UploadStep[] {
  const steps: UploadStep[] = [];
  if (input.glyphsDir !== null) {
    if (input.glyphsVersion === null) throw new RangeError('glyphsDir given without glyphsVersion');
    steps.push({
      label: 'glyph ranges',
      localDir: input.glyphsDir,
      prefix: glyphPrefix(input.glyphsVersion),
      headers: headersFor('glyphs'),
      objects: input.glyphCount,
    });
  }
  steps.push({
    label: 'vector tiles',
    localDir: input.tilesDir,
    prefix: vectorTilePrefix(input.tilesVersion),
    headers: headersFor('vector', input.tileCompression),
    objects: input.tileCount,
  });
  return steps;
}

/** POSIX single-quote escaping for one shell word. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/gu, `'\\''`)}'`;
}

/**
 * The `rclone copy` command for a step: one header set per tree, so the whole tree is one
 * command, and `--header-upload` stamps every PUT. `remote` is an rclone remote with the
 * bucket, e.g. `r2:fire-watch-tiles`. `--no-update-modtime`/`--size-only` keep a re-run
 * of an interrupted upload from re-sending what already landed.
 */
export function rcloneCommand(step: UploadStep, remote: string): string {
  if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9._-]+$/u.test(remote)) {
    throw new RangeError(`rclone remote ${JSON.stringify(remote)} must look like r2:bucket-name`);
  }
  const headers = [
    `Content-Type: ${step.headers.contentType}`,
    ...(step.headers.contentEncoding === null ? [] : [`Content-Encoding: ${step.headers.contentEncoding}`]),
    `Cache-Control: ${step.headers.cacheControl}`,
  ];
  return [
    'rclone copy',
    shellQuote(step.localDir),
    shellQuote(`${remote}/${step.prefix}`),
    ...headers.map((header) => `--header-upload ${shellQuote(header)}`),
    '--size-only --no-update-modtime --s3-no-check-bucket',
    '--transfers 64 --checkers 64 --fast-list',
  ].join(' ');
}
