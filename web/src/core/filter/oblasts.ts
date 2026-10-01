/**
 * The 28 oblasts (ISO 3166-2:BG) for the region filter: their names, and point-in-oblast
 * over the lazy-loaded Natural Earth polygons (`web/src/assets/geodata/oblasts.json`,
 * built by `infra/geodata`).
 *
 * Names live here rather than in the asset: Natural Earth's `name_local` is inconsistent
 * (mixed scripts, "Sofia" twice), and the two Sofias need the disambiguation readers use.
 * They are place names, not voice, so they sit beside the ISO table instead of the
 * message catalogs; the two Sofia labels are the only composed ones.
 *
 * The number (1–28) is the ISO suffix and is wire-stable — it is the `r=` URL member.
 */

import type { Locale } from '../types.js';

export const OBLAST_COUNT = 28;

const NAMES: readonly (readonly [bg: string, en: string])[] = [
  ['Благоевград', 'Blagoevgrad'],
  ['Бургас', 'Burgas'],
  ['Варна', 'Varna'],
  ['Велико Търново', 'Veliko Tarnovo'],
  ['Видин', 'Vidin'],
  ['Враца', 'Vratsa'],
  ['Габрово', 'Gabrovo'],
  ['Добрич', 'Dobrich'],
  ['Кърджали', 'Kardzhali'],
  ['Кюстендил', 'Kyustendil'],
  ['Ловеч', 'Lovech'],
  ['Монтана', 'Montana'],
  ['Пазарджик', 'Pazardzhik'],
  ['Перник', 'Pernik'],
  ['Плевен', 'Pleven'],
  ['Пловдив', 'Plovdiv'],
  ['Разград', 'Razgrad'],
  ['Русе', 'Ruse'],
  ['Силистра', 'Silistra'],
  ['Сливен', 'Sliven'],
  ['Смолян', 'Smolyan'],
  ['София (столица)', 'Sofia City'],
  ['София (област)', 'Sofia Province'],
  ['Стара Загора', 'Stara Zagora'],
  ['Търговище', 'Targovishte'],
  ['Хасково', 'Haskovo'],
  ['Шумен', 'Shumen'],
  ['Ямбол', 'Yambol'],
];

export function isOblastNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= OBLAST_COUNT;
}

export function oblastIso(n: number): string {
  return `BG-${String(n).padStart(2, '0')}`;
}

export function oblastName(n: number, locale: Locale): string {
  const names = NAMES[n - 1];
  if (names === undefined) throw new RangeError(`not an oblast number: ${n}`);
  return locale === 'bg' ? names[0] : names[1];
}

/** All 28, sorted by name in the reader's language — the order of the region picker. */
export function oblastsByName(locale: Locale): readonly { number: number; name: string }[] {
  return NAMES.map((_, i) => ({ number: i + 1, name: oblastName(i + 1, locale) })).sort((a, b) =>
    a.name.localeCompare(b.name, locale),
  );
}

export function parseOblast(raw: string | null | undefined): number | null {
  if (raw == null || !/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return isOblastNumber(n) ? n : null;
}

// ---------------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------------

/** `{v, source, scale, regions: [iso, flatRings[]][]}`, rings delta-coded at `scale`. */
export interface RegionsAsset {
  readonly v: 1;
  readonly source: string;
  readonly scale: number;
  readonly regions: readonly (readonly [string, readonly (readonly number[])[]])[];
}

export function isRegionsAsset(value: unknown): value is RegionsAsset {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['v'] === 1 && typeof v['scale'] === 'number' && Array.isArray(v['regions']);
}

type Ring = readonly (readonly [number, number])[];

interface IndexedOblast {
  readonly number: number;
  readonly outer: Ring;
  readonly holes: readonly Ring[];
  readonly minLon: number;
  readonly maxLon: number;
  readonly minLat: number;
  readonly maxLat: number;
}

export interface OblastIndex {
  /** The ISO numbers the asset actually carries, ascending. */
  readonly numbers: readonly number[];
  /**
   * The oblast containing the point, or the nearest one within `toleranceKm` of its
   * boundary (the 1:10M generalisation cuts corners, and a fire on a border river must
   * not vanish from both sides), else `null` — outside Bulgaria.
   */
  readonly regionAt: (lon: number, lat: number) => number | null;
}

/** Same tolerance the build uses to file settlements. */
export const BOUNDARY_TOLERANCE_KM = 2;

function decodeRing(flat: readonly number[], scale: number): Ring {
  const ring: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    x += flat[i] as number;
    y += flat[i + 1] as number;
    ring.push([x / scale, y / scale]);
  }
  return ring;
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as readonly [number, number];
    const [xj, yj] = ring[j] as readonly [number, number];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToRingSq(lon: number, lat: number, ring: Ring): number {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j] as readonly [number, number];
    const [x2, y2] = ring[i] as readonly [number, number];
    const ax = (x1 - lon) * k;
    const ay = y1 - lat;
    const dx = (x2 - lon) * k - ax;
    const dy = y2 - lat - ay;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
    const px = ax + t * dx;
    const py = ay + t * dy;
    best = Math.min(best, px * px + py * py);
  }
  return best;
}

export function createOblastIndex(
  asset: RegionsAsset,
  toleranceKm = BOUNDARY_TOLERANCE_KM,
): OblastIndex {
  const toleranceDeg = toleranceKm / 111.2;
  const oblasts: IndexedOblast[] = [];
  for (const [iso, flatRings] of asset.regions) {
    const number = parseOblast(/^BG-(\d{2})$/.exec(iso)?.[1]);
    if (number === null) continue;
    const [outer, ...holes] = flatRings.map((flat) => decodeRing(flat, asset.scale));
    if (outer === undefined || outer.length < 3) continue;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const [lon, lat] of outer) {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    oblasts.push({ number, outer, holes, minLon, maxLon, minLat, maxLat });
  }
  oblasts.sort((a, b) => a.number - b.number);
  const cache = new Map<string, number | null>();

  return {
    numbers: oblasts.map((o) => o.number),
    regionAt(lon, lat) {
      // Events do not move; the same point is asked about on every filter change.
      const key = `${lon},${lat}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      let nearest: number | null = null;
      let nearestSq = toleranceDeg * toleranceDeg;
      let found: number | null = null;
      for (const o of oblasts) {
        const inBox = lon >= o.minLon && lon <= o.maxLon && lat >= o.minLat && lat <= o.maxLat;
        if (
          inBox &&
          pointInRing(lon, lat, o.outer) &&
          !o.holes.some((hole) => pointInRing(lon, lat, hole))
        ) {
          found = o.number;
          break;
        }
        // Only oblasts whose box is within the tolerance can be the nearest boundary.
        const pad = toleranceDeg * 1.5;
        if (
          lon >= o.minLon - pad &&
          lon <= o.maxLon + pad &&
          lat >= o.minLat - pad &&
          lat <= o.maxLat + pad
        ) {
          const d = distanceToRingSq(lon, lat, o.outer);
          if (d <= nearestSq) {
            nearestSq = d;
            nearest = o.number;
          }
        }
      }
      const result = found ?? nearest;
      if (cache.size > 10_000) cache.clear();
      cache.set(key, result);
      return result;
    },
  };
}
