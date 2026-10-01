/**
 * The F18 lightning context layer, the pure half: what `/overlays/lightning/recent.json`
 * (or the committed fixture) is, how it is validated, and which flashes the map draws at a
 * given moment, in which age class.
 *
 * The body is the server's merge of the last six hours of EUMETSAT MTG Lightning Imager
 * flash products (LI-2-LFL), clipped to the polling box
 * (`server/src/adapters/http/lightning-overlay-route.ts`). Every time shown comes from the
 * body — `covered_through` is the end of the newest 10-minute product merged, the honest
 * "as of" — never from the fetch, so a revalidated copy cannot make old flashes look new.
 *
 * ## Age is decided here, against the reader's clock
 *
 * A flash's class is its age at `nowMs` (the server-corrected clock), not at
 * `covered_through`: a copy the pipeline stopped feeding must age on screen, not keep its
 * newest flashes yellow. Flashes older than {@link LIGHTNING_MAX_AGE_MS} are not drawn.
 *
 * ## Context, never a cause
 *
 * A flash near a fire says a storm was there; it does not say the storm lit the fire. The
 * Lightning Imager's geolocation is ~4.5 km and it does not separate cloud-to-ground from
 * intra-cloud flashes. Nothing here links a flash to a fire.
 *
 * Colours avoid the red–orange band fire owns (CI-14): yellow for the newest, white for the
 * last hour, blue for the rest, each with a dark ring so white reads on a light basemap.
 */

/** One flash as served: the instant of its first optical event and where it was seen. */
export interface LightningFlash {
  readonly t: string;
  readonly lat: number;
  readonly lon: number;
}

export interface LightningAttribution {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly href?: string;
}

/** The wire shape, as the route and the fixture spell it. */
export interface LightningOverlayBody {
  readonly schema_version: 1;
  readonly source: 'eumetsat:mtg-li:lfl';
  readonly covered_from: string;
  readonly covered_through: string;
  readonly available_at: string;
  readonly products: number;
  readonly retention_hours: number;
  readonly flashes: readonly LightningFlash[];
  readonly attribution: readonly LightningAttribution[];
}

const MINUTE_MS = 60_000;

/** Mirrors the server's retention: the layer reaches back six hours. */
export const LIGHTNING_MAX_AGE_MS = 6 * 60 * MINUTE_MS;

/**
 * Age classes, newest first. `upperMs` is the exclusive ceiling. Here, not in `map/`,
 * because the Layers panel legend paints the same swatches without loading the map chunk.
 */
export const LIGHTNING_AGE_CLASSES = [
  { upperMs: 15 * MINUTE_MS, color: '#facc15' },
  { upperMs: 60 * MINUTE_MS, color: '#f8fafc' },
  { upperMs: LIGHTNING_MAX_AGE_MS, color: '#60a5fa' },
] as const;

/** The ring every flash carries, so the white class reads on the light basemap. */
export const LIGHTNING_RING_COLOR = '#1e293b';

export type LightningAgeClass = 0 | 1 | 2;

/**
 * The class of a flash `ageMs` old, or `null` when it is too old to draw. A flash stamped
 * slightly ahead of the clock (skew between the satellite, the server and the reader) is
 * the newest class, not dropped.
 */
export function lightningAgeClass(ageMs: number): LightningAgeClass | null {
  for (let index = 0; index < LIGHTNING_AGE_CLASSES.length; index += 1) {
    const upper = LIGHTNING_AGE_CLASSES[index]?.upperMs;
    if (upper !== undefined && ageMs < upper) return index as LightningAgeClass;
  }
  return null;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/u;

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFlash(value: unknown): value is LightningFlash {
  if (typeof value !== 'object' || value === null) return false;
  const flash = value as Record<string, unknown>;
  const lat = flash['lat'];
  const lon = flash['lon'];
  return (
    isInstant(flash['t']) &&
    isFiniteNumber(lat) &&
    isFiniteNumber(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

function isAttribution(value: unknown): value is LightningAttribution {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['source'] === 'string' &&
    typeof entry['text'] === 'string' &&
    (entry['href'] === undefined || typeof entry['href'] === 'string')
  );
}

/**
 * The body, or `null` when it is not one this build can draw honestly: wrong schema or
 * source, unreadable times, a window that runs backwards, or a malformed flash. Never
 * throws.
 */
export function parseLightningOverlay(value: unknown): LightningOverlayBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body['schema_version'] !== 1 || body['source'] !== 'eumetsat:mtg-li:lfl') return null;
  const from = body['covered_from'];
  const through = body['covered_through'];
  if (!isInstant(from) || !isInstant(through) || !isInstant(body['available_at'])) return null;
  if (Date.parse(from) > Date.parse(through)) return null;
  const products = body['products'];
  const retention = body['retention_hours'];
  if (!isFiniteNumber(products) || !Number.isInteger(products) || products < 0) return null;
  if (!isFiniteNumber(retention) || retention <= 0) return null;
  const flashes = body['flashes'];
  const attribution = body['attribution'];
  if (!Array.isArray(flashes) || !flashes.every(isFlash)) return null;
  if (!Array.isArray(attribution) || !attribution.every(isAttribution)) return null;
  return value as LightningOverlayBody;
}

export interface LightningFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
  readonly properties: { readonly ageClass: LightningAgeClass };
}

export interface LightningCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly LightningFeature[];
}

/** What the map and the panel show for one body at one moment. */
export interface LightningDisplay {
  /** Oldest class first, so the newest flashes are painted on top. */
  readonly collection: LightningCollection;
  /** Flashes drawn per age class, newest class first. */
  readonly counts: readonly [number, number, number];
  /** The end of the newest product merged — the honest "as of". */
  readonly coveredThrough: string;
}

/** The flashes young enough to draw at `nowMs`, classed by age. Pure. */
export function lightningForDisplay(body: LightningOverlayBody, nowMs: number): LightningDisplay {
  const byClass: [LightningFeature[], LightningFeature[], LightningFeature[]] = [[], [], []];
  for (const flash of body.flashes) {
    const ageClass = lightningAgeClass(nowMs - Date.parse(flash.t));
    if (ageClass === null) continue;
    byClass[ageClass].push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [flash.lon, flash.lat] },
      properties: { ageClass },
    });
  }
  return {
    collection: {
      type: 'FeatureCollection',
      features: [...byClass[2], ...byClass[1], ...byClass[0]],
    },
    counts: [byClass[0].length, byClass[1].length, byClass[2].length],
    coveredThrough: body.covered_through,
  };
}

/** What the map controller takes: the features plus the credit for the source. */
export interface LightningDraw {
  readonly collection: LightningCollection;
  /** The EUMETSAT credit, rendered from the contracts registry (`eumetsat-meteosat`). */
  readonly attribution: string;
}
