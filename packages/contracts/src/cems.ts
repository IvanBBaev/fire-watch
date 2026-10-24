/**
 * Copernicus EMS Rapid Mapping activations (TASKS V2-E3; DATA-SOURCES §V2-E3): the overlay
 * document the server publishes, its parser, the activation's citation, and the one rule
 * that decides whether an activation is about a given event.
 *
 * ## Why it lives in contracts
 *
 * The server writes the document and the web reads it; both must agree on its shape to the
 * field. The matching rule is the web's today, but it is a product claim ("the EU's mapping
 * service was activated for this fire"), so it is versioned here beside the document rather
 * than buried in a component — one implementation, one set of thresholds, both visible.
 *
 * ## What an activation carries
 *
 * Only what the badge and the rule need: the code, the name, three instants, the countries,
 * the centroid and each area of interest reduced to its bounding box (rounded outward to
 * 1e-4°, so a box never shrinks). The AOI polygons, the delineation products and the
 * images are Copernicus's to serve; the badge links to the activation page for those.
 *
 * `aois_status` says how far the AOIs can be trusted: `public` — the detail was read and
 * these are its AOIs (possibly none yet); `restricted` — the activation is sensitive and its
 * detail is for registered users only (Regulation (EU) 2021/696 art. 53), so only the list
 * entry's centroid is known; `unavailable` — the detail could not be read this time.
 *
 * ## Distances
 *
 * No trigonometry, for the reason `static-sources.ts` gives: the local plane of
 * {@link STATIC_SOURCE_METRIC}, evaluated at the event's latitude. Over the few kilometres
 * this rule reaches, that is far inside the precision of a VIIRS pixel.
 */

import { STATIC_SOURCE_METRIC, type LocalPlaneMetric } from './static-sources.js';

export const CEMS_OVERLAY_SCHEMA_VERSION = 1;

/** An activation code as Copernicus prints it. Anything else is not served. */
export const CEMS_CODE_RE = /^EMSR\d{3,4}$/;

/** The public activation page the badge links to. */
export const CEMS_ACTIVATION_PAGE_BASE = 'https://mapping.emergency.copernicus.eu/activations/';

/** Where the citation pattern below is published. */
export const CEMS_CITATION_GUIDELINES_URL =
  'https://mapping.emergency.copernicus.eu/about/citation-guidelines/';

/** `[west, south, east, north]` in degrees. */
export type CemsBox = readonly [number, number, number, number];

export const CEMS_AOI_STATUSES = ['public', 'restricted', 'unavailable'] as const;
export type CemsAoiStatus = (typeof CEMS_AOI_STATUSES)[number];

export interface CemsActivation {
  readonly code: string;
  readonly name: string;
  /** When the event began, per Copernicus; explicit UTC. */
  readonly event_time: string;
  readonly activation_time: string;
  readonly last_update: string;
  readonly closed: boolean;
  readonly countries: readonly string[];
  /** `[lon, lat]`. */
  readonly centroid: readonly [number, number];
  readonly aois: readonly CemsBox[];
  readonly aois_status: CemsAoiStatus;
}

/** One rendered credit, the shape every overlay route serves (`SnapshotAttribution`). */
export interface CemsOverlayAttribution {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly href?: string;
}

export interface CemsOverlayBody {
  readonly schema_version: typeof CEMS_OVERLAY_SCHEMA_VERSION;
  /** When the server last read the activation list. */
  readonly available_at: string;
  readonly activations: readonly CemsActivation[];
  /** Added by the route from the credit registry; absent in the stored document. */
  readonly attribution?: readonly CemsOverlayAttribution[];
}

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function isCemsInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Accepts the stored or the served document; `null` for anything else, never a throw. */
export function parseCemsOverlay(value: unknown): CemsOverlayBody | null {
  if (!isRecord(value)) return null;
  if (value['schema_version'] !== CEMS_OVERLAY_SCHEMA_VERSION) return null;
  if (!isCemsInstant(value['available_at'])) return null;
  const list = value['activations'];
  if (!Array.isArray(list)) return null;
  const activations: CemsActivation[] = [];
  for (const entry of list) {
    const activation = parseActivation(entry);
    if (activation === null) return null;
    activations.push(activation);
  }
  const attribution = parseAttribution(value['attribution']);
  if (attribution === null) return null;
  return {
    schema_version: CEMS_OVERLAY_SCHEMA_VERSION,
    available_at: value['available_at'],
    activations,
    ...(attribution === undefined ? {} : { attribution }),
  };
}

function parseAttribution(value: unknown): CemsOverlayAttribution[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const out: CemsOverlayAttribution[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const { id, source, text, href } = entry;
    if (typeof id !== 'string' || typeof source !== 'string' || typeof text !== 'string') {
      return null;
    }
    if (href !== undefined && typeof href !== 'string') return null;
    out.push({ id, source, text, ...(href === undefined ? {} : { href }) });
  }
  return out;
}

function parseActivation(value: unknown): CemsActivation | null {
  if (!isRecord(value)) return null;
  const { code, name, event_time, activation_time, last_update, closed, countries } = value;
  if (typeof code !== 'string' || !CEMS_CODE_RE.test(code)) return null;
  if (typeof name !== 'string') return null;
  if (!isCemsInstant(event_time) || !isCemsInstant(activation_time)) return null;
  if (!isCemsInstant(last_update)) return null;
  if (typeof closed !== 'boolean') return null;
  if (!Array.isArray(countries) || !countries.every((c) => typeof c === 'string')) return null;
  const centroid = value['centroid'];
  if (
    !Array.isArray(centroid) ||
    centroid.length !== 2 ||
    !isLon(centroid[0]) ||
    !isLat(centroid[1])
  ) {
    return null;
  }
  const status = value['aois_status'];
  if (!CEMS_AOI_STATUSES.includes(status as CemsAoiStatus)) return null;
  const rawAois = value['aois'];
  if (!Array.isArray(rawAois)) return null;
  const aois: CemsBox[] = [];
  for (const box of rawAois) {
    if (!isBox(box)) return null;
    aois.push([box[0], box[1], box[2], box[3]]);
  }
  return {
    code,
    name,
    event_time,
    activation_time,
    last_update,
    closed,
    countries: countries,
    centroid: [centroid[0], centroid[1]],
    aois,
    aois_status: status as CemsAoiStatus,
  };
}

function isBox(value: unknown): value is CemsBox {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    isLon(value[0]) &&
    isLat(value[1]) &&
    isLon(value[2]) &&
    isLat(value[3]) &&
    value[0] <= value[2] &&
    value[1] <= value[3]
  );
}

function isLon(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function isLat(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The public page of one activation. */
export function cemsActivationUrl(code: string): string {
  return `${CEMS_ACTIVATION_PAGE_BASE}${encodeURIComponent(code)}/`;
}

/**
 * The activation-level citation the Copernicus EMS citation guidelines ask for, verbatim in
 * form: "Copernicus Emergency Management Service (© 2025 European Union), EMSR822". The year
 * is the activation's.
 */
export function cemsActivationCitation(code: string, activationTime: string): string {
  return `Copernicus Emergency Management Service (© ${activationTime.slice(0, 4)} European Union), ${code}`;
}

/**
 * When an activation is "about" an event (V2-E3). A founder rule, versioned:
 *
 *   * **Where.** The event's point lies inside one of the activation's AOI boxes grown by
 *     `aoiMarginKm` on every side — an AOI is drawn around the burnt area, and the event's
 *     point is a centroid of detections that can sit just outside it. With no AOI known
 *     (restricted, unreadable, or not drawn yet) the activation's centroid within
 *     `centroidRadiusKm` stands in; it is coarser, so it is tighter.
 *   * **When.** The event's observed span overlaps `[event_time − leadDays,
 *     event_time + trailDays]`: Copernicus's event time is when the fire was reported, which
 *     can trail the first satellite detection by a day or two, and an activation keeps
 *     mapping a large fire for about two weeks.
 */
export const CEMS_MATCH = Object.freeze({
  version: 'cems_match_v1',
  aoiMarginKm: 5,
  centroidRadiusKm: 15,
  leadDays: 3,
  trailDays: 14,
});

export interface CemsMatchRules {
  readonly aoiMarginKm: number;
  readonly centroidRadiusKm: number;
  readonly leadDays: number;
  readonly trailDays: number;
}

export interface CemsMatchEvent {
  readonly lon: number;
  readonly lat: number;
  /** Explicit UTC ISO. */
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

const DAY_MS = 86_400_000;

/** The activations that are about `event`, in their input order. */
export function matchCemsActivations(
  event: CemsMatchEvent,
  activations: readonly CemsActivation[],
  rules: CemsMatchRules = CEMS_MATCH,
  metric: LocalPlaneMetric = STATIC_SOURCE_METRIC,
): CemsActivation[] {
  const first = Date.parse(event.firstObservedAt);
  const last = Date.parse(event.lastObservedAt);
  if (Number.isNaN(first) || Number.isNaN(last)) return [];
  const kmPerLat = metric.kmPerDegreeLat;
  const kmPerLon =
    metric.kmPerDegreeLonAtReference +
    metric.kmPerDegreeLonPerDegreeLat * (event.lat - metric.referenceLatDeg);
  return activations.filter((activation) => {
    const at = Date.parse(activation.event_time);
    if (Number.isNaN(at)) return false;
    if (last < at - rules.leadDays * DAY_MS || first > at + rules.trailDays * DAY_MS) return false;
    if (activation.aois.length > 0) {
      const dLat = rules.aoiMarginKm / kmPerLat;
      const dLon = rules.aoiMarginKm / kmPerLon;
      return activation.aois.some(
        ([west, south, east, north]) =>
          event.lon >= west - dLon &&
          event.lon <= east + dLon &&
          event.lat >= south - dLat &&
          event.lat <= north + dLat,
      );
    }
    const dx = (event.lon - activation.centroid[0]) * kmPerLon;
    const dy = (event.lat - activation.centroid[1]) * kmPerLat;
    return dx * dx + dy * dy <= rules.centroidRadiusKm * rules.centroidRadiusKm;
  });
}
