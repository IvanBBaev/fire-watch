/**
 * Synthetic LSA-502 FRP-PIXEL list granules, written with h5wasm, for the decoder's tests
 * and the C3a measurements.
 *
 * These follow the list-product layout the decoder assumes (see `lsa-frp-pixel-decoder.ts`):
 * parallel 1-D integer datasets with `SCALING_FACTOR` / `OFFSET` / `MISSING_VALUE`, and the
 * slot in the root attribute `IMAGE_ACQUISITION_TIME`. They are built from the same
 * reading of the product manual as the decoder, so they prove the decoder and the payload
 * reader agree with each other — **not** that either agrees with EUMETSAT. Only a real
 * granule can do that (C3a done-when).
 */

import * as h5wasm from 'h5wasm';

/** One fire pixel, in physical units. `null` writes the field's MISSING_VALUE. */
export interface SyntheticPixel {
  readonly lat: number | null;
  readonly lon: number | null;
  readonly frpMw: number | null;
  readonly confidence: number | null;
  readonly btMirK?: number | null;
  readonly btMirBackgroundK?: number | null;
}

/**
 * Per-dataset encoding: integer type, the factor raw values are divided by, the fill.
 * h5wasm spells dtypes the Python `struct` way: `<h` is little-endian int16, `<i` int32.
 */
interface Encoding {
  readonly dtype: '<h' | '<i';
  readonly scale: number;
  readonly missing: number;
}

/** The encodings the decoder expects, per dataset. */
export const LSA_502_ENCODING = {
  LATITUDE: { dtype: '<h', scale: 100, missing: -32768 },
  LONGITUDE: { dtype: '<h', scale: 100, missing: -32768 },
  FRP: { dtype: '<i', scale: 10, missing: -1 },
  FIRE_CONFIDENCE: { dtype: '<h', scale: 100, missing: -1 },
  BT_MIR: { dtype: '<h', scale: 10, missing: -1 },
  BW_BT_MIR: { dtype: '<h', scale: 10, missing: -1 },
} as const satisfies Record<string, Encoding>;

type DatasetName = keyof typeof LSA_502_ENCODING;

export interface SyntheticGranuleOptions {
  /** `YYYYMMDDhhmmss`, the root `IMAGE_ACQUISITION_TIME`. `null` omits it. */
  readonly acquisitionTime?: string | null;
  /** Datasets to leave out entirely. */
  readonly omit?: readonly DatasetName[];
  /** Attribute overrides per dataset, e.g. a non-zero OFFSET. */
  readonly attributes?: Partial<Record<DatasetName, Record<string, number>>>;
  /** Gzip level for the datasets; 0 writes them contiguous. */
  readonly gzip?: number;
  /** Extra datasets to write verbatim, for the shape and type refusal tests. */
  readonly extra?: readonly {
    readonly name: string;
    readonly data: Int16Array | Int32Array | Float32Array | number[];
    readonly shape: number[];
    readonly dtype: string;
  }[];
}

let sequence = 0;

/** A granule as bytes, as the source adapter would hand them over (undecompressed). */
export async function buildListGranule(
  pixels: readonly SyntheticPixel[],
  options: SyntheticGranuleOptions = {},
): Promise<Uint8Array> {
  const module = await h5wasm.ready;
  sequence += 1;
  const path = `/synthetic-${String(sequence)}.h5`;
  const file = new h5wasm.File(path, 'w');
  try {
    const time = options.acquisitionTime === undefined ? '20260802111500' : options.acquisitionTime;
    if (time !== null) file.create_attribute('IMAGE_ACQUISITION_TIME', time);
    file.create_attribute('PRODUCT', 'FRP-PIXEL-ListProduct');

    const omit = new Set(options.omit ?? []);
    const columns: Record<DatasetName, (p: SyntheticPixel) => number | null | undefined> = {
      LATITUDE: (p) => p.lat,
      LONGITUDE: (p) => p.lon,
      FRP: (p) => p.frpMw,
      FIRE_CONFIDENCE: (p) => p.confidence,
      BT_MIR: (p) => p.btMirK,
      BW_BT_MIR: (p) => p.btMirBackgroundK,
    };
    for (const [name, encoding] of Object.entries(LSA_502_ENCODING) as [DatasetName, Encoding][]) {
      if (omit.has(name)) continue;
      const data =
        encoding.dtype === '<h' ? new Int16Array(pixels.length) : new Int32Array(pixels.length);
      pixels.forEach((pixel, i) => {
        const value = columns[name](pixel);
        data[i] =
          value === null || value === undefined
            ? encoding.missing
            : Math.round(value * encoding.scale);
      });
      const gzip = options.gzip ?? 0;
      const dataset = file.create_dataset({
        name,
        data,
        shape: [pixels.length],
        dtype: encoding.dtype,
        ...(gzip > 0 && pixels.length > 0
          ? { chunks: [Math.min(pixels.length, 4096)], compression: gzip }
          : {}),
      });
      const attributes = {
        SCALING_FACTOR: encoding.scale,
        OFFSET: 0,
        MISSING_VALUE: encoding.missing,
        ...options.attributes?.[name],
      };
      for (const [attr, value] of Object.entries(attributes)) {
        dataset.create_attribute(attr, value);
      }
    }
    for (const extra of options.extra ?? []) {
      file.create_dataset({
        name: extra.name,
        data: extra.data,
        shape: extra.shape,
        dtype: extra.dtype,
      });
    }
  } finally {
    file.close();
  }
  const bytes = module.FS.readFile(path);
  module.FS.unlink(path);
  return bytes;
}

/**
 * A full-disk-sized 2-D int16 grid (3712 × 3712 for SEVIRI), gzip-chunked the way LSA SAF
 * grids are, filled with a smooth field plus a sprinkle of fire-like values so gzip has
 * something realistic to chew on. Used to measure what reading a grid costs in h5wasm.
 */
export async function buildFullDiskGrid(side = 3712, gzip = 4): Promise<Uint8Array> {
  const module = await h5wasm.ready;
  sequence += 1;
  const path = `/grid-${String(sequence)}.h5`;
  const data = new Int16Array(side * side);
  // A cheap LCG, so the grid has sensor-like noise and gzip cannot fold it to nothing.
  let seed = 0x2545f491;
  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const i = row * side + col;
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      // Off-disk corners are fill, as on a real geostationary grid.
      const dx = col - side / 2;
      const dy = row - side / 2;
      data[i] =
        dx * dx + dy * dy > (side / 2) * (side / 2)
          ? -1
          : 2900 + ((row * 7 + col * 3) % 200) + (seed >>> 26) + (i % 9973 === 0 ? 500 : 0);
    }
  }
  const file = new h5wasm.File(path, 'w');
  try {
    file.create_attribute('IMAGE_ACQUISITION_TIME', '20260802111500');
    const dataset = file.create_dataset({
      name: 'FRP_QUALITY_GRID',
      data,
      shape: [side, side],
      dtype: '<h',
      chunks: [Math.min(side, 464), Math.min(side, 464)],
      compression: gzip,
    });
    dataset.create_attribute('SCALING_FACTOR', 10);
    dataset.create_attribute('OFFSET', 0);
    dataset.create_attribute('MISSING_VALUE', -1);
  } finally {
    file.close();
  }
  const bytes = module.FS.readFile(path);
  module.FS.unlink(path);
  return bytes;
}
