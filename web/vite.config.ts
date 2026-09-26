import { defineConfig } from 'vite';

// No Preact plugin needed: Vite picks up `jsx`/`jsxImportSource` from tsconfig.
// The dev proxy forwards the freshness route to the locally running probe API.
export default defineConfig({
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
