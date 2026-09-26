/**
 * The program on the far side of the wall: LSA SAF FRP-PIXEL HDF5 in, a
 * `fire-watch.granule.v1` payload out (TASKS C3a).
 *
 * This file is run as the child of `createChildProcessDecoder`, never imported by the
 * ingest process for its side effects. It is also imported by its own tests, which is why
 * the process-level work sits behind an entry-point guard at the bottom and everything
 * above it is plain functions.
 *
 * **Why h5wasm, and why this build of it.** libhdf5 is the native C parser review 05 E3
 * worries about. h5wasm is libhdf5 compiled to WebAssembly, so a memory-safety bug in it
 * corrupts the module's own linear memory rather than this process's heap, and a trap is
 * a catchable `WebAssembly.RuntimeError` rather than a segfault. The package ships two
 * builds; this file imports the default (ESM) one, whose Emscripten filesystem is
 * **MEMFS only** — no NODEFS, no NODERAWFS. The granule is written into that in-memory
 * filesystem and opened from there, so the HDF5 features that name *other* files
 * (external links, external raw storage, virtual datasets) resolve against an empty
 * in-memory directory, not the host disk. The `h5wasm/node` build would give libhdf5 the
 * real filesystem and is deliberately not used.
 *
 * **Self-contained on purpose.** Apart from `h5wasm` and node builtins, this module has
 * only `import type` dependencies — plus one runtime sibling, `bunzip2`, loaded by a
 * dynamic import that mirrors this file's own extension (`.ts` under the tests, `.js`
 * from the build). That lets the tests run the real child straight from the TypeScript
 * source (Node strips the types), and it keeps the reach of the child — which runs under
 * the Node permission model with read access to this file, its bzip2 sibling and h5wasm
 * — independent of how the rest of the server is laid out.
 *
 * **bzip2.** LSA SAF ships these files as `.bz2`. They are unpacked here, behind the
 * wall, by `bunzip2.ts` — never in the ingest process — under an absolute output cap and
 * a ratio cap, before libhdf5 sees a byte. See that file for why it is not a library.
 *
 * **Layout.** LSA-502 publishes FRP-PIXEL as two HDF5 files per 15-minute slot: a
 * full-disk *quality* grid and a *list* of fire pixels. Only the list is read: it is
 * already the detection shape, one element per fire pixel across a set of parallel 1-D
 * datasets (`LATITUDE`, `LONGITUDE`, `FRP`, `FIRE_CONFIDENCE`, `BT_MIR`, `BW_BT_MIR`, …),
 * each an integer array carrying `SCALING_FACTOR`, `OFFSET` and `MISSING_VALUE`
 * attributes. The dataset and attribute names are taken from the LSA SAF FRP-PIXEL
 * product user manual as recalled for this spike and **have not been checked against a
 * real granule** (no LSA SAF account yet) — see `docs/spikes/c3a-granule-decode.md`. Every
 * assumption about them fails loudly as a refusal rather than decoding to something
 * plausible.
 */

import { Buffer } from 'node:buffer';
import { extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as h5wasm from 'h5wasm';

import type { BoundingBox } from '../../core/config/polling-bbox.js';
import type { GranuleRef } from '../../core/ports/granule-decoder.js';
import type * as Bunzip2Module from './bunzip2.js';

/** Must equal `GRANULE_PAYLOAD_FORMAT` in the core reader; a test holds them together. */
export const PAYLOAD_FORMAT = 'fire-watch.granule.v1';

/** Must equal `DECODER_REFUSED_EXIT` in the sandbox adapter; a test holds them together. */
export const EXIT_REFUSED = 65;

/**
 * `EX_SOFTWARE`: the decoder itself failed. Used for a WebAssembly trap — the one outcome
 * that means libhdf5 misbehaved on this file rather than declining it, and so the one a
 * poisoned-granule alert should look at first.
 */
export const EXIT_DECODER_FAULT = 70;

/** Must equal `GRANULE_REF_ENV` in the sandbox adapter. */
export const REF_ENV = 'FW_GRANULE_REF';

/** An optional pre-filter window, as JSON `{west,south,east,north}`. */
export const CLIP_ENV = 'FW_DECODE_CLIP';

/** An optional cap on stdin, in bytes, as a decimal string. */
export const MAX_INPUT_ENV = 'FW_DECODE_MAX_INPUT_BYTES';

/** An optional cap on the bytes a `.bz2` granule may unpack to, as a decimal string. */
export const MAX_UNPACKED_ENV = 'FW_DECODE_MAX_UNPACKED_BYTES';

/** An optional cap on unpacked ÷ packed size for a `.bz2` granule, as a decimal string. */
export const MAX_UNPACK_RATIO_ENV = 'FW_DECODE_MAX_UNPACK_RATIO';

/**
 * Must equal `DECODER_REASON_PREFIX` in the sandbox adapter; a test holds them together.
 * libhdf5 writes its own diagnostic stack to stderr ahead of our reason, and the parent
 * finds the reason by this prefix instead of hoping it survives the error cap.
 */
export const REASON_PREFIX = 'fw-decoder-reason: ';

/** The name this decoder reports itself by in the payload envelope. */
export const DECODER_NAME = 'h5wasm-lsa-frp-pixel-list';

/**
 * A full-disk FRP-PIXEL list is hundreds to a few thousand fire pixels on a busy African
 * afternoon. A declared length above this is not a busy afternoon; it is a dataset built
 * to make the decoder allocate, and it is refused from the metadata before any of it is
 * read.
 */
export const MAX_LIST_PIXELS = 200_000;

/** The raw granule, compressed or not, may be no larger than this unless told otherwise. */
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;

/**
 * A `.bz2` granule may unpack to no more than this. A full-disk SEVIRI int16 grid is
 * 3712² × 2 ≈ 27.6 MB before HDF5 overhead, and the list product is far smaller; 128 MiB
 * is room for either with a margin, and a quarter of the WebAssembly memory ceiling the
 * unpacked file is then copied into. **Provisional** until a real granule is measured.
 */
export const DEFAULT_MAX_UNPACKED_BYTES = 128 * 1024 * 1024;

/**
 * Above {@link UNPACK_RATIO_FLOOR_BYTES}, a `.bz2` granule may not unpack to more than
 * this multiple of its packed size. Real HDF5 compresses well — it is padded, and a
 * fire list is mostly fill values — but not by three orders of magnitude over tens of
 * megabytes; a bomb does (64 MiB of zeros packs to ~50 bytes). **Provisional.**
 */
export const DEFAULT_MAX_UNPACK_RATIO = 1000;

/** Output below this is never refused on ratio: small, padded, honest files compress absurdly. */
export const UNPACK_RATIO_FLOOR_BYTES = 32 * 1024 * 1024;

/** `\x89HDF\r\n\x1a\n` — the HDF5 superblock signature at offset 0. */
const HDF5_SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** `BZh` — how LSA SAF ships these files (`….bz2`). */
const BZIP2_SIGNATURE = [0x42, 0x5a, 0x68] as const;

/**
 * FIRE_CONFIDENCE is a detection probability in [0, 1]. The three-class split below is a
 * **provisional spike choice**, not a calibrated one: it maps the product's continuous
 * confidence onto the archive's `low | nominal | high` vocabulary so the pipe can be
 * exercised end to end. The raw probability travels verbatim in `confidenceRaw`, so a
 * later calibration (review 11) re-derives the class without re-decoding anything.
 */
export const CONFIDENCE_HIGH_AT = 0.8;
export const CONFIDENCE_NOMINAL_AT = 0.5;

/** One list-product field: where it lives and whether a granule without it is a granule. */
interface FieldSpec {
  readonly dataset: string;
  readonly required: boolean;
}

/**
 * The LSA-502 list-product fields this decoder reads. Everything else in the file is
 * ignored — an allowlist, not a walk, so a file cannot steer the decoder into a dataset
 * it was not going to read.
 */
export const LSA_502_LIST_FIELDS = {
  lat: { dataset: 'LATITUDE', required: true },
  lon: { dataset: 'LONGITUDE', required: true },
  frp: { dataset: 'FRP', required: true },
  confidence: { dataset: 'FIRE_CONFIDENCE', required: true },
  btMir: { dataset: 'BT_MIR', required: false },
  btMirBackground: { dataset: 'BW_BT_MIR', required: false },
} as const satisfies Record<string, FieldSpec>;

type FieldName = keyof typeof LSA_502_LIST_FIELDS;

/** The root attribute that names the acquisition slot, `YYYYMMDDhhmmss`. */
export const ACQUISITION_TIME_ATTR = 'IMAGE_ACQUISITION_TIME';

/** One decoded row, in the vocabulary `parseGranulePayload` reads. */
export interface PayloadRow {
  readonly lat: number;
  readonly lon: number;
  readonly acq: string;
  readonly frpMw: number | null;
  readonly confidence: 'low' | 'nominal' | 'high';
  readonly confidenceRaw: string;
  readonly brightnessK: number | null;
  readonly brightnessBgK: number | null;
}

export interface Payload {
  readonly format: typeof PAYLOAD_FORMAT;
  readonly source: string;
  readonly kind: string;
  readonly slot: string;
  readonly detections: readonly PayloadRow[];
  /**
   * What the decoder did besides produce rows, so none of it is silent. The core reader
   * ignores this member; it exists for the quarantine record and the spike measurements.
   */
  readonly decoder: {
    readonly name: typeof DECODER_NAME;
    readonly pixels: number;
    readonly clippedOut: number;
    readonly droppedWithoutPosition: number;
    readonly droppedWithoutConfidence: number;
    /** How the granule arrived: as HDF5, or as bzip2 that unpacked to HDF5. */
    readonly compression: 'none' | 'bzip2';
    /** The bytes received, before any unpacking. */
    readonly packedBytes: number;
    /** The bytes libhdf5 opened. Equal to `packedBytes` when nothing was unpacked. */
    readonly hdf5Bytes: number;
  };
}

export type DecodeAttempt =
  | { readonly ok: true; readonly payload: Payload }
  | { readonly ok: false; readonly reason: string };

export interface DecodeOptions {
  /**
   * Drop rows outside this window before they are serialized. The poller applies the
   * polling bbox again on the canonical text, so this is an optimisation with a margin,
   * never the decision: its job is to keep a full-disk list from overrunning the
   * payload's 1 MB cap on a busy slot somewhere else on the disk.
   */
  readonly clip?: BoundingBox | null;
  /** Cap on what a `.bz2` granule may unpack to. Default {@link DEFAULT_MAX_UNPACKED_BYTES}. */
  readonly maxUnpackedBytes?: number;
  /** Cap on unpacked ÷ packed size. Default {@link DEFAULT_MAX_UNPACK_RATIO}. */
  readonly maxUnpackRatio?: number;
}

/** What the granule bytes are, from their first bytes alone. */
export function sniff(bytes: Uint8Array): 'hdf5' | 'bzip2' | 'unknown' {
  if (startsWith(bytes, HDF5_SIGNATURE)) return 'hdf5';
  if (startsWith(bytes, BZIP2_SIGNATURE)) return 'bzip2';
  return 'unknown';
}

/**
 * Bytes to payload, or the reason there is none. Throws only what h5wasm throws — a file
 * libhdf5 cannot open, or a WebAssembly trap — and the caller tells those apart.
 */
export async function decodeGranule(
  ref: GranuleRef,
  bytes: Uint8Array,
  options: DecodeOptions = {},
): Promise<DecodeAttempt> {
  if (ref.kind !== 'frp') {
    // DATA-SOURCES §E2: the cloud mask is archived as bytes and not parsed this season.
    return refuse(`kind ${JSON.stringify(ref.kind)} is not decoded by ${DECODER_NAME}`);
  }
  if (ref.source !== 'lsasaf:seviri:frp-pixel') {
    // LSA-509 is netCDF-4, which h5wasm opens (it is HDF5), but its variable names are
    // not pinned yet. Guessing them would decode to plausible nonsense; refusing is honest.
    return refuse(`source ${JSON.stringify(ref.source)} has no layout in ${DECODER_NAME}`);
  }

  const packedBytes = bytes.length;
  let compression: Payload['decoder']['compression'] = 'none';
  let hdf5 = bytes;
  if (sniff(bytes) === 'bzip2') {
    const unpacked = await unpackBzip2(bytes, options);
    if (!unpacked.ok) return unpacked;
    compression = 'bzip2';
    hdf5 = unpacked.bytes;
    if (sniff(hdf5) === 'bzip2') return refuse('bzip2 granule unpacks to another bzip2 stream');
  }
  if (sniff(hdf5) !== 'hdf5') {
    return refuse(
      compression === 'bzip2'
        ? 'bzip2 granule does not unpack to an HDF5 file'
        : 'granule does not start with the HDF5 signature',
    );
  }

  const module = await h5wasm.ready;
  // One granule per process, so one fixed name. MEMFS lives in this process's memory and
  // dies with it; nothing here touches the host filesystem.
  const path = '/granule.h5';
  module.FS.writeFile(path, hdf5);
  const file = new h5wasm.File(path, 'r');
  try {
    return readListProduct(file, ref, options, {
      compression,
      packedBytes,
      hdf5Bytes: hdf5.length,
    });
  } finally {
    file.close();
    module.FS.unlink(path);
  }
}

/**
 * Unpack a `.bz2` granule inside the child, within the caps. Every way it can fail is a
 * refusal with a reason: a truncated download, a corrupt stream and a bomb are all the
 * file's problem, and none of them is a trap.
 */
async function unpackBzip2(
  bytes: Uint8Array,
  options: DecodeOptions,
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string }
> {
  const { bunzip2, Bunzip2Error } = await loadBunzip2();
  try {
    const out = bunzip2(bytes, {
      maxOutputBytes: options.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES,
      maxRatio: options.maxUnpackRatio ?? DEFAULT_MAX_UNPACK_RATIO,
      ratioFloorBytes: UNPACK_RATIO_FLOOR_BYTES,
    });
    return { ok: true, bytes: out };
  } catch (error) {
    // Every Bunzip2Error message names bzip2 itself, so it stands as the reason.
    if (error instanceof Bunzip2Error) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * The sibling decompressor, loaded with this file's own extension so the same code runs
 * from the TypeScript source under the tests and from the build in production. The
 * decoder's argv grants read access to exactly that sibling (`decoderArgs`).
 */
function loadBunzip2(): Promise<typeof Bunzip2Module> {
  const extension = extname(fileURLToPath(import.meta.url));
  return import(new URL(`./bunzip2${extension}`, import.meta.url).href) as Promise<
    typeof Bunzip2Module
  >;
}

/** How the bytes libhdf5 opened arrived, carried into the payload's `decoder` block. */
export type Arrival = Pick<Payload['decoder'], 'compression' | 'packedBytes' | 'hdf5Bytes'>;

/** The LSA-502 list layout, read from an open file. Exported for the layout tests. */
export function readListProduct(
  file: h5wasm.File,
  ref: GranuleRef,
  options: DecodeOptions,
  arrival: Arrival,
): DecodeAttempt {
  const acquired = readAcquisitionSlot(file);
  if (typeof acquired !== 'string') return refuse(acquired.reason);
  if (acquired !== ref.slotIso) {
    // The file says which slot it is. A granule that disagrees with the address it was
    // fetched under is either mis-filed upstream or not what it claims to be; both are
    // quarantine, and neither should be attributed to the slot we asked for.
    return refuse(
      `${ACQUISITION_TIME_ATTR} is ${acquired}, but the granule was fetched as ${ref.slotIso}`,
    );
  }

  const columns = new Map<FieldName, Column>();
  let length: number | null = null;
  for (const [field, spec] of Object.entries(LSA_502_LIST_FIELDS) as [FieldName, FieldSpec][]) {
    const column = readColumn(file, spec.dataset);
    if (column === null) {
      if (spec.required) return refuse(`required dataset ${spec.dataset} is absent`);
      continue;
    }
    if (typeof column === 'string') return refuse(column);
    if (length !== null && column.values.length !== length) {
      return refuse(
        `${spec.dataset} has ${String(column.values.length)} elements, expected ${String(length)}`,
      );
    }
    length = column.values.length;
    columns.set(field, column);
  }

  const lat = columns.get('lat');
  const lon = columns.get('lon');
  const frp = columns.get('frp');
  const confidence = columns.get('confidence');
  if (!lat || !lon || !frp || !confidence) return refuse('required datasets are absent');

  const clip = options.clip ?? null;
  const detections: PayloadRow[] = [];
  let clippedOut = 0;
  let droppedWithoutPosition = 0;
  let droppedWithoutConfidence = 0;

  for (let i = 0; i < lat.values.length; i += 1) {
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
    const probability = physical(confidence, i);
    if (probability === null || probability < 0 || probability > 1) {
      droppedWithoutConfidence += 1;
      continue;
    }
    detections.push({
      lat: y,
      lon: x,
      acq: ref.slotIso,
      frpMw: physical(frp, i),
      confidence: confidenceClass(probability),
      confidenceRaw: String(probability),
      brightnessK: optional(columns.get('btMir'), i),
      brightnessBgK: optional(columns.get('btMirBackground'), i),
    });
  }

  return {
    ok: true,
    payload: {
      format: PAYLOAD_FORMAT,
      source: ref.source,
      kind: ref.kind,
      slot: ref.slotIso,
      detections,
      decoder: {
        name: DECODER_NAME,
        pixels: lat.values.length,
        clippedOut,
        droppedWithoutPosition,
        droppedWithoutConfidence,
        ...arrival,
      },
    },
  };
}

export function confidenceClass(probability: number): PayloadRow['confidence'] {
  if (probability >= CONFIDENCE_HIGH_AT) return 'high';
  if (probability >= CONFIDENCE_NOMINAL_AT) return 'nominal';
  return 'low';
}

/** A dataset, read and checked, with the attributes that turn its integers into values. */
interface Column {
  readonly name: string;
  readonly values: ArrayLike<number>;
  readonly scale: number;
  readonly missing: number | null;
}

/**
 * `null` when the dataset is absent; a reason when it is present and wrong; a column when
 * it is what the layout says. Every check here runs on metadata, **before** `.value`
 * allocates anything — a dataset that declares a billion elements behind a tiny compressed
 * chunk is refused by its shape, not discovered by running out of memory.
 */
function readColumn(file: h5wasm.File, name: string): Column | string | null {
  const entity = file.get(name);
  if (entity === null) return null;
  if (!(entity instanceof h5wasm.Dataset)) return `${name} is not a dataset`;

  const meta = entity.metadata;
  if (meta.virtual_sources !== undefined && meta.virtual_sources.length > 0) {
    return `${name} is a virtual dataset; the decoder reads no other file`;
  }
  // H5T_INTEGER = 0, H5T_FLOAT = 1. Anything else (strings, references, compounds,
  // opaque, vlen) is not a number column whatever the file calls it.
  if (meta.type !== 0 && meta.type !== 1) return `${name} is not a numeric dataset`;
  if (meta.size > 4 && meta.type === 0) {
    // 64-bit integers come back as BigInt64Array; no list field needs that range.
    return `${name} is a ${String(meta.size * 8)}-bit integer; the layout uses at most 32`;
  }
  const shape = meta.shape;
  if (shape?.length !== 1) {
    return `${name} has shape ${JSON.stringify(shape)}, expected one dimension`;
  }
  const [declared] = shape;
  if (declared === undefined || declared > MAX_LIST_PIXELS) {
    return `${name} declares ${String(declared)} elements, over the ${String(MAX_LIST_PIXELS)} cap`;
  }

  const scale = numericAttribute(entity, 'SCALING_FACTOR', 1);
  if (typeof scale === 'string') return scale;
  if (scale === 0) return `${name} has SCALING_FACTOR 0`;
  const offset = numericAttribute(entity, 'OFFSET', 0);
  if (typeof offset === 'string') return offset;
  if (offset !== 0) {
    // Whether LSA SAF adds or subtracts OFFSET (and before or after scaling) is not pinned
    // down for this spike, and every field we read carries 0. A non-zero one is the day
    // that stops being true, and that day should be a refusal rather than a silent skew.
    return `${name} has OFFSET ${String(offset)}; only 0 is understood`;
  }
  const missing = numericAttribute(entity, 'MISSING_VALUE', null);
  if (typeof missing === 'string') return missing;

  const values = entity.value;
  if (!isNumberArray(values)) return `${name} did not read as a number array`;
  return { name, values, scale, missing };
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

function readAcquisitionSlot(file: h5wasm.File): string | { reason: string } {
  const attribute = file.attrs[ACQUISITION_TIME_ATTR];
  if (attribute === undefined)
    return { reason: `root attribute ${ACQUISITION_TIME_ATTR} is absent` };
  const value = attribute.value;
  const text = typeof value === 'string' ? value.trim() : null;
  const match = text === null ? null : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(text);
  if (match === null) {
    return { reason: `root attribute ${ACQUISITION_TIME_ATTR} is not YYYYMMDDhhmm[ss]` };
  }
  const [, y, mo, d, h, mi] = match;
  return `${y ?? ''}-${mo ?? ''}-${d ?? ''}T${h ?? ''}:${mi ?? ''}:00Z`;
}

/** Scaled value at `i`, or `null` for the fill value. */
function physical(column: Column, i: number): number | null {
  const raw = column.values[i];
  if (raw === undefined || !Number.isFinite(raw)) return null;
  if (column.missing !== null && raw === column.missing) return null;
  // Rounded to the precision the scale implies, so `4271 / 100` is `42.71` and not
  // `42.710000000000001`: the payload is text, and noise digits are bytes of it.
  const digits = Math.max(0, Math.ceil(Math.log10(Math.abs(column.scale))));
  return Number((raw / column.scale).toFixed(Math.min(digits + 2, 10)));
}

function optional(column: Column | undefined, i: number): number | null {
  return column === undefined ? null : physical(column, i);
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

/**
 * The child's whole life. Reads the ref and the options from the environment the parent
 * built from nothing, the granule from stdin, and answers on stdout with an exit code the
 * parent maps to a `DecodeOutcome`: 0 payload, {@link EXIT_REFUSED} refusal,
 * {@link EXIT_DECODER_FAULT} trap. Anything else — a signal, an abort — is the parent's
 * `crashed`.
 */
export async function main(): Promise<number> {
  const ref = readRef(process.env[REF_ENV]);
  if (ref === null) return fail(EXIT_REFUSED, `${REF_ENV} is missing or malformed`);
  const clip = readClip(process.env[CLIP_ENV]);
  if (clip === 'invalid') return fail(EXIT_REFUSED, `${CLIP_ENV} is malformed`);
  const maxInput = Number(process.env[MAX_INPUT_ENV] ?? DEFAULT_MAX_INPUT_BYTES);
  const maxUnpackedBytes = positive(process.env[MAX_UNPACKED_ENV], DEFAULT_MAX_UNPACKED_BYTES);
  const maxUnpackRatio = positive(process.env[MAX_UNPACK_RATIO_ENV], DEFAULT_MAX_UNPACK_RATIO);

  const bytes = await readStdin(Number.isFinite(maxInput) ? maxInput : DEFAULT_MAX_INPUT_BYTES);
  if (bytes === null) return fail(EXIT_REFUSED, 'granule exceeds the input cap');

  let attempt: DecodeAttempt;
  try {
    attempt = await decodeGranule(ref, bytes, { clip, maxUnpackedBytes, maxUnpackRatio });
  } catch (error) {
    if (isWasmTrap(error)) {
      return fail(EXIT_DECODER_FAULT, `libhdf5 trapped: ${error.message}`);
    }
    // libhdf5 returned an error for this file — it read enough to decline it.
    return fail(EXIT_REFUSED, `libhdf5 rejected the granule: ${describe(error)}`);
  }
  if (!attempt.ok) return fail(EXIT_REFUSED, attempt.reason);

  process.stdout.write(JSON.stringify(attempt.payload));
  return 0;
}

/**
 * A WebAssembly trap (`WebAssembly.RuntimeError`). Matched by name because the server's
 * TypeScript lib has no DOM/WebAssembly value declarations.
 */
export function isWasmTrap(error: unknown): error is Error {
  return error instanceof Error && error.name === 'RuntimeError';
}

function readRef(raw: string | undefined): GranuleRef | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { source, kind, slot, name } = parsed;
    if (typeof source !== 'string' || typeof slot !== 'string' || typeof name !== 'string') {
      return null;
    }
    if (kind !== 'frp' && kind !== 'cloud-mask') return null;
    return { source: source as GranuleRef['source'], kind, slotIso: slot, name };
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

/** A positive number from the environment, or the default when absent or not one. */
function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The reason, as the last line of stderr behind {@link REASON_PREFIX}, which the parent
 * looks for first. libhdf5 prints its diagnostic stack to stderr before we get control
 * back, and that stack alone is longer than the parent keeps.
 */
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
  // `exitCode`, not `exit()`: stdout to a pipe is asynchronous on macOS, and `exit()`
  // would cut the payload off mid-write.
  process.exitCode = await main();
}
