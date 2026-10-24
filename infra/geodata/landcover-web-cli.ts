#!/usr/bin/env node
/**
 * Builds the browser's land-cover asset (V2-F4):
 *
 *   web/src/assets/geodata/landcover.json — WorldCover group shares on a 0.02° grid over
 *   the served box, cut from the DS-7 product (CC BY 4.0)
 *
 *   pnpm run geodata:landcover-web [--manifest <file>] [--product <file>] [--out <dir>]
 *
 * Operator-run, never in CI. The DS-7 product (`pnpm run geodata:worldcover`) is read
 * from the git-ignored `data/worldcover-cache/` and its sha256 must equal the committed
 * manifest's (`server/fixtures/worldcover-landcover.json`), so the committed asset can be
 * traced to the exact product it was cut from.
 *
 * Exit codes: 0 ok, 1 a check failed.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

import { buildLandCoverWeb, serializeLandCoverWeb } from './landcover-web.js';
import { FORMAT } from './worldcover.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The compiled CLI runs from `infra/geodata/dist/`; the repo root is three levels up.
const REPO_ROOT = resolve(HERE, '..', '..', '..');

/** 4 × 0.005° = 0.02°; shares in tenths. ~160 KB gzip (measured 2026-10-24). */
const FACTOR = 4;
const SCALE = 10;

interface Manifest {
  readonly format: string;
  readonly version: string;
  readonly source: string;
  readonly licence: string;
  readonly attribution: string;
  readonly bbox: { readonly west: number; readonly north: number };
  readonly grid: { readonly cell_deg: number; readonly cols: number; readonly rows: number };
  readonly product: { readonly file: string; readonly bytes: number; readonly sha256: string };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      manifest: {
        type: 'string',
        default: join(REPO_ROOT, 'server', 'fixtures', 'worldcover-landcover.json'),
      },
      product: { type: 'string' },
      out: { type: 'string', default: join(REPO_ROOT, 'web', 'src', 'assets', 'geodata') },
    },
  });
  const manifest = JSON.parse(readFileSync(values.manifest, 'utf8')) as Manifest;
  if (manifest.format !== FORMAT) throw new Error(`manifest format is not ${FORMAT}`);
  const productFile = values.product ?? join(REPO_ROOT, manifest.product.file);
  const bytes = readFileSync(productFile);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== manifest.product.sha256) {
    throw new Error(`${productFile}: sha256 ${sha256} is not the manifest's`);
  }

  const asset = buildLandCoverWeb(
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    {
      west: manifest.bbox.west,
      north: manifest.bbox.north,
      cellDeg: manifest.grid.cell_deg,
      cols: manifest.grid.cols,
      rows: manifest.grid.rows,
    },
    {
      factor: FACTOR,
      scale: SCALE,
      version: `${manifest.version}_web_0p02_s${String(SCALE)}`,
      source: manifest.source,
      licence: manifest.licence,
      attribution: manifest.attribution,
      productSha256: sha256,
    },
  );
  const text = serializeLandCoverWeb(asset);
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, 'landcover.json'), text);
  const gz = gzipSync(text, { level: 9 }).length;
  console.log(`landcover.json: ${String(Buffer.byteLength(text))} B raw, ${String(gz)} B gzip -9`);
  console.log(`version ${asset.version}, product sha256 ${sha256}`);
  console.log(`counts ${JSON.stringify(asset.counts)}`);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
