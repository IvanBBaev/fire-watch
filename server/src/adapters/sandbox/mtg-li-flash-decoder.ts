/**
 * The program on the far side of the wall for lightning: an MTG LI L2 Lightning Flashes
 * (LI-2-LFL) BODY file in, a `fire-watch.lightning.v1` payload out (TASKS F18;
 * DATA-SOURCES §F18).
 *
 * Run as the child of `createChildProcessDecoder` through `createMtgLiDecoder`, never
 * imported by the worker for its side effects; the process work sits behind the entry
 * guard at the bottom, like `lsa-frp-pixel-decoder.ts`, whose reasons for h5wasm's MEMFS
 * build, the Node permission model and a self-contained module apply here unchanged.
 *
 * **The layout is the specification's, not a recollection.** Every name, type and unit
 * below is taken from *MTG LI Level 2 Format Specification*, EUM/MTG/SPE/10/0452 v5C
 * (9 July 2021), Annex A.6 "LI-2-LFL-BODY", root group:
 *
 *   | variable          | type   | attributes the decoder checks                                |
 *   |-------------------|--------|--------------------------------------------------------------|
 *   | `flash_time`      | double | units `seconds since 2000-01-01 00:00:00.0`                  |
 *   | `latitude`        | short  | units `degrees_north`, scale_factor 0.00275, add_offset 0, _FillValue |
 *   | `longitude`       | short  | units `degrees_east`, scale_factor 0.00275, add_offset 0, _FillValue  |
 *   | `radiance`        | ushort | units `mW.m-2.sr-1`, scale_factor/add_offset configured       |
 *   | `flash_duration`  | ushort | units `ms`                                                   |
 *   | `flash_footprint` | ushort | (LI pixels, no units attribute)                              |
 *
 * all of dimension `flashes`. `flash_filter_confidence` is deliberately **not** read: its
 * semantics are inverted (0 = high confidence) and a context layer has no use for a
 * threshold we would have to choose. The netCDF-CF convention decodes a packed value as
 * `raw × scale_factor + add_offset`, with `_FillValue` meaning "no value".
 *
 * **Never a guess.** No real product has been read yet (no Data Store account — see
 * DATA-SOURCES §F18). So every assumption above is checked against the file, and any
 * mismatch is a typed refusal that names what was found instead — a required variable
 * missing lists the root names that *are* there; a unit that differs quotes it. The day
 * the first real file arrives, the refusal says exactly which line of this table was wrong.
 *
 * **Time and place are checked, not trusted.** Each flash time must fall inside the
 * product's sensing window (the ref's `start/end`) with {@link WINDOW_TOLERANCE_MS} either
 * side; stray flashes are dropped and counted, and a product where more than
 * {@link MAX_OUTSIDE_WINDOW_FRACTION} of them stray is refused as mis-filed or misread.
 * Flashes outside the optional clip box (the polling bbox) are dropped before
 * serialization — a full-disk product has flashes over three continents.
 */

import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';

import * as h5wasm from 'h5wasm';

import type { BoundingBox } from '../../core/config/polling-bbox.js';

/** Must equal `LIGHTNING_PAYLOAD_FORMAT` in the core parser; a test holds them together. */
export const PAYLOAD_FORMAT = 'fire-watch.lightning.v1';

/** Must equal `DECODER_REFUSED_EXIT` in the sandbox adapter. */
export const EXIT_REFUSED = 65;

/** `EX_SOFTWARE`: a WebAssembly trap — libhdf5 misbehaved rather than declined. */
export const EXIT_DECODER_FAULT = 70;

/** Must equal `GRANULE_REF_ENV` in the sandbox adapter. */
export const REF_ENV = 'FW_GRANULE_REF';

/** An optional clip window, as JSON `{west,south,east,north}`. */
export const CLIP_ENV = 'FW_DECODE_CLIP';

/** An optional cap on stdin, in bytes, as a decimal string. */
export const MAX_INPUT_ENV = 'FW_DECODE_MAX_INPUT_BYTES';

/** Must equal `DECODER_REASON_PREFIX` in the sandbox adapter. */
export const REASON_PREFIX = 'fw-decoder-reason: ';

export const DECODER_NAME = 'h5wasm-mtg-li-lfl';

/** Must equal `LIGHTNING_SOURCE` / `LIGHTNING_KIND` in the core port. */
export const LIGHTNING_SOURCE = 'eumetsat:mtg-li:lfl';
export const LIGHTNING_KIND = 'lightning-flashes';

/**
 * A busy full-disk 10-minute product holds tens of thousands of flashes (the published
 * size, ~220 kB compressed, suggests far fewer on a quiet one). A declared length above
 * this is a dataset built to make the decoder allocate, refused from its metadata.
 */
export const MAX_FLASHES = 1_000_000;

/** A BODY file is a few hundred kB; 64 MiB is a generous ceiling for a storm season. */
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** Flash times may stray this far outside the sensing window before they are dropped. */
export const WINDOW_TOLERANCE_MS = 2 * 60_000;

/** More than this fraction of timed flashes outside the window refuses the product. */
export const MAX_OUTSIDE_WINDOW_FRACTION = 0.1;

/** `seconds since 2000-01-01 00:00:00.0` — the epoch, as Unix milliseconds. */
export const LI_EPOCH_MS = Date.UTC(2000, 0, 1);

/** The spec's units string for `flash_time`, with the trailing `.0` optional. */
const TIME_UNITS = /^seconds since 2000-01-01[ T]00:00:00(?:\.0+)?Z?$/u;

/** netCDF's default fills (netcdf.h), used only when the variable declares none. */
const NC_FILL_SHORT = -32767;
const NC_FILL_USHORT = 65535;

/** `\x89HDF\r\n\x1a\n` — netCDF-4 is HDF5 underneath. */
const HDF5_SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** `CDF\x01` / `CDF\x02` / `CDF\x05` — netCDF classic, which this decoder does not read. */
const NETCDF_CLASSIC_SIGNATURE = [0x43, 0x44, 0x46] as const;

/** One variable's contract, from EUM/MTG/SPE/10/0452 v5C Annex A.6.1.4. */
interface VariableSpec {
  readonly name: string;
  readonly required: boolean;
  /** HDF5 class: 0 integer, 1 float. */
  readonly type: 0 | 1;
  /** Element size in bytes. */
  readonly size: number;
  readonly signed: boolean;
  /** The exact units string, a pattern, or `null` when the spec gives none. */
  readonly units: string | RegExp | null;
  /** Whether `scale_factor` must be present (the spec lists it for this variable). */
  readonly scaled: boolean;
  readonly defaultFill: number | null;
}

export const LFL_VARIABLES = {
  time: {
    name: 'flash_time',
    required: true,
    type: 1,
    size: 8,
    signed: true,
    units: TIME_UNITS,
    scaled: false,
    defaultFill: null,
  },
  lat: {
    name: 'latitude',
    required: true,
    type: 0,
    size: 2,
    signed: true,
    units: 'degrees_north',
    scaled: true,
    defaultFill: NC_FILL_SHORT,
  },
  lon: {
    name: 'longitude',
    required: true,
    type: 0,
    size: 2,
    signed: true,
    units: 'degrees_east',
    scaled: true,
    defaultFill: NC_FILL_SHORT,
  },
  radiance: {
    name: 'radiance',
    required: false,
    type: 0,
    size: 2,
    signed: false,
    units: 'mW.m-2.sr-1',
    scaled: false,
    defaultFill: NC_FILL_USHORT,
  },
  duration: {
    name: 'flash_duration',
    required: false,
    type: 0,
    size: 2,
    signed: false,
    units: 'ms',
    scaled: false,
    defaultFill: null,
  },
  footprint: {
    name: 'flash_footprint',
    required: false,
    type: 0,
    size: 2,
    signed: false,
    units: null,
    scaled: false,
    defaultFill: null,
  },
} as const satisfies Record<string, VariableSpec>;

type VariableKey = keyof typeof LFL_VARIABLES;

/** The ref, as the child receives it. */
export interface LightningRef {
  readonly source: string;
  readonly kind: string;
  /** `start/end`, ISO-8601 UTC. */
  readonly slotIso: string;
  readonly name: string;
}

/** One flash, in the vocabulary `parseLightningPayload` reads. */
export interface FlashRow {
  /** Flash time, ISO-8601 UTC with milliseconds. */
  readonly t: string;
  readonly lat: number;
  readonly lon: number;
  /** mW·m⁻²·sr⁻¹, or `null` when absent or fill. */
  readonly radiance: number | null;
  readonly durationMs: number | null;
  readonly footprint: number | null;
}

export interface Payload {
  readonly format: typeof PAYLOAD_FORMAT;
  readonly window: { readonly start: string; readonly end: string };
  readonly flashes: readonly FlashRow[];
  /** What the decoder dropped and why — the core parser ignores it; the record keeps it. */
  readonly decoder: {
    readonly name: typeof DECODER_NAME;
    readonly flashes: number;
    readonly clippedOut: number;
    readonly droppedWithoutPosition: number;
    readonly droppedWithoutTime: number;
    readonly droppedOutsideWindow: number;
    readonly bytes: number;
  };
}

export type DecodeAttempt =
  | { readonly ok: true; readonly payload: Payload }
  | { readonly ok: false; readonly reason: string };

export interface DecodeOptions {
  readonly clip?: BoundingBox | null;
}

export function sniff(bytes: Uint8Array): 'hdf5' | 'netcdf-classic' | 'unknown' {
  if (startsWith(bytes, HDF5_SIGNATURE)) return 'hdf5';
  if (startsWith(bytes, NETCDF_CLASSIC_SIGNATURE)) return 'netcdf-classic';
  return 'unknown';
}

/** `start/end` to epoch milliseconds, or `null` when it is not two ordered UTC instants. */
export function parseWindow(slotIso: string): { start: number; end: number } | null {
  const parts = slotIso.split('/');
  if (parts.length !== 2) return null;
  const [startIso, endIso] = parts as [string, string];
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
  if (!iso.test(startIso) || !iso.test(endIso)) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/**
 * Bytes to payload, or the reason there is none. Throws only what h5wasm throws — a file
 * libhdf5 cannot open, or a WebAssembly trap — and `main` tells those apart.
 */
export async function decodeLflBody(
  ref: LightningRef,
  bytes: Uint8Array,
  options: DecodeOptions = {},
): Promise<DecodeAttempt> {
  if (ref.source !== LIGHTNING_SOURCE || ref.kind !== LIGHTNING_KIND) {
    return refuse(
      `ref ${JSON.stringify(ref.source)}/${JSON.stringify(ref.kind)} is not decoded by ${DECODER_NAME}`,
    );
  }
  const window = parseWindow(ref.slotIso);
  if (window === null) {
    return refuse(`ref window ${JSON.stringify(ref.slotIso)} is not an ISO start/end interval`);
  }
  const kind = sniff(bytes);
  if (kind === 'netcdf-classic') {
    return refuse('file is netCDF classic; the LFL BODY is specified as netCDF-4 (HDF5)');
  }
  if (kind !== 'hdf5') return refuse('file does not start with the HDF5 signature');

  const module = await h5wasm.ready;
  const path = '/lfl-body.nc';
  module.FS.writeFile(path, bytes);
  const file = new h5wasm.File(path, 'r');
  try {
    return readLflBody(file, window, options, bytes.length);
  } finally {
    file.close();
    module.FS.unlink(path);
  }
}

/** The A.6 layout, read from an open file. Exported for the layout tests. */
export function readLflBody(
  file: h5wasm.File,
  window: { readonly start: number; readonly end: number },
  options: DecodeOptions,
  byteLength: number,
): DecodeAttempt {
  const columns = new Map<VariableKey, Column>();
  let length: number | null = null;
  for (const [key, spec] of Object.entries(LFL_VARIABLES) as [VariableKey, VariableSpec][]) {
    const column = readColumn(file, spec);
    if (column === null) {
      if (spec.required) {
        return refuse(
          `required variable ${spec.name} is absent; root has ${describeNames(file.keys())}`,
        );
      }
      continue;
    }
    if (typeof column === 'string') return refuse(column);
    if (length !== null && column.values.length !== length) {
      return refuse(
        `${spec.name} has ${String(column.values.length)} elements, expected ${String(length)} (dimension flashes)`,
      );
    }
    length = column.values.length;
    columns.set(key, column);
  }
  const time = columns.get('time');
  const lat = columns.get('lat');
  const lon = columns.get('lon');
  if (time === undefined || lat === undefined || lon === undefined) {
    return refuse('required variables are absent');
  }

  const clip = options.clip ?? null;
  const flashes: FlashRow[] = [];
  let clippedOut = 0;
  let droppedWithoutPosition = 0;
  let droppedWithoutTime = 0;
  let droppedOutsideWindow = 0;
  const earliest = window.start - WINDOW_TOLERANCE_MS;
  const latest = window.end + WINDOW_TOLERANCE_MS;

  for (let i = 0; i < time.values.length; i += 1) {
    const seconds = physical(time, i);
    if (seconds === null) {
      droppedWithoutTime += 1;
      continue;
    }
    const at = Math.round(LI_EPOCH_MS + seconds * 1000);
    if (at < earliest || at > latest) {
      droppedOutsideWindow += 1;
      continue;
    }
    const y = physical(lat, i);
    const x = physical(lon, i);
    if (y === null || x === null || Math.abs(y) > 90 || Math.abs(x) > 180) {
      droppedWithoutPosition += 1;
      continue;
    }
    if (clip !== null && (y < clip.south || y > clip.north || x < clip.west || x > clip.east)) {
      clippedOut += 1;
      continue;
    }
    flashes.push({
      t: new Date(at).toISOString(),
      lat: round(y, 4),
      lon: round(x, 4),
      radiance: roundOrNull(optional(columns.get('radiance'), i), 3),
      durationMs: roundOrNull(optional(columns.get('duration'), i), 0),
      footprint: roundOrNull(optional(columns.get('footprint'), i), 0),
    });
  }

  const timed = time.values.length - droppedWithoutTime;
  if (timed > 0 && droppedOutsideWindow / timed > MAX_OUTSIDE_WINDOW_FRACTION) {
    return refuse(
      `${String(droppedOutsideWindow)} of ${String(timed)} flash times fall outside the window ${new Date(window.start).toISOString()}/${new Date(window.end).toISOString()} ± ${String(WINDOW_TOLERANCE_MS / 60_000)} min`,
    );
  }

  return {
    ok: true,
    payload: {
      format: PAYLOAD_FORMAT,
      window: {
        start: new Date(window.start).toISOString(),
        end: new Date(window.end).toISOString(),
      },
      flashes,
      decoder: {
        name: DECODER_NAME,
        flashes: time.values.length,
        clippedOut,
        droppedWithoutPosition,
        droppedWithoutTime,
        droppedOutsideWindow,
        bytes: byteLength,
      },
    },
  };
}

interface Column {
  readonly values: ArrayLike<number>;
  readonly scale: number;
  readonly offset: number;
  readonly fill: number | null;
}

/**
 * `null` when absent, a reason when present and not as specified, else the column. All
 * checks run on metadata before `.value` allocates anything.
 */
function readColumn(file: h5wasm.File, spec: VariableSpec): Column | string | null {
  const entity = file.get(spec.name);
  if (entity === null) return null;
  const name = spec.name;
  if (!(entity instanceof h5wasm.Dataset)) return `${name} is not a variable (dataset)`;
  const meta = entity.metadata;
  if (meta.virtual_sources !== undefined && meta.virtual_sources.length > 0) {
    return `${name} is a virtual dataset; the decoder reads no other file`;
  }
  // HDF5 reports `signed` only meaningfully for integers; a float's flag is not compared.
  const signedMatches = spec.type !== 0 || meta.signed === spec.signed;
  if (meta.type !== spec.type || meta.size !== spec.size || !signedMatches) {
    return `${name} is ${typeName(meta.type, meta.size, meta.signed)}, specified as ${typeName(spec.type, spec.size, spec.signed)}`;
  }
  const shape = meta.shape;
  if (shape?.length !== 1) {
    return `${name} has shape ${JSON.stringify(shape)}, expected one dimension (flashes)`;
  }
  const [declared] = shape;
  if (declared === undefined || declared > MAX_FLASHES) {
    return `${name} declares ${String(declared)} elements, over the ${String(MAX_FLASHES)} cap`;
  }

  if (spec.units !== null) {
    const units = stringAttribute(entity, 'units');
    if (units === null) return `${name} has no units attribute`;
    const matches = typeof spec.units === 'string' ? units === spec.units : spec.units.test(units);
    if (!matches) {
      return `${name} units are ${JSON.stringify(units)}, specified as ${JSON.stringify(
        typeof spec.units === 'string' ? spec.units : 'seconds since 2000-01-01 00:00:00.0',
      )}`;
    }
  }

  const scale = numericAttribute(entity, 'scale_factor', spec.scaled ? null : 1);
  if (typeof scale === 'string') return scale;
  if (scale === null) return `${name} has no scale_factor attribute`;
  if (scale === 0) return `${name} has scale_factor 0`;
  const offset = numericAttribute(entity, 'add_offset', 0);
  if (typeof offset === 'string') return offset;
  const fill = numericAttribute(entity, '_FillValue', spec.defaultFill);
  if (typeof fill === 'string') return fill;

  const values = entity.value;
  if (!isNumberArray(values)) return `${name} did not read as a number array`;
  return { values, scale, offset, fill };
}

function stringAttribute(dataset: h5wasm.Dataset, attr: string): string | null {
  const attribute = dataset.attrs[attr];
  if (attribute === undefined) return null;
  let value: unknown = attribute.value;
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (typeof value !== 'string') return null;
  // netCDF writes fixed-length strings NUL-padded; the padding is not part of the unit.
  return value.replace(/\0+$/u, '').trim();
}

function numericAttribute<T extends number | null>(
  dataset: h5wasm.Dataset,
  attr: string,
  fallback: T,
): number | T | string {
  const attribute = dataset.attrs[attr];
  if (attribute === undefined) return fallback;
  let value: unknown = attribute.value;
  if (ArrayBuffer.isView(value) && 'length' in value && value.length === 1) {
    value = (value as unknown as ArrayLike<unknown>)[0];
  }
  if (typeof value === 'bigint') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${dataset.path} attribute ${attr} is not a finite number`;
  }
  return value;
}

function typeName(type: number, size: number, signed: boolean): string {
  if (type === 1) return `a ${String(size * 8)}-bit float`;
  if (type === 0) return `a ${signed ? '' : 'un'}signed ${String(size * 8)}-bit integer`;
  return `HDF5 class ${String(type)}`;
}

/** The root names, sorted and capped, for a refusal that says what *was* found. */
function describeNames(names: readonly string[]): string {
  const sorted = [...names].sort();
  const shown = sorted.slice(0, 24).map((name) => name.slice(0, 64));
  const more = sorted.length > shown.length ? `, +${String(sorted.length - shown.length)}` : '';
  return sorted.length === 0 ? 'no variables' : `[${shown.join(', ')}${more}]`;
}

/** CF-decoded value at `i`, or `null` for the fill value. */
function physical(column: Column, i: number): number | null {
  const raw = column.values[i];
  if (raw === undefined || !Number.isFinite(raw)) return null;
  if (column.fill !== null && raw === column.fill) return null;
  return raw * column.scale + column.offset;
}

function optional(column: Column | undefined, i: number): number | null {
  return column === undefined ? null : physical(column, i);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundOrNull(value: number | null, digits: number): number | null {
  return value === null ? null : round(value, digits);
}

function isNumberArray(value: unknown): value is ArrayLike<number> {
  return (
    ArrayBuffer.isView(value) &&
    !(value instanceof DataView) &&
    !(value instanceof BigInt64Array) &&
    !(value instanceof BigUint64Array)
  );
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

function refuse(reason: string): DecodeAttempt {
  return { ok: false, reason };
}

/* ------------------------------------------------------------------------------------ */
/* The process: stdin → decode → stdout, with the exit code as the verdict.            */
/* ------------------------------------------------------------------------------------ */

export async function main(): Promise<number> {
  const ref = readRef(process.env[REF_ENV]);
  if (ref === null) return fail(EXIT_REFUSED, `${REF_ENV} is missing or malformed`);
  const clip = readClip(process.env[CLIP_ENV]);
  if (clip === 'invalid') return fail(EXIT_REFUSED, `${CLIP_ENV} is malformed`);
  const maxInput = Number(process.env[MAX_INPUT_ENV] ?? DEFAULT_MAX_INPUT_BYTES);

  const bytes = await readStdin(Number.isFinite(maxInput) ? maxInput : DEFAULT_MAX_INPUT_BYTES);
  if (bytes === null) return fail(EXIT_REFUSED, 'file exceeds the input cap');

  let attempt: DecodeAttempt;
  try {
    attempt = await decodeLflBody(ref, bytes, { clip });
  } catch (error) {
    if (isWasmTrap(error)) return fail(EXIT_DECODER_FAULT, `libhdf5 trapped: ${error.message}`);
    return fail(EXIT_REFUSED, `libhdf5 rejected the file: ${describe(error)}`);
  }
  if (!attempt.ok) return fail(EXIT_REFUSED, attempt.reason);

  process.stdout.write(JSON.stringify(attempt.payload));
  return 0;
}

export function isWasmTrap(error: unknown): error is Error {
  return error instanceof Error && error.name === 'RuntimeError';
}

function readRef(raw: string | undefined): LightningRef | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { source, kind, slot, name } = parsed;
    if (
      typeof source !== 'string' ||
      typeof kind !== 'string' ||
      typeof slot !== 'string' ||
      typeof name !== 'string'
    ) {
      return null;
    }
    return { source, kind, slotIso: slot, name };
  } catch {
    return null;
  }
}

function readClip(raw: string | undefined): BoundingBox | null | 'invalid' {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { west, south, east, north } = parsed;
    if (
      typeof west !== 'number' ||
      typeof south !== 'number' ||
      typeof east !== 'number' ||
      typeof north !== 'number'
    ) {
      return 'invalid';
    }
    return { west, south, east, north };
  } catch {
    return 'invalid';
  }
}

async function readStdin(maxBytes: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) return null;
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function fail(code: number, message: string): number {
  const line = message.replace(/\s+/g, ' ').trim().slice(0, 1_000);
  process.stderr.write(`\n${REASON_PREFIX}${line}\n`);
  return code;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Run only when this file is the process's entry point, never when a test imports it.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main();
}
