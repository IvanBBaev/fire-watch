/**
 * The map-ready probe: what CI-12's timing gate needs to know about the frame it times.
 *
 * `fw:map-ready` claims "basemap tiles in and the fire layer painted" (08 §5.5.2). The
 * controller can only *infer* the second half — it handed a non-empty snapshot to a live
 * source and MapLibre then went idle. A fire layer MapLibre rejected, or one that paints
 * nothing, satisfies both conditions and would let the gate time an empty map and pass.
 * So a harness that opts in gets the evidence attached to the mark itself, measured in the
 * same frame: how many fire events the pushed collection puts inside the viewport, and
 * how many distinct ones MapLibre's rendered-feature index holds for the `fire-dot` layer.
 *
 * Opt-in and inert: the controller reads {@link MAP_READY_PROBE_KEY} off `globalThis` at
 * the mark and does nothing extra unless it is exactly `true`. No production page sets it,
 * so a reader's browser never runs the rendered-feature query and the mark carries no
 * detail. The key is a name no app code could collide with, like the e2e harness's own.
 */

/** Set to `true` on `globalThis` before the app loads to have `fw:map-ready` carry a probe. */
export const MAP_READY_PROBE_KEY = '__fireWatchE2eMapReadyProbe';

/** The `detail` of the `fw:map-ready` mark when the probe is on. */
export interface MapReadyProbe {
  /** Whether the style holds the `fire-dot` layer at all (MapLibre drops invalid layers). */
  readonly fireDotLayerPresent: boolean;
  /** Distinct fire events of the pushed collection whose point lies inside the viewport. */
  readonly visibleFireEvents: number;
  /** Distinct fire events MapLibre reports as rendered in the `fire-dot` layer. */
  readonly renderedFireDots: number;
  /** Viewport ids missing from the rendered set — capped, for the failure message. */
  readonly missing: readonly string[];
}

const MISSING_REPORT_CAP = 10;

/** Whether the page opted in. Only a literal `true` counts. */
export function mapReadyProbeEnabled(scope: object = globalThis): boolean {
  return (scope as Record<string, unknown>)[MAP_READY_PROBE_KEY] === true;
}

/**
 * The probe, from the ids the viewport should show and the ids MapLibre rendered.
 * Duplicates are expected in `renderedIds` — a point near a tile edge is indexed in each
 * tile that buffers it — so both sides are compared as sets.
 */
export function buildMapReadyProbe(input: {
  readonly fireDotLayerPresent: boolean;
  readonly visibleIds: Iterable<string>;
  readonly renderedIds: Iterable<string>;
}): MapReadyProbe {
  const visible = new Set(input.visibleIds);
  const rendered = new Set(input.renderedIds);
  const missing: string[] = [];
  for (const id of visible) {
    if (!rendered.has(id)) missing.push(id);
    if (missing.length >= MISSING_REPORT_CAP) break;
  }
  return {
    fireDotLayerPresent: input.fireDotLayerPresent,
    visibleFireEvents: visible.size,
    renderedFireDots: rendered.size,
    missing,
  };
}

/** Structural guard for a probe read back out of the page (untyped JSON). */
export function isMapReadyProbe(value: unknown): value is MapReadyProbe {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['fireDotLayerPresent'] === 'boolean' &&
    typeof record['visibleFireEvents'] === 'number' &&
    typeof record['renderedFireDots'] === 'number' &&
    Array.isArray(record['missing'])
  );
}

/**
 * The gate's verdict on one probe: `null` when the fire layer demonstrably painted every
 * event the viewport should show (and there was at least one), else why not.
 */
export function mapReadyProbeDefect(probe: MapReadyProbe): string | null {
  if (!probe.fireDotLayerPresent) return 'the fire-dot layer is not in the style';
  if (probe.visibleFireEvents === 0) return 'no fire event of the snapshot is inside the viewport';
  if (probe.renderedFireDots < probe.visibleFireEvents || probe.missing.length > 0) {
    return (
      `fire-dot rendered ${probe.renderedFireDots} of ${probe.visibleFireEvents} in-view ` +
      `events (missing: ${probe.missing.join(', ') || 'n/a'})`
    );
  }
  return null;
}
