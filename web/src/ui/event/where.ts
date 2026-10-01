/**
 * Where the event is, stated at the precision the data supports.
 *
 * The event position is the centroid of satellite pixels hundreds of metres to kilometres
 * wide — "the centroid is not a pin" (GLOSSARY §5.2). Two decimals of a degree (about 1 km)
 * is already finer than a geostationary pixel, so nothing finer is shown or copied, and the
 * only map link is an area view without a marker. No directions, routing or navigation
 * links, ever (§5.2 "No routing, ever").
 */

export interface ApproximateCentre {
  /** Decimal degrees, two places, dot separator — pasteable into any map search box. */
  readonly lat: string;
  readonly lon: string;
}

export function approximateCentre(lon: number, lat: number): ApproximateCentre {
  return { lat: lat.toFixed(2), lon: lon.toFixed(2) };
}

/** The clipboard form: "lat, lon", the order map search boxes expect. */
export function coordinatesText(centre: ApproximateCentre): string {
  return `${centre.lat}, ${centre.lon}`;
}

/** Area-level zoom: a few kilometres across, enough to see the terrain, too coarse for a pin. */
export const AREA_VIEW_ZOOM = 12;

/** An OpenStreetMap view of the area — `#map=` only, never `mlat`/`mlon` (which drop a marker). */
export function openStreetMapAreaUrl(centre: ApproximateCentre): string {
  return `https://www.openstreetmap.org/#map=${String(AREA_VIEW_ZOOM)}/${centre.lat}/${centre.lon}`;
}
