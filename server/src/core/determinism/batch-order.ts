/**
 * Fixed batch ordering (ADR-002 D7 — reprocessing and replay discipline).
 *
 * The incremental clustering algorithm is order-dependent: which detection is seen
 * first decides which cluster absorbs a borderline neighbour, and therefore which
 * FireEvent keeps its `public_id` after a merge. A database returning rows in physical
 * order, or two sources arriving in a different interleaving on a replay, would produce
 * a different — equally valid, but different — event graph. So the order is defined
 * here once, is total, and is derived only from fields that are frozen at ingest.
 *
 * The key is `(available_at, source, lat, lon)`, with `detection_uid` as the final
 * tiebreak so that no two distinct detections can ever compare equal.
 */

export interface OrderableDetection {
  /** When *we* could first have seen the row, not when the satellite observed it. */
  readonly availableAt: number;
  readonly source: string;
  /** The canonical 5 dp decimal strings — compared as text, never as floats. */
  readonly latCanonical: string;
  readonly lonCanonical: string;
  readonly detectionUid: string;
}

/**
 * Compares by code unit rather than by locale. `Intl`-aware comparison is
 * locale-dependent and would make the sort order a property of the host's ICU build.
 */
function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareDetections(a: OrderableDetection, b: OrderableDetection): number {
  if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;

  const bySource = compareAscii(a.source, b.source);
  if (bySource !== 0) return bySource;

  // Coordinates sort as canonical decimal text, so the order cannot drift with float
  // formatting. Text order differs from numeric order for negatives, which does not
  // matter: the requirement is a total order that is identical on every replay.
  const byLat = compareAscii(a.latCanonical, b.latCanonical);
  if (byLat !== 0) return byLat;

  const byLon = compareAscii(a.lonCanonical, b.lonCanonical);
  if (byLon !== 0) return byLon;

  return compareAscii(a.detectionUid, b.detectionUid);
}

/**
 * Returns a new array in canonical order. Non-mutating on purpose: the caller's array
 * is often the raw parse of a source file that provenance still refers to.
 */
export function orderBatch<T extends OrderableDetection>(detections: readonly T[]): T[] {
  return [...detections].sort(compareDetections);
}

/**
 * Asserts that the order is total over this batch — no two rows compare equal. A tie
 * would mean two distinct detections share a `detection_uid`, which is an identity bug
 * upstream, not a sorting problem; failing loudly here is how it gets noticed before it
 * reaches the archive.
 */
export function assertTotalOrder(ordered: readonly OrderableDetection[]): void {
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (previous && current && compareDetections(previous, current) === 0) {
      throw new Error(
        `batch ordering is not total: duplicate key at index ${String(i)} ` +
          `(detection_uid ${current.detectionUid})`,
      );
    }
  }
}
