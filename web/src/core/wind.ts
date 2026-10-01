/**
 * The F14 wind context layer, the pure half: what the server's (or the fixture's)
 * `/overlays/wind/latest.json` body is, how it is validated, and how it becomes arrows.
 *
 * The body is one ECMWF IFS forecast step on a coarse grid (0.5°, the polling bbox):
 * `speed_ms` in m/s and `direction_from_deg` in the meteorological convention — the
 * direction the wind blows *from*. The arrows point where it blows *to* (from + 180°),
 * which is what a reader looking at a fire needs: the side smoke and spread would go.
 *
 * Every time shown comes from the body, never from the fetch — `valid_at` is the hour the
 * arrows are *for*, `run_at` the model run. A revalidated (304) copy therefore cannot make
 * an old forecast look new.
 *
 * Speed colours avoid the red–orange band fire owns (CI-14): a sequential teal → blue →
 * indigo → violet ramp, light to dark, so the strongest wind is the darkest arrow.
 */

/** The wire shape, as the route and the fixture spell it. */
export interface WindOverlayBody {
  readonly schema_version: 1;
  readonly provider: 'ecmwf-open-data';
  readonly model: 'ifs';
  readonly run_at: string;
  readonly step_hours: number;
  readonly valid_at: string;
  readonly available_at: string;
  readonly grid: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
    readonly resolution_deg: number;
    readonly cols: number;
    readonly rows: number;
    readonly order: 'north_to_south_west_to_east';
  };
  readonly speed_ms: readonly number[];
  readonly direction_from_deg: readonly number[];
  readonly wind_overlay_version: string;
}

/**
 * Speed classes, m/s, lowest first. `upper` is the exclusive ceiling; `null` for the open
 * top class. The bands follow Beaufort roughly (light air, light/gentle breeze, moderate,
 * fresh, strong and above), coarse on purpose: a 0.5° model grid cannot say more.
 */
export const WIND_SPEED_CLASSES = [
  { upper: 2, color: '#8fd3c8' },
  { upper: 5, color: '#3fa7b5' },
  { upper: 8, color: '#2f76b8' },
  { upper: 11, color: '#3b4a9e' },
  { upper: null, color: '#5b2c8f' },
] as const;

export type WindSpeedClass = 0 | 1 | 2 | 3 | 4;

export function windSpeedClass(speedMs: number): WindSpeedClass {
  for (let index = 0; index < WIND_SPEED_CLASSES.length - 1; index += 1) {
    const upper = WIND_SPEED_CLASSES[index]?.upper;
    if (upper !== null && upper !== undefined && speedMs < upper) return index as WindSpeedClass;
  }
  return 4;
}

/** The direction an arrow points: where the wind blows *to*, 0–359, clockwise from north. */
export function arrowBearingDeg(directionFromDeg: number): number {
  return (((directionFromDeg + 180) % 360) + 360) % 360;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/u;

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The body, or `null` when it is not one this build can draw honestly: wrong schema,
 * unreadable times, or arrays that do not fill the grid. Never throws.
 */
export function parseWindOverlay(value: unknown): WindOverlayBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body['schema_version'] !== 1) return null;
  if (body['provider'] !== 'ecmwf-open-data' || body['model'] !== 'ifs') return null;
  if (!isInstant(body['run_at']) || !isInstant(body['valid_at'])) return null;
  if (!isInstant(body['available_at'])) return null;
  if (!isFiniteNumber(body['step_hours']) || typeof body['wind_overlay_version'] !== 'string') {
    return null;
  }
  const grid = body['grid'];
  if (typeof grid !== 'object' || grid === null) return null;
  const g = grid as Record<string, unknown>;
  const numeric = ['west', 'south', 'east', 'north', 'resolution_deg', 'cols', 'rows'] as const;
  if (!numeric.every((key) => isFiniteNumber(g[key]))) return null;
  const cols = g['cols'] as number;
  const rows = g['rows'] as number;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
  if ((g['resolution_deg'] as number) <= 0 || g['order'] !== 'north_to_south_west_to_east') {
    return null;
  }
  const speed = body['speed_ms'];
  const direction = body['direction_from_deg'];
  if (!Array.isArray(speed) || !Array.isArray(direction)) return null;
  if (speed.length !== cols * rows || direction.length !== cols * rows) return null;
  if (!speed.every((entry) => isFiniteNumber(entry) && entry >= 0)) return null;
  if (!direction.every((entry) => isFiniteNumber(entry) && entry >= 0 && entry < 360)) {
    return null;
  }
  return value as WindOverlayBody;
}

/** One arrow's properties on the map's GeoJSON point. */
export interface WindArrowProperties {
  /** Where the arrow points, degrees clockwise from north (`icon-rotate`). */
  readonly bearing: number;
  readonly speed: number;
  readonly speedClass: WindSpeedClass;
}

export interface WindArrowFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
  readonly properties: WindArrowProperties;
}

export interface WindArrowCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly WindArrowFeature[];
}

/** Every grid point as an arrow, row-major from the north-west corner. */
export function windArrows(body: WindOverlayBody): WindArrowCollection {
  const { west, north, resolution_deg: step, cols, rows } = body.grid;
  const features: WindArrowFeature[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const speed = body.speed_ms[index] ?? 0;
      const from = body.direction_from_deg[index] ?? 0;
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          // Rounded to the grid's own precision: the float sum drifts in the 13th digit.
          coordinates: [round6(west + col * step), round6(north - row * step)],
        },
        properties: { bearing: arrowBearingDeg(from), speed, speedClass: windSpeedClass(speed) },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
