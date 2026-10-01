/**
 * Settlement search over the lazy-loaded GeoNames gazetteer
 * (`web/src/assets/geodata/settlements.json`, built by `infra/geodata`).
 *
 * Pure: the asset arrives already parsed; nothing here fetches. Matching is on folded
 * keys (`foldName`), so Cyrillic, Streamlined Latin and the older romanisations all meet;
 * GeoNames' own Latin spelling is searched too when the build kept it as an alias.
 */

import { foldName, transliterate } from './transliterate.js';

/** `[name, latE3, lonE3, oblast (ISO number, 0 = none), rank, latinAlias?]`. */
export type GazetteerRow = readonly [string, number, number, number, number, string?];

export interface GazetteerAsset {
  readonly v: 1;
  readonly source: string;
  readonly scale: number;
  readonly places: readonly GazetteerRow[];
}

export interface Place {
  /** Bulgarian name (Cyrillic). */
  readonly name: string;
  /** Latin display name: GeoNames' spelling when it differs, else Streamlined. */
  readonly latin: string;
  readonly lat: number;
  readonly lon: number;
  /** ISO 3166-2:BG number (1–28), or `null` when the point falls in no oblast. */
  readonly oblast: number | null;
  /** 0 capital, 1 oblast seat, 2 municipal seat, 3 town, 4 village. */
  readonly rank: number;
}

interface IndexedPlace {
  readonly place: Place;
  readonly keys: readonly string[];
}

export interface Gazetteer {
  readonly size: number;
  search(query: string, limit?: number): readonly Place[];
}

/** Shorter queries match half the country; the box asks for one more letter instead. */
export const MIN_QUERY_LENGTH = 2;

/** Loose validation: a malformed asset is a build bug, and search must not crash the app. */
export function isGazetteerAsset(value: unknown): value is GazetteerAsset {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['v'] === 1 && typeof v['scale'] === 'number' && Array.isArray(v['places']);
}

export function createGazetteer(asset: GazetteerAsset): Gazetteer {
  const index: IndexedPlace[] = [];
  for (const row of asset.places) {
    const [name, lat, lon, oblast, rank, alias] = row;
    const place: Place = {
      name,
      latin: alias ?? transliterate(name),
      lat: lat / asset.scale,
      lon: lon / asset.scale,
      oblast: oblast === 0 ? null : oblast,
      rank,
    };
    const keys = alias === undefined ? [foldName(name)] : [foldName(name), foldName(alias)];
    index.push({ place, keys });
  }

  return {
    size: index.length,
    search(query, limit = 8) {
      const q = foldName(query);
      if (q.length < MIN_QUERY_LENGTH) return [];
      const scored: { place: Place; score: number }[] = [];
      for (const { place, keys } of index) {
        let best = Infinity;
        for (const key of keys) best = Math.min(best, matchScore(key, q));
        if (best !== Infinity) scored.push({ place, score: best });
      }
      scored.sort(
        (a, b) =>
          a.score - b.score ||
          a.place.rank - b.place.rank ||
          a.place.name.length - b.place.name.length ||
          a.place.name.localeCompare(b.place.name, 'bg'),
      );
      return scored.slice(0, limit).map(({ place }) => place);
    },
  };
}

/** 0 exact, 1 prefix, 2 start of a later word, 3 anywhere (3+ letters only), else ∞. */
function matchScore(key: string, q: string): number {
  if (key === q) return 0;
  if (key.startsWith(q)) return 1;
  if (key.includes(` ${q}`)) return 2;
  if (q.length >= 3 && key.includes(q)) return 3;
  return Infinity;
}

/**
 * Zoom for flying to a place: a village needs a closer look than the capital. At these
 * levels the settlement fills a phone screen without the fire dots around it vanishing
 * off the edges.
 */
export function zoomForPlace(place: Place): number {
  if (place.rank === 0) return 11;
  if (place.rank <= 2) return 12;
  return 13;
}

/** Zoom for flying to typed coordinates — about a village's width. */
export const COORDINATE_ZOOM = 12;
