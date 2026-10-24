/**
 * Cloudflare Pages Functions wiring for the og routes (TASKS V2-D4; 08-frontend F-9).
 *
 * This is the adapter: it binds the runtime-neutral handlers in `web/src/edge/og/` to the
 * platform — the static shell from the `ASSETS` binding, the published snapshot over HTTP,
 * the wall clock, the resvg WASM module and the font subsets the bundler inlines. Every
 * behaviour worth testing lives in the handlers; this file only supplies them.
 *
 * Module scope is per isolate: the rasteriser's WASM initialisation and the PNG cache are
 * shared by the requests one isolate serves and bounded so a crawler cannot grow them.
 */

import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

import notoSansBold from '../../src/edge/og/fonts/noto-sans-bold-subset.bin';
import notoSansRegular from '../../src/edge/og/fonts/noto-sans-regular-subset.bin';
import { BoundedCache } from '../../src/edge/og/bounded-cache.js';
import type { OgDependencies } from '../../src/edge/og/og-handlers.js';
import { createResvgRasterizer } from '../../src/edge/og/resvg-rasterizer.js';

/** The bindings and variables a Pages project gives these functions. */
export interface OgEnv {
  /** Pages' static asset binding — the built `web/dist`. */
  readonly ASSETS: { fetch(input: Request | URL | string): Promise<Response> };
  /**
   * Where the published snapshot lives, absolute or relative to the request's origin.
   * Defaults to the same path the client polls (`DEFAULT_CONFIG.snapshotUrl`).
   */
  readonly FW_SNAPSHOT_URL?: string;
}

/** The slice of Pages' `EventContext` the og routes read. */
export interface OgContext {
  readonly request: Request;
  readonly env: OgEnv;
  readonly params: Readonly<Record<string, string | readonly string[]>>;
}

const DEFAULT_SNAPSHOT_PATH = '/fixtures/snapshot.json';

/** Bump with any change that makes the same SVG rasterise differently. */
const RENDERER_REVISION = 'resvg-wasm@2.6.2+noto-sans-subset-1';

/** ~100 KB per card: 64 cards stay under 8 MB of an isolate's 128 MB. */
const cache = new BoundedCache<Uint8Array>({ maxEntries: 64, maxBytes: 8 * 1024 * 1024 });

const rasterize = createResvgRasterizer({
  wasm: resvgWasm,
  fonts: [new Uint8Array(notoSansRegular), new Uint8Array(notoSansBold)],
  defaultFontFamily: 'Noto Sans',
});

export function ogDependencies(context: OgContext): OgDependencies {
  const { request, env } = context;
  return {
    loadShell: () => env.ASSETS.fetch(new URL('/', request.url)),
    loadSnapshot: async () => {
      const url = new URL(env.FW_SNAPSHOT_URL ?? DEFAULT_SNAPSHOT_PATH, request.url);
      // No request headers are forwarded: the snapshot is public and identical for all.
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`snapshot ${response.status}`);
      return (await response.json()) as unknown;
    },
    rasterize,
    now: () => Date.now(),
    cache,
    rendererRevision: RENDERER_REVISION,
  };
}

/** A route parameter as one string (Pages gives catch-alls as arrays). */
export function param(context: OgContext, name: string): string {
  const value = context.params[name];
  return typeof value === 'string' ? value : (value?.join('/') ?? '');
}
