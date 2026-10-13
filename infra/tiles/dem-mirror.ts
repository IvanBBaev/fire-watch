/**
 * The Terrarium DEM mirror (TASKS G3): a copy of the public AWS Terrain Tiles that the
 * outdoor style's hillshade reads instead of the upstream bucket (WP5: zero third-party
 * runtime tile dependencies).
 *
 * **Source.** Registry of Open Data on AWS, "Terrain Tiles"
 * (https://registry.opendata.aws/terrain-tiles/, checked 2026-10-10): S3 bucket
 * `elevation-tiles-prod` (us-east-1), anonymous HTTPS, managed by Mapzen (a Linux
 * Foundation project). The registry's licence field is the Tilezen attribution page
 * (`tilezen/joerd` docs/attribution.md) — the data is a composite of public-domain and
 * attribution-licensed DEMs; over the Balkans that is EU-DEM, SRTM, GMTED2010 and ETOPO1,
 * whose credits live in `packages/contracts/src/credits.ts` (`terrarium-*`, condition
 * `layer:terrain`). The EU replica `elevation-tiles-prod-eu` (eu-central-1) answered 403
 * to anonymous HTTPS GETs on 2026-10-10, so the us-east-1 bucket is the source. Upstream
 * objects date from 2017 and do not change; the mirror is fetched once and kept.
 *
 * **Zoom.** Terrarium goes to z15, but the data under it does not: in Europe the finest
 * component is EU-DEM / SRTM at ~30 m, and a 256-px tile at z12 is ~28 m/px at 42° N —
 * the first zoom at which a pixel is as fine as the data. z13+ would only resample the same
 * 30 m grid (4× the tiles per step for no new relief), and the style's hillshade already
 * overzooms its source past `maxzoom` (`web/src/map/outdoor-style.ts` DEM_MAXZOOM = 12).
 * So the mirror uses the basemap's tiers capped at z12.
 *
 * **Layout.** Tiles land at `<work>/dem/terrarium/{z}/{x}/{y}.png` — the bucket key
 * (`demTileKey`) under the work directory, so the upload is one `rclone copy` of
 * `<work>/dem/terrarium` and `dev-serve.ts` serves the same tree. The sha256 manifest sits
 * beside it at `<work>/dem/manifest.json`, outside the uploaded tree.
 *
 * Pure planning, manifest and validation here; the fetch loop at the bottom takes its
 * network, clock and sleep as arguments, so it is tested without either.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  assertTier,
  DEM_PREFIX,
  demTileKey,
  type ExtractTier,
  headersFor,
  type TileCoord,
  type UploadStep,
} from './tile-plan.js';

export const DEM_SOURCE = {
  registry: 'https://registry.opendata.aws/terrain-tiles/',
  bucket: 's3://elevation-tiles-prod (us-east-1)',
  urlTemplate: 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png',
  licence: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
  encoding: 'terrarium',
  tileSize: 256,
  /** The deepest zoom upstream publishes. */
  upstreamMaxzoom: 15,
} as const;

/** See the module comment: ~28 m/px at 42° N, the resolution of the data itself. */
export const DEM_MAXZOOM = 12;

export const DEM_MANIFEST_FORMAT = 'fire-watch/dem-mirror@1';

/** `<work>/dem/…` — the manifest stays outside the uploaded `terrarium/` tree. */
export function demManifestPath(workDir: string): string {
  return join(workDir, 'dem', 'manifest.json');
}

export function demTileFile(workDir: string, tile: TileCoord): string {
  return join(workDir, demTileKey(tile));
}

/**
 * The basemap tiers, each capped at `maxzoom`; a tier that starts above it is dropped.
 * The DEM covers the same boxes as the vector tiles, so a view with detailed tiles has
 * relief, and nothing outside them is fetched.
 */
export function demTiers(tiers: readonly ExtractTier[], maxzoom: number = DEM_MAXZOOM): ExtractTier[] {
  if (!Number.isInteger(maxzoom) || maxzoom < 0 || maxzoom > DEM_SOURCE.upstreamMaxzoom) {
    throw new RangeError(`DEM maxzoom must be an integer in [0, ${DEM_SOURCE.upstreamMaxzoom}], got ${maxzoom}`);
  }
  tiers.forEach(assertTier);
  const capped = tiers
    .filter((tier) => tier.minzoom <= maxzoom)
    .map((tier) => ({ ...tier, maxzoom: Math.min(tier.maxzoom, maxzoom) }));
  if (capped.length === 0) throw new RangeError(`no tier starts at or below z${maxzoom}`);
  return capped;
}

/** `[west, south, east, north]` in degrees — the order of a TileJSON / MapLibre `bounds`. */
export type DemBounds = readonly [west: number, south: number, east: number, north: number];

/**
 * The extent the client's `raster-dem` source should declare as `bounds`: the smallest box
 * holding every tier of the mirror (the tiers come from its manifest, so this is the
 * extent actually fetched, not a box chosen here). MapLibre then requests no DEM tile that
 * misses the box — past it every request would be a 404. `bounds` is one box for every
 * zoom, so where tiers stop at different zooms (Europe to z8 around a Balkans tier to z12)
 * the deeper zooms between the inner and outer box still miss; it removes the requests
 * outside the mirror altogether, not every one at its inner edges.
 */
export function demBounds(tiers: readonly ExtractTier[]): DemBounds {
  if (tiers.length === 0) throw new RangeError('a DEM mirror without tiers has no extent');
  tiers.forEach(assertTier);
  return [
    Math.min(...tiers.map((tier) => tier.bbox.west)),
    Math.min(...tiers.map((tier) => tier.bbox.south)),
    Math.max(...tiers.map((tier) => tier.bbox.east)),
    Math.max(...tiers.map((tier) => tier.bbox.north)),
  ];
}

/**
 * The upload of a finished mirror: `<work>/dem/terrarium` to the bucket's `dem/terrarium/`
 * (the key `clientUrlTemplates` points `demTilesUrl` at), PNG + immutable. Unversioned,
 * unlike the vector tiles: the upstream pyramid has not changed since 2017.
 */
export function demUploadStep(workDir: string, objects: number | null): UploadStep {
  return {
    label: 'Terrarium DEM',
    localDir: join(workDir, DEM_PREFIX),
    prefix: DEM_PREFIX,
    headers: headersFor('dem'),
    objects,
  };
}

export function tileId(tile: TileCoord): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

export function demTileUrl(tile: TileCoord, template: string = DEM_SOURCE.urlTemplate): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

// ---------------------------------------------------------------------------------------
// Validation.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Why `bytes` is not a Terrarium tile, or `null` when it is one: a PNG whose first chunk
 * is IHDR with 256 × 256 px, 8 bits per channel, RGB or RGBA. Catches an S3 error document
 * served with 200, a truncated download, and a tile from some other pyramid.
 */
export function terrariumPngProblem(bytes: Uint8Array): string | null {
  if (bytes.length < 33) return `too short for a PNG (${bytes.length} bytes)`;
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return 'not a PNG (signature)';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = String.fromCharCode(...bytes.subarray(12, 16));
  if (view.getUint32(8) !== 13 || type !== 'IHDR') return 'first chunk is not a 13-byte IHDR';
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width !== DEM_SOURCE.tileSize || height !== DEM_SOURCE.tileSize) {
    return `${width}×${height} px, expected ${DEM_SOURCE.tileSize}×${DEM_SOURCE.tileSize}`;
  }
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    return `bit depth ${String(bitDepth)} colour type ${String(colorType)}, expected 8-bit RGB(A)`;
  }
  return null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------------------
// Manifest.

export interface DemManifestEntry {
  readonly sha256: string;
  readonly bytes: number;
  /** Upstream validators, kept so a later re-check can ask S3 whether a tile moved. */
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface DemManifest {
  readonly format: typeof DEM_MANIFEST_FORMAT;
  readonly source: {
    readonly urlTemplate: string;
    readonly registry: string;
    readonly licence: string;
    readonly encoding: string;
  };
  readonly maxzoom: number;
  readonly tiers: readonly ExtractTier[];
  readonly updatedAt: string;
  /** Keyed by `z/x/y`. */
  readonly tiles: Readonly<Record<string, DemManifestEntry>>;
}

export function emptyDemManifest(tiers: readonly ExtractTier[], maxzoom: number, now: Date): DemManifest {
  return {
    format: DEM_MANIFEST_FORMAT,
    source: {
      urlTemplate: DEM_SOURCE.urlTemplate,
      registry: DEM_SOURCE.registry,
      licence: DEM_SOURCE.licence,
      encoding: DEM_SOURCE.encoding,
    },
    maxzoom,
    tiers,
    updatedAt: now.toISOString(),
    tiles: {},
  };
}

const TILE_ID_RE = /^\d{1,2}\/\d{1,6}\/\d{1,6}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;

/** Parses and checks a manifest read from disk; throws naming the first bad field. */
export function parseDemManifest(json: unknown): DemManifest {
  const fail = (what: string): never => {
    throw new Error(`DEM manifest: ${what}`);
  };
  if (typeof json !== 'object' || json === null) return fail('not an object');
  const record = json as Record<string, unknown>;
  if (record['format'] !== DEM_MANIFEST_FORMAT) return fail(`format is not ${DEM_MANIFEST_FORMAT}`);
  const source = record['source'] as Record<string, unknown> | undefined;
  if (typeof source !== 'object' || source === null || typeof source['urlTemplate'] !== 'string') {
    return fail('source.urlTemplate missing');
  }
  const maxzoom = record['maxzoom'];
  if (typeof maxzoom !== 'number' || !Number.isInteger(maxzoom)) return fail('maxzoom is not an integer');
  const tiers = record['tiers'];
  if (!Array.isArray(tiers)) return fail('tiers is not an array');
  (tiers as ExtractTier[]).forEach(assertTier);
  const tiles = record['tiles'];
  if (typeof tiles !== 'object' || tiles === null || Array.isArray(tiles)) return fail('tiles is not an object');
  for (const [id, entry] of Object.entries(tiles as Record<string, unknown>)) {
    if (!TILE_ID_RE.test(id)) return fail(`tile id ${JSON.stringify(id)} is not z/x/y`);
    const e = entry as Partial<DemManifestEntry> | null;
    if (typeof e !== 'object' || e === null) return fail(`${id}: not an object`);
    if (typeof e.sha256 !== 'string' || !SHA256_RE.test(e.sha256)) return fail(`${id}: sha256 is not 64 hex`);
    if (typeof e.bytes !== 'number' || !Number.isInteger(e.bytes) || e.bytes <= 0) {
      return fail(`${id}: bytes is not a positive integer`);
    }
  }
  return json as DemManifest;
}

export interface DemManifestSummary {
  readonly tiles: number;
  readonly bytes: number;
  readonly byZoom: Readonly<Record<string, number>>;
}

export function summarizeDemManifest(manifest: DemManifest): DemManifestSummary {
  const byZoom: Record<string, number> = {};
  let bytes = 0;
  const ids = Object.keys(manifest.tiles);
  for (const id of ids) {
    const z = id.slice(0, id.indexOf('/'));
    byZoom[z] = (byZoom[z] ?? 0) + 1;
    bytes += manifest.tiles[id]?.bytes ?? 0;
  }
  return { tiles: ids.length, bytes, byZoom };
}

// ---------------------------------------------------------------------------------------
// Resume plan and verification.

export interface DemMirrorPlan {
  /** Tiles to download, in plan order. */
  readonly fetch: readonly TileCoord[];
  /** Tiles already present: a manifest entry and a file of the recorded size. */
  readonly present: number;
  /** Manifest entries outside the plan (a narrower re-run); kept, never deleted. */
  readonly outsidePlan: number;
}

/**
 * What a run still has to fetch. A tile counts as present only when the manifest has it
 * **and** the file on disk has the recorded size — a file without an entry (killed between
 * the rename and the manifest checkpoint) or a short file is fetched again. `dem-verify`
 * re-hashes; resuming does not, so it stays cheap.
 */
export function planDemMirror(
  tiles: Iterable<TileCoord>,
  manifest: DemManifest,
  sizeOnDisk: (tile: TileCoord) => number | null,
): DemMirrorPlan {
  const fetch: TileCoord[] = [];
  const planned = new Set<string>();
  let present = 0;
  for (const tile of tiles) {
    const id = tileId(tile);
    planned.add(id);
    const entry = manifest.tiles[id];
    if (entry !== undefined && sizeOnDisk(tile) === entry.bytes) present += 1;
    else fetch.push(tile);
  }
  const outsidePlan = Object.keys(manifest.tiles).filter((id) => !planned.has(id)).length;
  return { fetch, present, outsidePlan };
}

export interface DemFinding {
  readonly id: string;
  readonly problem: string;
}

/** Every planned tile is in the manifest, on disk, hashes to the entry and is a Terrarium PNG. */
export function verifyDemMirror(
  tiles: Iterable<TileCoord>,
  manifest: DemManifest,
  read: (tile: TileCoord) => Uint8Array | null,
): DemFinding[] {
  const findings: DemFinding[] = [];
  for (const tile of tiles) {
    const id = tileId(tile);
    const entry = manifest.tiles[id];
    const bytes = read(tile);
    if (entry === undefined) findings.push({ id, problem: 'not in the manifest' });
    else if (bytes === null) findings.push({ id, problem: 'missing on disk' });
    else if (sha256Hex(bytes) !== entry.sha256) findings.push({ id, problem: 'sha256 differs from the manifest' });
    else {
      const problem = terrariumPngProblem(bytes);
      if (problem !== null) findings.push({ id, problem });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------
// Politeness.

/**
 * Spaces request starts at most `ratePerSecond` apart, across all workers. `next()` books
 * the next slot and returns how long to wait for it. Pure over the injected clock.
 */
export function createPacer(ratePerSecond: number, now: () => number): { next(): number } {
  if (!(ratePerSecond > 0) || ratePerSecond > 50) throw new RangeError('rate must be in (0, 50] requests/s');
  const interval = 1000 / ratePerSecond;
  let slot = -Infinity;
  return {
    next() {
      const t = now();
      slot = Math.max(t, slot + interval);
      return slot - t;
    },
  };
}

/**
 * Back-off before retry `attempt` (1-based) after `status` (`null` = network error), or
 * `null` when the failure is final. S3 throttles with 503 SlowDown; 429 and 5xx are worth a
 * retry, any other 4xx (403/404: the key is not there) is not.
 */
export function retryDelayMs(attempt: number, status: number | null, maxAttempts: number): number | null {
  if (attempt >= maxAttempts) return null;
  const retryable = status === null || status === 429 || status >= 500;
  if (!retryable) return null;
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

// ---------------------------------------------------------------------------------------
// The fetch loop (I/O injected).

export interface DemFetchResponse {
  readonly status: number;
  readonly body: Uint8Array;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface MirrorDemOptions {
  readonly workDir: string;
  readonly manifest: DemManifest;
  readonly tiles: readonly TileCoord[];
  readonly fetchTile: (url: string) => Promise<DemFetchResponse>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly ratePerSecond: number;
  readonly concurrency: number;
  readonly maxAttempts?: number;
  /** Write the manifest after this many new tiles (and at the end). */
  readonly checkpointEvery?: number;
  readonly urlTemplate?: string;
  readonly log?: (line: string) => void;
}

export interface MirrorDemResult {
  readonly manifest: DemManifest;
  readonly fetched: number;
  readonly bytes: number;
  readonly failed: readonly DemFinding[];
}

function writeAtomic(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  writeFileSync(part, bytes);
  renameSync(part, path);
}

export function readDemManifest(workDir: string): DemManifest | null {
  const path = demManifestPath(workDir);
  if (!existsSync(path)) return null;
  return parseDemManifest(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeDemManifest(workDir: string, manifest: DemManifest): void {
  // Sorted keys: two runs over the same tiles write the same file.
  const tiles = Object.fromEntries(Object.entries(manifest.tiles).sort(([a], [b]) => a.localeCompare(b)));
  writeAtomic(demManifestPath(workDir), `${JSON.stringify({ ...manifest, tiles }, null, 2)}\n`);
}

export function demSizeOnDisk(workDir: string): (tile: TileCoord) => number | null {
  return (tile) => {
    const file = demTileFile(workDir, tile);
    return existsSync(file) ? statSync(file).size : null;
  };
}

/**
 * Downloads `tiles` (normally `planDemMirror(...).fetch`) into the work directory: each
 * tile is checked as a Terrarium PNG, written atomically (`.part` + rename), and recorded
 * with its sha256; the manifest is checkpointed so an interrupted run resumes where it
 * stopped. A tile that fails after its retries is reported, not fatal to the others.
 */
export async function mirrorDem(options: MirrorDemOptions): Promise<MirrorDemResult> {
  const maxAttempts = options.maxAttempts ?? 4;
  const checkpointEvery = options.checkpointEvery ?? 200;
  const log = options.log ?? ((): void => undefined);
  const pacer = createPacer(options.ratePerSecond, options.now);
  const entries: Record<string, DemManifestEntry> = { ...options.manifest.tiles };
  const failed: DemFinding[] = [];
  let fetched = 0;
  let bytes = 0;
  let sinceCheckpoint = 0;
  const snapshot = (): DemManifest => ({
    ...options.manifest,
    updatedAt: new Date(options.now()).toISOString(),
    tiles: { ...entries },
  });

  const fetchOne = async (tile: TileCoord): Promise<void> => {
    const id = tileId(tile);
    const url = demTileUrl(tile, options.urlTemplate);
    for (let attempt = 1; ; attempt += 1) {
      await options.sleep(pacer.next());
      let status: number | null = null;
      let problem: string;
      try {
        const response = await options.fetchTile(url);
        status = response.status;
        if (response.status === 200) {
          const pngProblem = terrariumPngProblem(response.body);
          if (pngProblem === null) {
            writeAtomic(demTileFile(options.workDir, tile), response.body);
            entries[id] = {
              sha256: sha256Hex(response.body),
              bytes: response.body.length,
              etag: response.etag,
              lastModified: response.lastModified,
            };
            fetched += 1;
            bytes += response.body.length;
            sinceCheckpoint += 1;
            return;
          }
          // A 200 that is not a tile is not worth retrying either.
          failed.push({ id, problem: pngProblem });
          return;
        }
        problem = `HTTP ${response.status}`;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      const delay = retryDelayMs(attempt, status, maxAttempts);
      if (delay === null) {
        failed.push({ id, problem: `${problem} after ${attempt} attempt(s)` });
        return;
      }
      log(`${id}: ${problem}, retry ${attempt} in ${delay} ms`);
      await options.sleep(delay);
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < options.tiles.length) {
      const tile = options.tiles[next];
      next += 1;
      if (tile === undefined) break;
      await fetchOne(tile);
      if (sinceCheckpoint >= checkpointEvery) {
        sinceCheckpoint = 0;
        writeDemManifest(options.workDir, snapshot());
        log(`checkpoint: ${Object.keys(entries).length} tiles in the manifest (${fetched} new this run)`);
      }
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency, 16));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  const manifest = snapshot();
  writeDemManifest(options.workDir, manifest);
  return { manifest, fetched, bytes, failed };
}
