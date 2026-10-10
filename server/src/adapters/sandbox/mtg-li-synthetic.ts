/**
 * Synthetic MTG LI LFL BODY files, written with h5wasm, for the decoder's tests and the
 * committed fixture granule (TASKS F18).
 *
 * The layout follows EUM/MTG/SPE/10/0452 v5C Annex A.6 as `mtg-li-flash-decoder.ts`
 * transcribes it: root-group variables of dimension `flashes`, `flash_time` as a double of
 * seconds since 2000-01-01, `latitude`/`longitude` as packed shorts with `scale_factor`
 * 0.00275. The writer and the decoder are built from the same reading of the specification,
 * so a round trip proves they agree with each other — **not** with EUMETSAT. Only a real
 * product can do that, and none has been fetched yet (DATA-SOURCES §F18).
 */

import * as h5wasm from 'h5wasm';

import { LI_EPOCH_MS } from './mtg-li-flash-decoder.js';

/** One flash in physical units. `null` writes the variable's fill value. */
export interface SyntheticFlash {
  /** ISO-8601 UTC; `null` writes NaN, which the decoder treats as no time. */
  readonly t: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly radiance?: number | null;
  readonly durationMs?: number;
  readonly footprint?: number;
  /** `flash_filter_confidence`, decoded (0 = likely true flash); absent or `null` writes fill. */
  readonly falseLikelihood?: number | null;
}

/** Specified packing (A.6.1.4). Radiance scale is "configured"; this is our choice. */
export const LFL_SYNTHETIC_ENCODING = {
  latLonScale: 0.00275,
  radianceScale: 0.1,
  shortFill: -32767,
  ushortFill: 65535,
  /** A.6: `flash_filter_confidence` scale_factor 0.004, add_offset 0. */
  falseLikelihoodScale: 0.004,
  byteFill: -127,
  ubyteFill: 255,
} as const;

type Variable =
  | 'flash_time'
  | 'latitude'
  | 'longitude'
  | 'radiance'
  | 'flash_duration'
  | 'flash_footprint'
  | 'flash_filter_confidence';

export interface SyntheticBodyOptions {
  /** Variables to leave out entirely. */
  readonly omit?: readonly Variable[];
  /** Replace a variable's `units` attribute; `null` removes it. */
  readonly units?: Partial<Record<Variable, string | null>>;
  /** Extra root datasets, e.g. to prove the refusal lists what it found. */
  readonly extra?: readonly string[];
  /** Write latitude as float32 instead of the specified short. */
  readonly latitudeAsFloat?: boolean;
  /**
   * How `flash_filter_confidence` is stored. The spec says `byte` (signed), which cannot
   * hold 1 / 0.004 = 250; `uint8` is the reading under which the full range fits. A signed
   * byte saturates at 127 × 0.004 = 0.508. Default `uint8`.
   */
  readonly falseLikelihoodType?: 'int8' | 'uint8';
}

let sequence = 0;

export async function buildLflBody(
  flashes: readonly SyntheticFlash[],
  options: SyntheticBodyOptions = {},
): Promise<Uint8Array> {
  const module = await h5wasm.ready;
  sequence += 1;
  const path = `/synthetic-lfl-${String(sequence)}.nc`;
  const file = new h5wasm.File(path, 'w');
  const omit = new Set(options.omit ?? []);
  const n = flashes.length;
  const enc = LFL_SYNTHETIC_ENCODING;
  const unitsFor = (name: Variable, fallback: string | null): string | null => {
    const override = options.units?.[name];
    return override === undefined ? fallback : override;
  };
  try {
    file.create_attribute('Conventions', 'CF-1.7');
    if (!omit.has('flash_time')) {
      const data = new Float64Array(n);
      flashes.forEach((f, i) => {
        data[i] = f.t === null ? Number.NaN : (Date.parse(f.t) - LI_EPOCH_MS) / 1000;
      });
      const ds = file.create_dataset({ name: 'flash_time', data, shape: [n], dtype: '<d' });
      const units = unitsFor('flash_time', 'seconds since 2000-01-01 00:00:00.0');
      if (units !== null) ds.create_attribute('units', units);
      ds.create_attribute('time_standard', 'UTC');
    }
    for (const [name, pick, unit] of [
      ['latitude', (f: SyntheticFlash) => f.lat, 'degrees_north'],
      ['longitude', (f: SyntheticFlash) => f.lon, 'degrees_east'],
    ] as const) {
      if (omit.has(name)) continue;
      if (name === 'latitude' && options.latitudeAsFloat === true) {
        const data = new Float32Array(flashes.map((f) => f.lat ?? Number.NaN));
        file.create_dataset({ name, data, shape: [n], dtype: '<f' });
        continue;
      }
      const data = new Int16Array(n);
      flashes.forEach((f, i) => {
        const v = pick(f);
        data[i] = v === null ? enc.shortFill : Math.round(v / enc.latLonScale);
      });
      const ds = file.create_dataset({ name, data, shape: [n], dtype: '<h' });
      const units = unitsFor(name, unit);
      if (units !== null) ds.create_attribute('units', units);
      ds.create_attribute('scale_factor', enc.latLonScale, null, '<f');
      ds.create_attribute('add_offset', 0, null, '<f');
      ds.create_attribute('_FillValue', enc.shortFill, null, '<h');
    }
    if (!omit.has('radiance')) {
      const data = new Uint16Array(n);
      flashes.forEach((f, i) => {
        const v = f.radiance ?? null;
        data[i] = v === null ? enc.ushortFill : Math.round(v / enc.radianceScale);
      });
      const ds = file.create_dataset({ name: 'radiance', data, shape: [n], dtype: '<H' });
      const units = unitsFor('radiance', 'mW.m-2.sr-1');
      if (units !== null) ds.create_attribute('units', units);
      ds.create_attribute('scale_factor', enc.radianceScale, null, '<f');
      ds.create_attribute('add_offset', 0, null, '<f');
      ds.create_attribute('_FillValue', enc.ushortFill, null, '<H');
    }
    if (!omit.has('flash_duration')) {
      const data = new Uint16Array(flashes.map((f) => f.durationMs ?? 0));
      const ds = file.create_dataset({ name: 'flash_duration', data, shape: [n], dtype: '<H' });
      const units = unitsFor('flash_duration', 'ms');
      if (units !== null) ds.create_attribute('units', units);
    }
    if (!omit.has('flash_footprint')) {
      const data = new Uint16Array(flashes.map((f) => f.footprint ?? 1));
      file.create_dataset({ name: 'flash_footprint', data, shape: [n], dtype: '<H' });
    }
    if (!omit.has('flash_filter_confidence')) {
      const signed = options.falseLikelihoodType === 'int8';
      const fill = signed ? enc.byteFill : enc.ubyteFill;
      const raw = flashes.map((f) => {
        const v = f.falseLikelihood ?? null;
        if (v === null) return fill;
        const packed = Math.round(v / enc.falseLikelihoodScale);
        return signed ? Math.min(packed, 127) : packed;
      });
      const ds = file.create_dataset({
        name: 'flash_filter_confidence',
        data: signed ? new Int8Array(raw) : new Uint8Array(raw),
        shape: [n],
        dtype: signed ? '<b' : '<B',
      });
      ds.create_attribute('long_name', 'L2 filtered flash confidence');
      ds.create_attribute('scale_factor', enc.falseLikelihoodScale, null, '<f');
      ds.create_attribute('add_offset', 0, null, '<f');
      ds.create_attribute('_FillValue', fill, null, signed ? '<b' : '<B');
    }
    // The ids the specification also lists; the decoder does not read them.
    file.create_dataset({
      name: 'flash_id',
      data: new Uint32Array(flashes.map((_, i) => i + 1)),
      shape: [n],
      dtype: '<I',
    });
    for (const name of options.extra ?? []) {
      file.create_dataset({ name, data: new Uint16Array(n), shape: [n], dtype: '<H' });
    }
  } finally {
    file.close();
  }
  const bytes = module.FS.readFile(path);
  module.FS.unlink(path);
  return bytes;
}
