/**
 * Serves a locally built basemap to the Vite dev/preview server (TASKS G3).
 *
 * `build.sh` writes `tiles/tree/<version>/{z}/{x}/{y}.mvt` (gzip-stored) and
 * `tiles/fonts/<version>/<fontstack>/<range>.pbf` under a git-ignored work directory.
 * Before an R2 bucket exists, the only way to see the outdoor style render from those
 * bytes is to serve them from the dev server itself: `web/vite.config.ts` mounts this
 * handler under `LOCAL_TILES_PREFIX` when `FIRE_WATCH_LOCAL_TILES_DIR` names that work
 * directory, and the client points `outdoorBasemap` at it (`web/src/core/config.ts`
 * `readLocalTiles`). Unset, nothing is mounted and nothing changes.
 *
 * The Terrarium DEM mirror (`cli.js dem-mirror`) is served from the same prefix when it
 * exists: `<work>/dem/terrarium/{z}/{x}/{y}.png` under the tiles work directory, or under
 * `FIRE_WATCH_LOCAL_DEM_DIR` when the DEM was fetched into a directory of its own. Without
 * one the client gets no `demTilesUrl` and the style draws no hillshade.
 *
 * Node built-ins only (connect-style signature, no Vite types), so it stays in this
 * project and is tested here.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';

import { demBounds, type DemBounds, readDemManifest } from './dem-mirror.js';
import { DEM_PREFIX } from './tile-plan.js';

/** The URL prefix both sides agree on; the client builds its templates from it. */
export const LOCAL_TILES_PREFIX = '/__local-tiles';

export interface LocalTiles {
  /** `<work>/tree/<version>` */
  readonly tilesDir: string;
  /** `<work>/fonts/<version>` */
  readonly glyphsDir: string;
  readonly tilesVersion: string;
  readonly glyphsVersion: string;
  /** `<dem work>/dem/terrarium`, or `null` when no DEM mirror is present. */
  readonly demDir: string | null;
  /**
   * The mirror's extent from its manifest (`<dem work>/dem/manifest.json`), handed to the
   * client as the DEM source's `bounds`; `null` without a mirror or without a manifest.
   */
  readonly demBounds: DemBounds | null;
}

/** The newest `<version>` directory under `dir` (versions are dates, so names sort). */
function newestVersion(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isDirectory())
    .sort();
  return versions.at(-1) ?? null;
}

/**
 * Resolves the work directory `build.sh` wrote into, picking the newest tile and glyph
 * versions unless `version` pins one. Throws with the path it looked at, so a typo in the
 * env var fails the dev server start loudly instead of rendering a blank map.
 */
export function resolveLocalTiles(workDir: string, version?: string, demWorkDir?: string): LocalTiles {
  const root = resolve(workDir);
  const tilesVersion = version ?? newestVersion(join(root, 'tree'));
  const glyphsVersion = version ?? newestVersion(join(root, 'fonts'));
  if (tilesVersion === null) throw new Error(`no tile tree under ${join(root, 'tree')} — run infra/tiles/build.sh`);
  if (glyphsVersion === null) throw new Error(`no glyph build under ${join(root, 'fonts')} — run build.sh --fonts`);
  const tilesDir = join(root, 'tree', tilesVersion);
  const glyphsDir = join(root, 'fonts', glyphsVersion);
  for (const dir of [tilesDir, glyphsDir]) {
    if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
  }
  const demDir = resolveLocalDem(root, demWorkDir);
  return {
    tilesDir,
    glyphsDir,
    tilesVersion,
    glyphsVersion,
    demDir,
    demBounds: demDir === null ? null : localDemBounds(demDir),
  };
}

/**
 * The extent of the mirror at `demDir` (`<dem work>/dem/terrarium`): the union of the tiers
 * its manifest records, which is what `dem-mirror` fetched. No manifest (a tree copied
 * without one) is `null` — the source then has no `bounds`, as before; a manifest that
 * does not parse throws, like every other misconfiguration here.
 */
export function localDemBounds(demDir: string): DemBounds | null {
  const manifest = readDemManifest(dirname(dirname(demDir)));
  return manifest === null ? null : demBounds(manifest.tiers);
}

/**
 * The DEM tree: `<demWorkDir>/dem/terrarium` when a DEM work directory is named — it must
 * exist then, like the tiles directory — else the same path under the tiles work directory
 * if a mirror was fetched there, else `null` (no hillshade).
 */
export function resolveLocalDem(tilesWorkDir: string, demWorkDir?: string): string | null {
  if (demWorkDir !== undefined) {
    const dir = join(resolve(demWorkDir), DEM_PREFIX);
    if (!existsSync(dir)) throw new Error(`no DEM mirror at ${dir} — run "node infra/tiles/dist/cli.js dem-mirror --work <dir> --apply"`);
    return dir;
  }
  const dir = join(resolve(tilesWorkDir), DEM_PREFIX);
  return existsSync(dir) ? dir : null;
}

export interface LocalTilesResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
}

const TILE_PATH = /^\/tiles\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.mvt$/u;
const GLYPH_PATH = /^\/fonts\/([^/]+)\/(\d{1,5})-(\d{1,5})\.pbf$/u;
const DEM_PATH = /^\/dem\/terrarium\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.png$/u;

/**
 * The response for one request path below the prefix (`/tiles/…` or `/fonts/…`), or
 * `null` when the path is not ours. Pure apart from reading the file.
 *
 * - A tile outside the extract's tiers is a 204: MapLibre draws an empty tile for it,
 *   which is what the R2 tree will look like at its edges too.
 * - Tiles are stored gzip-compressed (the R2 upload sets `Content-Encoding: gzip`); the
 *   same header here lets the browser inflate them, exactly as from the bucket.
 * - The fontstack segment is URL-decoded (`Noto%20Sans%20Regular`) and must stay inside
 *   the glyph directory.
 * - A DEM tile outside the mirror is a 404, as the bucket would answer. Not a 204: MapLibre
 *   turns an empty raster-dem body into a 1 px tile, and backfilling a 256 px neighbour's
 *   border from it throws ("dem dimension mismatch"); a 404 only marks that tile errored.
 */
export function localTilesResponse(local: LocalTiles, path: string): LocalTilesResponse | null {
  const tile = TILE_PATH.exec(path);
  if (tile !== null) {
    const [, z, x, y] = tile;
    const file = join(local.tilesDir, z ?? '', x ?? '', `${y ?? ''}.mvt`);
    if (!existsSync(file)) return { status: 204, headers: { 'Cache-Control': 'no-cache' }, body: null };
    const body = new Uint8Array(readFileSync(file));
    const gzip = body[0] === 0x1f && body[1] === 0x8b;
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.mapbox-vector-tile',
        ...(gzip && { 'Content-Encoding': 'gzip' }),
        'Cache-Control': 'no-cache',
      },
      body,
    };
  }
  const glyph = GLYPH_PATH.exec(path);
  if (glyph !== null) {
    let fontstack: string;
    try {
      fontstack = decodeURIComponent(glyph[1] ?? '');
    } catch {
      return { status: 400, headers: {}, body: null };
    }
    const file = resolve(local.glyphsDir, fontstack, `${glyph[2] ?? ''}-${glyph[3] ?? ''}.pbf`);
    if (!file.startsWith(local.glyphsDir + sep) || !existsSync(file)) return { status: 404, headers: {}, body: null };
    return {
      status: 200,
      headers: { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'no-cache' },
      body: new Uint8Array(readFileSync(file)),
    };
  }
  const dem = DEM_PATH.exec(path);
  if (dem !== null) {
    const file = local.demDir === null ? null : join(local.demDir, dem[1] ?? '', dem[2] ?? '', `${dem[3] ?? ''}.png`);
    if (file === null || !existsSync(file)) return { status: 404, headers: { 'Cache-Control': 'no-cache' }, body: null };
    return {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
      body: new Uint8Array(readFileSync(file)),
    };
  }
  return null;
}

/** Connect-style middleware for Vite's `server.middlewares` / `preview.middlewares`. */
export function localTilesMiddleware(
  local: LocalTiles,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith(`${LOCAL_TILES_PREFIX}/`)) {
      next();
      return;
    }
    const response = localTilesResponse(local, url.slice(LOCAL_TILES_PREFIX.length).split('?')[0] ?? '');
    if (response === null) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = response.status;
    for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
    res.end(response.body === null ? undefined : Buffer.from(response.body));
  };
}
