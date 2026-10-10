import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { defineConfig, type Plugin } from 'vite';

import {
  LOCAL_TILES_PREFIX,
  localTilesMiddleware,
  resolveLocalTiles,
} from '../infra/tiles/dev-serve.ts';

/**
 * TASKS G3: `FIRE_WATCH_LOCAL_TILES_DIR=./tiles pnpm dev` (or `dev:live`, or `vite
 * preview`) serves the newest `infra/tiles/build.sh` output under `/__local-tiles` and
 * builds the client with `VITE_FIRE_WATCH_LOCAL_TILES`, which points `outdoorBasemap` at
 * it (`core/config.ts` readLocalTiles). `FIRE_WATCH_LOCAL_TILES_VERSION` pins a version.
 * A Terrarium mirror (`infra/tiles` `dem-mirror`) under `<dir>/dem/terrarium`, or under
 * `FIRE_WATCH_LOCAL_DEM_DIR` when it was fetched elsewhere, is served too and sets
 * `VITE_FIRE_WATCH_LOCAL_DEM`, which turns hillshade on.
 * Unset — CI, e2e, every deploy — no plugin, no define: the default basemap is untouched.
 */
function localTiles(
  workDir: string | undefined,
  version: string | undefined,
  demWorkDir: string | undefined,
): Plugin[] {
  const dir = workDir?.trim();
  if (!dir) return [];
  const local = resolveLocalTiles(
    dir,
    version?.trim() || undefined,
    demWorkDir?.trim() || undefined,
  );
  return [
    {
      name: 'fire-watch:local-tiles',
      config: () => ({
        define: {
          'import.meta.env.VITE_FIRE_WATCH_LOCAL_TILES': JSON.stringify(LOCAL_TILES_PREFIX),
          ...(local.demDir !== null && {
            'import.meta.env.VITE_FIRE_WATCH_LOCAL_DEM': JSON.stringify('1'),
          }),
        },
      }),
      configureServer(server) {
        server.middlewares.use(localTilesMiddleware(local));
        server.config.logger.info(
          `  local tiles: ${local.tilesDir} + glyphs ${local.glyphsDir}` +
            `${local.demDir === null ? ' (no DEM)' : ` + DEM ${local.demDir}`} at ${LOCAL_TILES_PREFIX}`,
        );
      },
      configurePreviewServer(server) {
        server.middlewares.use(localTilesMiddleware(local));
      },
    },
  ];
}

/**
 * MapLibre 6 ships as three ES modules: `maplibre-gl.mjs` (main thread), its worker
 * `maplibre-gl-worker.mjs`, and `maplibre-gl-shared.mjs`, which both of them import —
 * about 131 KiB gz of the 137 KiB a worker needs. Laid out as published, the browser
 * fetches the shared module once and both threads use it.
 *
 * Bundling breaks that: the main-thread copy is inlined into the map chunk, and a
 * `?worker&url` worker build inlines a second copy, so the map path carried MapLibre's
 * shared code twice (CI-12, TASKS F8). This plugin restores the published layout in
 * the production build instead:
 *
 * - `maplibre-gl-shared.mjs` is emitted verbatim as a content-hashed file in the assets
 *   directory, and the main bundle imports it as an external module rather than
 *   inlining it;
 * - `maplibre-gl-worker.mjs` is emitted verbatim too, with its one import pointed at
 *   that same file, and `maplibre-gl/dist/maplibre-gl-worker.mjs?url` resolves to its
 *   URL (map-controller.ts hands that to `setWorkerUrl()`).
 *
 * Neither file is re-bundled, so the worker is exactly MapLibre's own. Their source-map
 * comments are dropped (the maps are not emitted).
 *
 * An external import is invisible to Vite's preload list, so a lazy chunk that imports
 * the shared module would only discover it once that chunk had downloaded and parsed —
 * one more round trip, in series, on the map's critical path (CI-12 timing). The shared
 * file is therefore added to the preload list of every dynamic import that loads such a
 * chunk, and is fetched in parallel with it. Dev is untouched: there maplibre is
 * served unbundled from `node_modules` (`optimizeDeps.exclude`) and `?url` names its
 * worker file, whose sibling import resolves as published.
 */
function maplibreSharedModule(): Plugin {
  const dist = dirname(
    createRequire(import.meta.url).resolve('maplibre-gl/dist/maplibre-gl-shared.mjs'),
  );
  const SHARED_IMPORT = './maplibre-gl-shared.mjs';
  const WORKER_URL_IMPORT = 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
  const WORKER_URL_ID = '\0fire-watch:maplibre-worker-url';

  const read = (file: string): string =>
    readFileSync(join(dist, file), 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
  const hashed = (stem: string, source: string): string =>
    `${stem}-${createHash('sha256').update(source).digest('base64url').slice(0, 8)}.mjs`;

  const shared = read('maplibre-gl-shared.mjs');
  const sharedName = hashed('maplibre-gl-shared', shared);
  const workerOriginal = read('maplibre-gl-worker.mjs');
  // The worker's only import is the shared module; fail the build if that ever changes
  // rather than ship a worker that 404s.
  const workerImports = workerOriginal.match(/\bfrom\s*["'][^"']+["']/g) ?? [];
  if (workerImports.length !== 1 || !workerImports[0]?.includes(SHARED_IMPORT)) {
    throw new Error(
      `maplibre-gl-worker.mjs imports ${JSON.stringify(workerImports)}; ` +
        `expected exactly one import of ${SHARED_IMPORT}`,
    );
  }
  const worker = workerOriginal.replace(SHARED_IMPORT, `./${sharedName}`);
  const workerName = hashed('maplibre-gl-worker', worker);

  let assetsDir = 'assets';
  /** Output chunks (`assets/map-….js`) that import the shared module. */
  const sharedImporters = new Set<string>();
  return {
    name: 'fire-watch:maplibre-shared-module',
    apply: 'build',
    enforce: 'pre',
    config(config) {
      const configured = config.build?.modulePreload;
      const inner = typeof configured === 'object' ? configured.resolveDependencies : undefined;
      return {
        build: {
          modulePreload: {
            // Called from Vite's `generateBundle`, after `sharedImporters` is filled.
            resolveDependencies(filename, deps, context) {
              const resolved = inner === undefined ? deps : inner(filename, deps, context);
              const loadsShared = [filename, ...resolved].some((file) => sharedImporters.has(file));
              const sharedFile = `${assetsDir}/${sharedName}`;
              return loadsShared && !resolved.includes(sharedFile)
                ? [...resolved, sharedFile]
                : resolved;
            },
          },
        },
      };
    },
    configResolved(config) {
      assetsDir = config.build.assetsDir;
    },
    // Vite builds its preload lists in its own `generateBundle`; this runs before it, once
    // the output file names are final.
    generateBundle: {
      order: 'pre',
      handler(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk' && output.imports.includes(`./${sharedName}`)) {
            sharedImporters.add(output.fileName);
          }
        }
      },
    },
    resolveId(source, importer) {
      if (source === WORKER_URL_IMPORT) return WORKER_URL_ID;
      // Only MapLibre's own modules import their shared sibling by this relative path;
      // the importing chunk is emitted into the same assets directory.
      if (source === SHARED_IMPORT && importer !== undefined && dirname(importer) === dist) {
        return { id: `./${sharedName}`, external: true };
      }
      return null;
    },
    load(id) {
      if (id !== WORKER_URL_ID) return null;
      this.emitFile({ type: 'asset', fileName: `${assetsDir}/${sharedName}`, source: shared });
      const ref = this.emitFile({
        type: 'asset',
        fileName: `${assetsDir}/${workerName}`,
        source: worker,
      });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
  };
}

// No Preact plugin needed: Vite picks up `jsx`/`jsxImportSource` from tsconfig.
// The dev proxy forwards the API routes and the live snapshot to the local API.
export default defineConfig({
  plugins: [
    maplibreSharedModule(),
    ...localTiles(
      process.env['FIRE_WATCH_LOCAL_TILES_DIR'],
      process.env['FIRE_WATCH_LOCAL_TILES_VERSION'],
      process.env['FIRE_WATCH_LOCAL_DEM_DIR'],
    ),
  ],
  optimizeDeps: {
    // Dev: the dep optimizer rewrites maplibre's worker URL to a .vite/deps
    // file it never emits (404 → no tile parsing, blank map). Serving
    // maplibre-gl unbundled keeps the dev worker and its shared sibling resolvable.
    // The production build lays the same files out with `maplibreSharedModule()`.
    exclude: ['maplibre-gl'],
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      // The live read path (`pnpm dev:live`); fixture builds never request it.
      '/snapshot.json': 'http://127.0.0.1:8080',
      // The EFFIS overlay proxy (TASKS G4); the browser never talks to EFFIS itself.
      '/overlays': 'http://127.0.0.1:8080',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // CI-12 reads the chunk graph from here (`dist/.vite/manifest.json`): which chunk
    // is the entry, what it imports statically, and which chunks load lazily. The
    // budget gate classifies from this graph, never from file names.
    manifest: true,
  },
});
