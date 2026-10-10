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
 * Unset — CI, e2e, every deploy — no plugin, no define: the default basemap is untouched.
 */
function localTiles(workDir: string | undefined, version: string | undefined): Plugin[] {
  const dir = workDir?.trim();
  if (!dir) return [];
  const local = resolveLocalTiles(dir, version?.trim() || undefined);
  return [
    {
      name: 'fire-watch:local-tiles',
      config: () => ({
        define: {
          'import.meta.env.VITE_FIRE_WATCH_LOCAL_TILES': JSON.stringify(LOCAL_TILES_PREFIX),
        },
      }),
      configureServer(server) {
        server.middlewares.use(localTilesMiddleware(local));
        server.config.logger.info(
          `  local tiles: ${local.tilesDir} + glyphs ${local.glyphsDir} at ${LOCAL_TILES_PREFIX}`,
        );
      },
      configurePreviewServer(server) {
        server.middlewares.use(localTilesMiddleware(local));
      },
    },
  ];
}

// No Preact plugin needed: Vite picks up `jsx`/`jsxImportSource` from tsconfig.
// The dev proxy forwards the API routes and the live snapshot to the local API.
export default defineConfig({
  plugins: localTiles(
    process.env['FIRE_WATCH_LOCAL_TILES_DIR'],
    process.env['FIRE_WATCH_LOCAL_TILES_VERSION'],
  ),
  optimizeDeps: {
    // Dev: the dep optimizer rewrites maplibre's worker URL to a .vite/deps
    // file it never emits (404 → no tile parsing, blank map). Serving
    // maplibre-gl unbundled keeps the dev worker resolvable.
    //
    // The production build is NOT covered by this: maplibre resolves its worker
    // as `./maplibre-gl-worker.mjs` next to its own (now hashed, bundled) module,
    // and that worker imports `./maplibre-gl-shared.mjs`; Vite emits neither.
    // map-controller.ts therefore imports the worker with `?worker&url` and
    // passes the emitted URL to `setWorkerUrl()` — see the comment there.
    exclude: ['maplibre-gl'],
  },
  worker: {
    // maplibre starts its worker with `{ type: 'module' }` for any URL not ending
    // in `.cjs`, so the worker bundle is emitted as an ES module.
    format: 'es',
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
