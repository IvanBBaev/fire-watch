/**
 * Scoping a list to what the camera shows.
 *
 * The list is a peer surface to the map (07-product-ux P10), so it must answer the
 * question the map raises: "what is in front of me right now?" — nearest first. What it
 * must never do is silently shrink: the count of everything it left outside the frame is
 * returned alongside, because a list that quietly drops rows on zoom reads as "the fire
 * went away".
 *
 * Generic over anything positioned, so it stays free of `FireEvent` and testable on
 * plain points.
 */

import type { MapViewport } from './viewport.js';
import { boundsContain } from './viewport.js';

export interface Positioned {
  readonly lon: number;
  readonly lat: number;
}

export interface ViewportPartition<T> {
  /** Inside the frame, nearest to the camera centre first. */
  readonly inView: readonly T[];
  /** How many the frame leaves out — the number the "N outside the view" row shows. */
  readonly outsideCount: number;
}

/** Degrees of longitude shrink toward the poles; without this, sorting skews east-west. */
function squaredDistanceDegrees(from: MapViewport, item: Positioned): number {
  const lonScale = Math.cos((from.lat * Math.PI) / 180);
  const dLon = (item.lon - from.lon) * lonScale;
  const dLat = item.lat - from.lat;
  return dLon * dLon + dLat * dLat;
}

/**
 * Split by the frame and order the survivors by distance from its centre. Ties keep the
 * caller's order (`Array.prototype.sort` is stable), so an already recency-sorted input
 * stays recency-sorted among equidistant rows.
 */
export function partitionByViewport<T extends Positioned>(
  items: readonly T[],
  viewport: MapViewport,
): ViewportPartition<T> {
  const inView = items.filter((item) => boundsContain(viewport, item.lon, item.lat));
  const sorted = [...inView].sort(
    (left, right) =>
      squaredDistanceDegrees(viewport, left) - squaredDistanceDegrees(viewport, right),
  );
  return { inView: sorted, outsideCount: items.length - inView.length };
}
