/**
 * A stand-in for the server's EFFIS overlay proxy (`/overlays/effis/*`), for the layers
 * panel scenario. The harness origin serves the built app and the snapshot API and
 * nothing else — an overlay request would fall through to its static handler and 404,
 * which the browser reports as a console error the suite does not allow. So the page's
 * same-origin overlay URLs are rewritten to this server (`InstrumentedPageOptions.rewrite`),
 * which answers the way the proxy does: the copy plus the three headers the client reads
 * (`x-fire-watch-overlay-state`, `-available-at`, `-valid-for`). A rewrite is not
 * observable by the page, so the app still thinks it asked its own origin.
 *
 * The FWI copy is a real PNG (one flat grey tile, built by the basemap stand-in's
 * encoder): MapLibre decodes what it is handed, and a body it cannot decode would be a
 * console error of the harness's own making. The burnt-area copy is an empty
 * FeatureCollection. `validFor` is the stub clock's UTC date, as the worker stamps it.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { OVERLAY_URLS } from '../../src/ui/layers.js';
import { paddedPng } from './stand-in-basemap.js';

export interface EffisOverlayStub {
  readonly baseUrl: string;
  /** Paths asked for, in order — the proof the toggle reached the proxy. */
  readonly requests: readonly string[];
  /** `InstrumentedPageOptions.rewrite` for an app served from `appOrigin`. */
  rewriteFor(appOrigin: string): Readonly<Record<string, string>>;
  close(): Promise<void>;
}

const FWI_PNG = paddedPng(16, 0xc0, 512);

export async function startEffisOverlayStub(
  clock: () => number = () => Date.now(),
): Promise<EffisOverlayStub> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://stub').pathname;
    requests.push(path);
    const now = clock();
    const headers = {
      'cache-control': 'no-store',
      // Belt and braces: the rewrite is meant to be invisible to the page, but should the
      // browser ever treat the answer as cross-origin, the headers must still be readable.
      'access-control-allow-origin': '*',
      'access-control-expose-headers':
        'x-fire-watch-overlay-state, x-fire-watch-overlay-available-at, x-fire-watch-overlay-valid-for',
      'x-fire-watch-overlay-state': 'current',
      'x-fire-watch-overlay-available-at': new Date(now - 3_600_000).toISOString(),
      'x-fire-watch-overlay-valid-for': new Date(now).toISOString().slice(0, 10),
    };
    if (path === OVERLAY_URLS.fwi) {
      response.writeHead(200, { ...headers, 'content-type': 'image/png' }).end(FWI_PNG);
      return;
    }
    if (path === OVERLAY_URLS.ba) {
      response
        .writeHead(200, { ...headers, 'content-type': 'application/geo+json' })
        .end(JSON.stringify({ type: 'FeatureCollection', features: [] }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    requests,
    rewriteFor: (appOrigin) =>
      Object.fromEntries(
        Object.values(OVERLAY_URLS).map((path) => [`${appOrigin}${path}`, `${baseUrl}${path}`]),
      ),
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      }),
  };
}
