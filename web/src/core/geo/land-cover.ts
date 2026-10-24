/**
 * Land cover under an event (V2-F4): the parser for the `fire-watch/landcover-web@1` asset
 * and the pure question the event detail asks of it — "what is the land around these
 * detections: forest, cropland, grassland …?".
 *
 * The asset is written by `infra/geodata/landcover-web.ts` (its only writer; the format
 * constants are repeated there because that project compiles on Node built-ins alone). It
 * is ESA WorldCover 2021 (DS-7) pooled to 0.02° cells — about 1.7 km × 2.2 km at 42° N —
 * with eight class groups whose shares in a cell are integers summing to `scale`. A cell
 * with no WorldCover data (open sea outside every tile) is empty.
 *
 * The mix is the plain mean of the group shares over the distinct cells the points fall
 * in, so ten detections in one cell count once: the answer describes the land the event
 * covers, not where the satellite looked most often. Empty cells and points outside the
 * grid are left out; no cell with data means no answer.
 *
 * Pure: no I/O, no DOM. The UI module (`ui/land-cover.ts`) fetches the asset and owns the
 * signals. The sentence is assembled here too ({@link landCoverSentence}), so the label
 * mapping ships in this lazily loaded chunk rather than on the critical path (CI-12).
 */

import type { Messages } from '../i18n/messages.js';

export const LAND_COVER_FORMAT = 'fire-watch/landcover-web@1';

/** The groups, in the order of the asset's share vectors. */
export const LAND_COVER_GROUPS = [
  'tree',
  'shrub',
  'grass',
  'crop',
  'built',
  'bare',
  'water',
  'wetland',
] as const;
export type LandCoverGroup = (typeof LAND_COVER_GROUPS)[number];

/** The catalog key that names each group inside the sentence. */
const LABEL_KEYS = {
  tree: 'landCoverTree',
  shrub: 'landCoverShrub',
  grass: 'landCoverGrass',
  crop: 'landCoverCrop',
  built: 'landCoverBuilt',
  bare: 'landCoverBare',
  water: 'landCoverWater',
  wetland: 'landCoverWetland',
} as const satisfies Record<LandCoverGroup, keyof Messages['eventDetail']>;

/** The note rounds each share to this many percent and drops what rounds below it. */
export const LAND_COVER_STEP_PERCENT = 10;
/** The note names at most this many groups; the rest are too small to matter. */
export const LAND_COVER_MAX_GROUPS = 4;

export interface LandCoverGrid {
  readonly version: string;
  readonly licence: string;
  readonly attribution: string;
  readonly west: number;
  readonly north: number;
  readonly cellDeg: number;
  readonly cols: number;
  readonly rows: number;
  readonly scale: number;
  /** Share vectors by palette index; an empty vector is a cell with no data. */
  readonly palette: readonly (readonly number[])[];
  /** Palette index per cell, row-major from the north-west corner. */
  readonly cells: Uint16Array;
}

export interface LandCoverShare {
  readonly group: LandCoverGroup;
  /** Mean share over the cells, 0–1. */
  readonly share: number;
}

export interface LandCoverMix {
  /** Distinct cells with data the points fell in. */
  readonly cells: number;
  /** Every group with a share above zero, largest first (ties in group order). */
  readonly shares: readonly LandCoverShare[];
}

export interface LandCoverPart {
  readonly group: LandCoverGroup;
  /** A multiple of {@link LAND_COVER_STEP_PERCENT}, at least one step. */
  readonly percent: number;
}

export class LandCoverFormatError extends Error {
  override readonly name = 'LandCoverFormatError';
}

function fail(message: string): never {
  throw new LandCoverFormatError(`landcover asset: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) fail(`"${key}" must be a string`);
  return value;
}

function requireNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`"grid.${key}" must be a number`);
  return value;
}

function requireCount(body: Record<string, unknown>, key: string, max: number): number {
  const value = requireNumber(body, key);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    fail(`"grid.${key}" must be an integer in 1–${String(max)}`);
  }
  return value;
}

/**
 * Parse and decode the asset. Throws {@link LandCoverFormatError} on anything malformed —
 * a half-decoded grid would put the wrong land under an event.
 */
export function parseLandCover(json: unknown): LandCoverGrid {
  if (!isRecord(json)) fail('not an object');
  if (json['format'] !== LAND_COVER_FORMAT) {
    fail(`format must be ${JSON.stringify(LAND_COVER_FORMAT)}`);
  }
  const version = requireString(json, 'version');
  const licence = requireString(json, 'licence');
  const attribution = requireString(json, 'attribution');
  const grid = json['grid'];
  if (!isRecord(grid)) fail('"grid" must be an object');
  const west = requireNumber(grid, 'west');
  const north = requireNumber(grid, 'north');
  const cellDeg = requireNumber(grid, 'cell_deg');
  if (cellDeg <= 0) fail('"grid.cell_deg" must be positive');
  const cols = requireCount(grid, 'cols', 10_000);
  const rows = requireCount(grid, 'rows', 10_000);
  const scale = requireCount(grid, 'scale', 1_000);

  const groups = json['groups'];
  if (
    !Array.isArray(groups) ||
    groups.length !== LAND_COVER_GROUPS.length ||
    groups.some((group, i) => group !== LAND_COVER_GROUPS[i])
  ) {
    fail(`"groups" must be ${JSON.stringify(LAND_COVER_GROUPS)}`);
  }

  const rawPalette = json['palette'];
  if (!Array.isArray(rawPalette) || rawPalette.length === 0 || rawPalette.length > 65_535) {
    fail('"palette" must be a non-empty array');
  }
  const palette = rawPalette.map((entry: unknown, i): readonly number[] => {
    if (!Array.isArray(entry)) fail(`palette ${String(i)} is not an array`);
    if (entry.length === 0) return [];
    if (entry.length !== LAND_COVER_GROUPS.length) {
      fail(`palette ${String(i)} must have ${String(LAND_COVER_GROUPS.length)} shares`);
    }
    let sum = 0;
    for (const share of entry as unknown[]) {
      if (typeof share !== 'number' || !Number.isInteger(share) || share < 0) {
        fail(`palette ${String(i)} has a share that is not a non-negative integer`);
      }
      sum += share;
    }
    if (sum !== scale) fail(`palette ${String(i)} sums to ${String(sum)}, not ${String(scale)}`);
    return entry as number[];
  });

  const rawRows = json['rows'];
  if (!Array.isArray(rawRows) || rawRows.length !== rows) {
    fail(`"rows" must hold ${String(rows)} rows`);
  }
  const cells = new Uint16Array(cols * rows);
  rawRows.forEach((runs: unknown, row) => {
    if (!Array.isArray(runs) || runs.length === 0 || runs.length % 2 !== 0) {
      fail(`row ${String(row)} is not a list of runs`);
    }
    let col = 0;
    for (let i = 0; i < runs.length; i += 2) {
      const index: unknown = runs[i];
      const length: unknown = runs[i + 1];
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= palette.length
      ) {
        fail(`row ${String(row)} has a palette index out of range`);
      }
      if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0) {
        fail(`row ${String(row)} has a run that is not a positive length`);
      }
      if (col + length > cols) fail(`row ${String(row)} runs past ${String(cols)} columns`);
      cells.fill(index, row * cols + col, row * cols + col + length);
      col += length;
    }
    if (col !== cols) fail(`row ${String(row)} covers ${String(col)} of ${String(cols)} columns`);
  });

  return { version, licence, attribution, west, north, cellDeg, cols, rows, scale, palette, cells };
}

/** The cell a point falls in, or `null` outside the grid. */
export function landCoverCell(
  grid: LandCoverGrid,
  point: { readonly lon: number; readonly lat: number },
): number | null {
  const col = Math.floor((point.lon - grid.west) / grid.cellDeg);
  const row = Math.floor((grid.north - point.lat) / grid.cellDeg);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
  return row * grid.cols + col;
}

/** The mean group mix over the distinct cells with data under `points`; `null` if none. */
export function landCoverMix(
  grid: LandCoverGrid,
  points: readonly { readonly lon: number; readonly lat: number }[],
): LandCoverMix | null {
  const seen = new Set<number>();
  const sums = new Array<number>(LAND_COVER_GROUPS.length).fill(0);
  let count = 0;
  for (const point of points) {
    const cell = landCoverCell(grid, point);
    if (cell === null || seen.has(cell)) continue;
    seen.add(cell);
    const shares = grid.palette[grid.cells[cell] ?? 0] ?? [];
    if (shares.length === 0) continue;
    count += 1;
    shares.forEach((share, i) => {
      sums[i] = (sums[i] ?? 0) + share;
    });
  }
  if (count === 0) return null;
  const shares = LAND_COVER_GROUPS.map((group, i) => ({
    group,
    share: (sums[i] ?? 0) / (count * grid.scale),
  }))
    .filter((entry) => entry.share > 0)
    .sort(
      (a, b) =>
        b.share - a.share ||
        LAND_COVER_GROUPS.indexOf(a.group) - LAND_COVER_GROUPS.indexOf(b.group),
    );
  return { cells: count, shares };
}

/**
 * What the note says: each share rounded to {@link LAND_COVER_STEP_PERCENT}, those that
 * round to zero dropped, at most {@link LAND_COVER_MAX_GROUPS}, largest first. The parts
 * need not sum to 100 — a sentence that claims more precision than tenths of a 2 km cell
 * would mislead.
 */
export function landCoverParts(mix: LandCoverMix): readonly LandCoverPart[] {
  return mix.shares
    .map(({ group, share }) => ({
      group,
      // `toFixed` first, so a half step written as 3.4999… in binary still rounds up.
      percent:
        Math.round(Number(((share * 100) / LAND_COVER_STEP_PERCENT).toFixed(6))) *
        LAND_COVER_STEP_PERCENT,
    }))
    .filter((part) => part.percent > 0)
    .slice(0, LAND_COVER_MAX_GROUPS);
}

/** The sentence for the rounded parts, in their order. */
export function landCoverText(parts: readonly LandCoverPart[], t: Messages['eventDetail']): string {
  return t.landCover(
    parts.map((part) => t.landCoverPart(t[LABEL_KEYS[part.group]], part.percent)).join(', '),
  );
}

/**
 * The event-detail sentence for the land under `points`, or `null` when there is nothing
 * to say (no cell with data, or every share rounds to zero).
 */
export function landCoverSentence(
  grid: LandCoverGrid,
  points: readonly { readonly lon: number; readonly lat: number }[],
  t: Messages['eventDetail'],
): string | null {
  const mix = landCoverMix(grid, points);
  const parts = mix === null ? [] : landCoverParts(mix);
  return parts.length === 0 ? null : landCoverText(parts, t);
}
