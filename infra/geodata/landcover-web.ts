/**
 * The browser's land-cover asset (V2-F4), cut from the DS-7 WorldCover product.
 *
 * The DS-7 product (`worldcover.ts`) is a 0.005° grid of twelve class shares per cell —
 * 37 MB, too big for a browser. The event detail only needs "what is the land around these
 * detections": a coarser grid, fewer classes and coarser shares answer that in ~160 KB
 * gzip. This module makes that cut:
 *
 * - **cells:** `factor`×`factor` product cells are pooled into one (factor 4 = 0.02°, about
 *   1.7 km × 2.2 km at 42° N);
 * - **groups:** the eleven WorldCover classes become eight groups a reader recognises
 *   ({@link GROUPS}); no-data pixels are left out of the denominator;
 * - **shares:** each cell's group shares are quantised to integers summing to `scale`
 *   (largest remainder, ties to the lower group), or the cell is empty when no pixel of it
 *   has data (open sea outside every tile);
 * - **encoding:** distinct share vectors form a palette (most frequent first, so common
 *   cells get small indexes), and each grid row is run-length encoded as
 *   `[index, length, index, length, …]`.
 *
 * Pure: no I/O. `landcover-web-cli.ts` reads the product, checks its sha256 against the
 * committed manifest and writes `web/src/assets/geodata/landcover.json`. The format
 * constants are repeated in `web/src/core/geo/land-cover.ts`, the asset's only reader,
 * because this project compiles on Node built-ins alone.
 */

import { CLASSES } from './worldcover.js';

export const LANDCOVER_WEB_FORMAT = 'fire-watch/landcover-web@1';

/** The groups, in plane order of the asset's share vectors. */
export const GROUPS = [
  'tree',
  'shrub',
  'grass',
  'crop',
  'built',
  'bare',
  'water',
  'wetland',
] as const;
export type Group = (typeof GROUPS)[number];

/**
 * Which group each DS-7 plane feeds (`CLASSES` order), `null` for no data. Moss and lichen
 * (100) count as grass and snow (70) as bare ground: both are vanishingly rare in the box
 * and a reader would not look for them. Mangroves (95) are wetland; there are none here.
 */
export const PLANE_GROUP: readonly (number | null)[] = CLASSES.map((code) => {
  switch (code) {
    case 0:
      return null;
    case 10:
      return 0;
    case 20:
      return 1;
    case 30:
    case 100:
      return 2;
    case 40:
      return 3;
    case 50:
      return 4;
    case 60:
    case 70:
      return 5;
    case 80:
      return 6;
    case 90:
    case 95:
      return 7;
  }
});

export interface ProductLayout {
  /** North-west corner of the product grid, degrees. */
  readonly west: number;
  readonly north: number;
  readonly cellDeg: number;
  readonly cols: number;
  readonly rows: number;
}

export interface LandCoverWebOptions {
  /** Product cells per asset cell edge. */
  readonly factor: number;
  /** The integer the group shares of a non-empty cell sum to. */
  readonly scale: number;
  readonly version: string;
  readonly source: string;
  readonly licence: string;
  readonly attribution: string;
  /** The DS-7 product's sha256, checked by the CLI against the committed manifest. */
  readonly productSha256: string;
}

export interface LandCoverWebAsset {
  readonly format: typeof LANDCOVER_WEB_FORMAT;
  readonly version: string;
  readonly source: string;
  readonly licence: string;
  readonly attribution: string;
  readonly product_sha256: string;
  readonly grid: {
    readonly west: number;
    readonly north: number;
    readonly cell_deg: number;
    readonly cols: number;
    readonly rows: number;
    readonly scale: number;
  };
  readonly groups: readonly Group[];
  /** Share vectors (one integer per group, summing to `scale`), or `[]` for no data. */
  readonly palette: readonly (readonly number[])[];
  /** One run-length row per grid row, north first: `[index, length, …]`. */
  readonly rows: readonly (readonly number[])[];
  /** Cells by kind, for the DATASETS entry. */
  readonly counts: { readonly cells: number; readonly empty: number; readonly palette: number };
}

/** Largest-remainder quantisation of `weights` to integers summing to `scale`. */
export function quantizeShares(weights: readonly number[], scale: number): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return [];
  const exact = weights.map((w) => (w * scale) / total);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = scale - floors.reduce((sum, f) => sum + f, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}

/**
 * Pool the product (`layout.cols × layout.rows` cells, `planes` bytes each, cell-major)
 * into `factor`×`factor` group-share cells. A partial block at the east or south edge is
 * pooled from the cells it has.
 */
export function buildLandCoverWeb(
  product: Uint8Array,
  layout: ProductLayout,
  options: LandCoverWebOptions,
): LandCoverWebAsset {
  const planes = CLASSES.length;
  if (product.length !== layout.cols * layout.rows * planes) {
    throw new Error(
      `product is ${String(product.length)} B, expected ${String(layout.cols * layout.rows * planes)}`,
    );
  }
  const { factor, scale } = options;
  if (!Number.isInteger(factor) || factor < 1) throw new Error('factor must be a positive integer');
  if (!Number.isInteger(scale) || scale < 1) throw new Error('scale must be a positive integer');

  const cols = Math.ceil(layout.cols / factor);
  const rows = Math.ceil(layout.rows / factor);
  const keys: string[] = new Array<string>(cols * rows);
  const frequency = new Map<string, number>();
  const sums = new Array<number>(GROUPS.length);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      sums.fill(0);
      for (let r = row * factor; r < Math.min((row + 1) * factor, layout.rows); r += 1) {
        for (let c = col * factor; c < Math.min((col + 1) * factor, layout.cols); c += 1) {
          const base = (r * layout.cols + c) * planes;
          for (let p = 0; p < planes; p += 1) {
            const group = PLANE_GROUP[p];
            if (group === null || group === undefined) continue;
            sums[group] = (sums[group] ?? 0) + (product[base + p] ?? 0);
          }
        }
      }
      const key = quantizeShares(sums, scale).join(',');
      keys[row * cols + col] = key;
      frequency.set(key, (frequency.get(key) ?? 0) + 1);
    }
  }

  // Most frequent first; ties by the key so the order is a function of the input alone.
  const ordered = [...frequency.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const index = new Map(ordered.map(([key], i) => [key, i]));
  const palette = ordered.map(([key]) => (key === '' ? [] : key.split(',').map(Number)));

  const encoded: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const runs: number[] = [];
    let current = -1;
    let length = 0;
    for (let col = 0; col < cols; col += 1) {
      const value = index.get(keys[row * cols + col] ?? '') ?? 0;
      if (value === current) {
        length += 1;
      } else {
        if (length > 0) runs.push(current, length);
        current = value;
        length = 1;
      }
    }
    runs.push(current, length);
    encoded.push(runs);
  }

  return {
    format: LANDCOVER_WEB_FORMAT,
    version: options.version,
    source: options.source,
    licence: options.licence,
    attribution: options.attribution,
    product_sha256: options.productSha256,
    grid: {
      west: layout.west,
      north: layout.north,
      cell_deg: Math.round(layout.cellDeg * factor * 1e9) / 1e9,
      cols,
      rows,
      scale,
    },
    groups: GROUPS,
    palette,
    rows: encoded,
    counts: { cells: cols * rows, empty: frequency.get('') ?? 0, palette: palette.length },
  };
}

/** The asset as committed: the header on one line each, then one line per grid row. */
export function serializeLandCoverWeb(asset: LandCoverWebAsset): string {
  const { rows, palette, ...header } = asset;
  const head = JSON.stringify(header).slice(0, -1);
  return (
    `${head},\n"palette":${JSON.stringify(palette)},\n"rows":[\n` +
    rows.map((row) => JSON.stringify(row)).join(',\n') +
    '\n]}\n'
  );
}
