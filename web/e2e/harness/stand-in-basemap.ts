/**
 * A local stand-in for the third-party basemap, for the one gate that needs a basemap to
 * be *there*: the map-ready timing gate (CI-12's timing half, `timing/map-ready-budget.ts`).
 *
 * Every other suite blocks the basemap host and asserts the product works without it.
 * Map-ready is defined as "basemap tiles + fire layer painted" (08 §5.5.2), so it cannot
 * be measured without tiles, and a gate must not depend on OpenFreeMap or the network.
 * This server answers the two requests a basemap costs a first visit: the style document,
 * and one raster tile per `{z}/{x}/{y}` the viewport asks for.
 *
 *   * **The style** is the smallest a MapLibre style can be and still have tiles to wait
 *     for: a background layer and one raster layer over one raster source. No glyphs, no
 *     sprite — the app's own layers need neither.
 *   * **The tiles** are valid 256 × 256 greyscale PNGs, each padded with a private
 *     ancillary chunk (`fwPd`, which decoders skip) to exactly `tileBytes`, so the bytes a
 *     throttled link has to carry are the weight of a real tile, not of a blank one.
 *     Served uncompressed and with `Cache-Control: no-store`, so every run pays for them.
 *
 * It is cross-origin to the app, as the real basemap is, so it answers with
 * `Access-Control-Allow-Origin: *` — what a public tile host sends.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';

export interface StandInBasemapOptions {
  /** Exact size of every tile response body, in bytes. */
  readonly tileBytes: number;
  readonly tileSize: number;
  readonly maxzoom: number;
}

export interface StandInBasemap {
  readonly baseUrl: string;
  /** The style document's URL, to rewrite the shipped basemap URL to. */
  readonly styleUrl: string;
  /** Tile requests answered, in order — so a gate can prove the tiles were fetched. */
  readonly tileRequests: readonly string[];
  close(): Promise<void>;
}

const STYLE_PATH = '/style.json';
const TILE_PATH = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/u;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A `size` × `size` 8-bit greyscale PNG of one flat tone, padded to exactly `bytes`.
 * Exported for the unit test that decodes it.
 */
export function paddedPng(size: number, tone: number, bytes: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type: greyscale
  // compression, filter, interlace: all 0
  const row = Buffer.alloc(size + 1, tone);
  row[0] = 0; // filter type: none
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const body = Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw))]);
  const end = chunk('IEND', Buffer.alloc(0));
  const chunkOverhead = 12;
  const padding = bytes - body.length - end.length - chunkOverhead;
  if (padding < 0) throw new Error(`stand-in basemap: a tile cannot be as small as ${bytes} B`);
  return Buffer.concat([body, chunk('fwPd', Buffer.alloc(padding)), end]);
}

export async function startStandInBasemap(options: StandInBasemapOptions): Promise<StandInBasemap> {
  // Two tones in a checkerboard, so a painted map is not one flat colour; built once.
  const tiles = [
    paddedPng(options.tileSize, 0xe8, options.tileBytes),
    paddedPng(options.tileSize, 0xdc, options.tileBytes),
  ] as const;
  const tileRequests: string[] = [];
  let baseUrl = '';

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://stand-in').pathname;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    if (path === STYLE_PATH) {
      const style = {
        version: 8,
        name: 'fire-watch timing stand-in',
        sources: {
          'stand-in': {
            type: 'raster',
            tiles: [`${baseUrl}/tiles/{z}/{x}/{y}.png`],
            tileSize: options.tileSize,
            maxzoom: options.maxzoom,
          },
        },
        layers: [
          {
            id: 'stand-in-background',
            type: 'background',
            paint: { 'background-color': '#eeeeee' },
          },
          { id: 'stand-in-raster', type: 'raster', source: 'stand-in' },
        ],
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(style));
      return;
    }
    const match = TILE_PATH.exec(path);
    if (match !== null) {
      tileRequests.push(path);
      const x = Number(match[2]);
      const y = Number(match[3]);
      const body = tiles[(x + y) % 2] ?? tiles[0];
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    styleUrl: baseUrl + STYLE_PATH,
    tileRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
