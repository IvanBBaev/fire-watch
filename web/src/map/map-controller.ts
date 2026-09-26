/**
 * The MapLibre controller — the only module that talks to a live `maplibregl.Map`.
 *
 * It subscribes to the store DIRECTLY (ADR-005 D4): a 1,000-event `setData()` never
 * pays VDOM costs, and updates flow store → throttle (1/s, frame-aligned) → source.
 * Everything with logic worth testing (hash, GeoJSON building, throttling, the layer
 * registry) lives in sibling pure modules; this file is the thin imperative shell that
 * wires them to the map instance, so it carries no unit tests of its own.
 */

import { AttributionControl, Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
// MapLibre 6 locates its worker as `new URL('./maplibre-gl-worker.mjs', import.meta.url)`,
// a sibling of its own module that in turn imports `./maplibre-gl-shared.mjs`. Once Vite
// bundles maplibre into a hashed chunk neither sibling exists in `dist`, the worker 404s
// and no tile or GeoJSON is ever parsed — the map never reaches `idle`. `?worker&url`
// has Vite build the worker as its own self-contained bundle (shared code inlined) and
// hands back its hashed URL. Imported here, on the lazy map path, so the worker URL
// never lands in the entry chunk.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import { boundsContain } from '../core/geo/viewport.js';
import type { MapCamera, MapViewport } from '../core/geo/viewport.js';
import { isWithinCutoff } from '../core/time/age-filter.js';
import type {
  Detection,
  FireEvent,
  MapController,
  MapControllerDeps,
  ThemeName,
} from '../core/types.js';
import type {
  DetectionCellsCollection,
  DetectionGroup,
  DetectionsCollection,
  FireEventsCollection,
} from './geojson.js';
import {
  buildDetectionCellsCollection,
  buildDetectionsCollection,
  buildFireEventsCollection,
  parseDetectionsGeoJson,
} from './geojson.js';
import { formatMapHash, parseMapHash } from './hash.js';
import { applyImageryLayer } from './imagery-layer.js';
import {
  FIRE_DETECTIONS_SOURCE_ID,
  FIRE_DETECTION_CELLS_SOURCE_ID,
  FIRE_DOT_LAYER_ID,
  FIRE_EVENTS_SOURCE_ID,
  FOOTPRINT_MIN_ZOOM,
  INTERACTIVE_FIRE_LAYER_IDS,
  applyFireImages,
  applyFireLayers,
  preserveFireStyle,
} from './layer-registry.js';
import { buildMapReadyProbe, mapReadyProbeEnabled } from './map-ready-probe.js';
import type { MapReadyProbe } from './map-ready-probe.js';
import { resolveBasemapStyle } from './outdoor-style.js';
import type { FrameScheduler } from './throttle.js';
import { createFrameThrottle } from './throttle.js';

/** Zoom for "take me to this event" — inside the detection band, terrain readable. */
const FLY_TO_EVENT_ZOOM = 11.5;

/**
 * How many events may have their detections in flight/resident at once.
 *
 * Detections used to load only for the *selected* event, which is why an old fire showed
 * nothing but its dot: nobody had selected it. Loading them for everything in the frame is
 * what puts the points back on those fires — but "everything in the frame" at a wide zoom
 * is unbounded, so the frame is served nearest-centre-first up to this cap. Sixteen is
 * roughly what fits on screen at {@link FOOTPRINT_MIN_ZOOM} before the cells overlap into
 * illegibility anyway.
 */
const MAX_DETECTION_EVENTS = 16;

/** Resident detection sets, oldest-first so the cache can shed its tail. */
const DETECTION_CACHE_LIMIT = 64;

const rafScheduler: FrameScheduler = {
  schedule: (callback) => requestAnimationFrame(() => callback()),
  cancel: (handle) => cancelAnimationFrame(handle as number),
};

type SourceData = FireEventsCollection | DetectionsCollection | DetectionCellsCollection;

// Module scope: set once when the lazy chunk evaluates, before any Map spins up workers.
setWorkerUrl(maplibreWorkerUrl);

export function createMapController(deps: MapControllerDeps): MapController {
  // The fragment wins over whatever the shell proposes; garbage in it loses silently.
  const initialView = parseMapHash(location.hash) ?? deps.initialView;

  const map = new MapLibreMap({
    container: deps.container,
    style: resolveBasemapStyle(deps.theme, deps.styleUrls, deps.outdoorBasemap),
    center: [initialView.lon, initialView.lat],
    zoom: initialView.zoom,
    attributionControl: false,
  });

  // The corner line arrives pre-rendered from the frozen registry via the shell —
  // never retyped or substituted here (ADR-001 A1.4).
  map.addControl(
    new AttributionControl({ compact: true, customAttribution: deps.attributionLine }),
  );

  let selectedId: string | null = null;
  let snapshotMarked = false;
  /** Whether a non-empty snapshot has been handed to a live fire-events source. */
  let fireDataOnMap = false;
  /** The fire-events collection last handed to the source; read only by the map-ready probe. */
  let lastFireEvents: FireEventsCollection | null = null;
  /**
   * Detections by public event id. An entry means "we asked": an empty array is a cached
   * *answer* — the event has no detections file — not a hole to retry. Without that the
   * demo's fixture-less events would be refetched on every settled frame forever.
   */
  const detectionsByEvent = new Map<string, readonly Detection[]>();
  const detectionsInFlight = new Set<string>();
  // The event the user last tapped *on the map*. Flying to a fire the user just pointed at
  // yanks the frame out from under them; flying to one picked from the list or a permalink
  // is the whole point. Same call, different intent — only the click knows which.
  let lastClickedId: string | null = null;
  // The reader's time window as an absolute instant. Null until the shell sets one, so a
  // map that renders before the first tick shows everything rather than nothing.
  let ageCutoff: number | null = null;
  // The imagery raster the shell asked for (ADR-001 A2.3); null is the basemap alone.
  let imageryTilesUrl: string | null = null;

  const setSourceData = (sourceId: string, data: SourceData): void => {
    const source = map.getSource<GeoJSONSource>(sourceId);
    if (source !== undefined) void source.setData(data);
  };

  /**
   * Latched the first time the map cannot say where it is looking.
   *
   * MapLibre needs a WebGL2 context to *exist*. Denied one it reports the refusal and
   * returns from its constructor early, leaving a map with no style and a projection that
   * was never set up; every camera read then throws from inside the library — and this
   * controller reads the camera on every store push, so one refused context became one
   * uncaught error per second. That browser is not one the product gives up on: the list,
   * the filters, the age window and the detail page are peer surfaces to the map, not
   * decoration around it, and none of them need a camera.
   *
   * Nothing is hidden by latching it. MapLibre fires an `error` event for the refused
   * context, and this file deliberately registers no `map.on('error')` handler, so the
   * library's own console report stays the one loud place a map fault is announced —
   * a handler here would narrow that to whatever this controller thought to re-report and
   * turn every future fault (a style host that 404s, a sprite that will not decode) into
   * silence. What the latch buys is that the *consequence* is dealt with once rather than
   * sixty times a minute.
   */
  let frameUnavailable = false;

  /** The current frame, or null when there is no projection to measure one with. */
  const readViewport = (): MapViewport | null => {
    if (frameUnavailable) return null;
    try {
      const bounds = map.getBounds();
      const center = map.getCenter();
      return {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
        zoom: map.getZoom(),
        lat: center.lat,
        lon: center.lng,
      };
    } catch {
      // Narrow by construction rather than by sniffing the error: the only statements under
      // this `try` are three MapLibre getters over the transform, and a transform that
      // cannot be read is the failure described above. The degrade goes on the same
      // performance timeline as the rest of boot, so "the map never arrived" is a mark next
      // to when the snapshot landed instead of something inferred from a missing
      // 'fw:map-idle'.
      frameUnavailable = true;
      performance.mark('fw:map-unavailable');
      return null;
    }
  };

  /** Whether the map can still be told where to look. Probes — and latches — through the read. */
  const hasFrame = (): boolean => readViewport() !== null;

  /**
   * Feature state is style state, and MapLibre throws outright when the style is not done
   * loading: that is every moment before the basemap answers, and every moment of a session
   * where it never does — a blocked style host, or a map that never got far enough to ask.
   * The tell is the one {@link setSourceData} already uses, because our source is added by
   * the `style.load` handler below and exists only once the style is loaded. A skipped call
   * is a deferred one rather than a lost one: that same handler re-applies the selection
   * when a style does arrive, and when none ever does there is no dot to highlight.
   */
  const setEventSelected = (publicId: string, selected: boolean): void => {
    if (map.getSource(FIRE_EVENTS_SOURCE_ID) === undefined) return;
    const feature = { source: FIRE_EVENTS_SOURCE_ID, id: publicId };
    if (selected) map.setFeatureState(feature, { selected: true });
    else map.removeFeatureState(feature, 'selected');
  };

  /**
   * The events the detection layers may draw: the same set the event layer draws, narrowed
   * to the current frame and ordered nearest-centre-first. Same cutoff and same `keepId`,
   * so the cells of an event the reader filtered out can never outlive its dot.
   */
  const eventsInFrame = (viewport: MapViewport): readonly FireEvent[] => {
    const visible: { readonly event: FireEvent; readonly distance: number }[] = [];
    for (const event of deps.store.state().events.values()) {
      if (event.status === 'archived') continue;
      if (event.id !== selectedId && !isWithinCutoff(event, ageCutoff)) continue;
      if (!boundsContain(viewport, event.lon, event.lat)) continue;
      const dLon = event.lon - viewport.lon;
      const dLat = event.lat - viewport.lat;
      visible.push({ event, distance: dLon * dLon + dLat * dLat });
    }
    visible.sort((a, b) => a.distance - b.distance);
    const chosen = visible.slice(0, MAX_DETECTION_EVENTS).map((entry) => entry.event);
    // The selected event is what the reader is reading; it is in whether or not the frame
    // ranked it, and whether or not it is even on screen.
    if (selectedId !== null && !chosen.some((event) => event.id === selectedId)) {
      for (const event of deps.store.state().events.values()) {
        if (event.id === selectedId) {
          chosen.push(event);
          break;
        }
      }
    }
    return chosen;
  };

  /** Push whatever detections are already cached for the events currently in frame. */
  const pushDetections = (): void => {
    const viewport = readViewport();
    // Detections are frame-scoped, so with no frame there is nothing to scope them to.
    // Leaving the sources untouched rather than clearing them matters: an empty collection
    // is a claim — "this frame holds none" — about a frame nobody managed to measure.
    if (viewport === null) return;
    const groups: DetectionGroup[] = [];
    for (const event of eventsInFrame(viewport)) {
      const detections = detectionsByEvent.get(event.id);
      if (detections === undefined || detections.length === 0) continue;
      groups.push({
        eventId: event.id,
        status: event.status,
        scoreBucket: event.scoreBucket,
        detections,
      });
    }
    setSourceData(FIRE_DETECTIONS_SOURCE_ID, buildDetectionsCollection(groups));
    setSourceData(FIRE_DETECTION_CELLS_SOURCE_ID, buildDetectionCellsCollection(groups));
  };

  const rememberDetections = (publicId: string, detections: readonly Detection[]): void => {
    detectionsByEvent.set(publicId, detections);
    // Map iterates in insertion order, so the first key is the least recently fetched.
    while (detectionsByEvent.size > DETECTION_CACHE_LIMIT) {
      const oldest = detectionsByEvent.keys().next();
      if (oldest.done === true) break;
      detectionsByEvent.delete(oldest.value);
    }
  };

  const fetchDetections = async (publicId: string): Promise<void> => {
    const template = deps.detectionsUrlTemplate;
    if (template === null) return;
    detectionsInFlight.add(publicId);
    try {
      const response = await fetch(template.replace('{id}', encodeURIComponent(publicId)));
      // A missing file is an answer, not a failure: most events have no detection detail.
      rememberDetections(
        publicId,
        response.ok ? parseDetectionsGeoJson(await (response.json() as Promise<unknown>)) : [],
      );
    } catch {
      // A transport failure is not an answer — leave the id uncached so the next settled
      // frame retries it. Detection detail is an inspection aid, never on the critical path.
    } finally {
      detectionsInFlight.delete(publicId);
    }
    pushDetections();
  };

  /**
   * Fetch what the frame needs and nothing else. Cheap enough to run on every push: it is a
   * bounded scan plus two set lookups, and every id it resolves is fetched at most once.
   */
  const syncDetections = (): void => {
    if (deps.detectionsUrlTemplate === null) return;
    // The zoom comes off the same read as the frame, so a map that cannot be measured is
    // one decision here, not two: no frame, nothing to fetch for.
    const viewport = readViewport();
    if (viewport === null) return;
    // Below the footprint band nothing detection-shaped is drawn, so fetching would spend
    // the reader's bandwidth on pixels they cannot see.
    if (viewport.zoom < FOOTPRINT_MIN_ZOOM) return;
    for (const event of eventsInFrame(viewport)) {
      if (detectionsByEvent.has(event.id) || detectionsInFlight.has(event.id)) continue;
      void fetchDetections(event.id);
    }
  };

  const pushFireEvents = (): void => {
    const state = deps.store.state();
    // The event collection is not frame-scoped — it is the held set, narrowed by the age
    // window and by the selection — so it is pushed whether or not a frame can be read.
    lastFireEvents = buildFireEventsCollection(state, { cutoffMs: ageCutoff, keepId: selectedId });
    setSourceData(FIRE_EVENTS_SOURCE_ID, lastFireEvents);
    pushDetections();
    syncDetections();
    if (!snapshotMarked && state.events.size > 0) {
      snapshotMarked = true;
      performance.mark('fw:snapshot-applied');
    }
    // Only a push that reached a live source can be painted; before `style.load` the call
    // above was a no-op and the next idle frame would be a basemap without fires.
    if (state.events.size > 0 && map.getSource(FIRE_EVENTS_SOURCE_ID) !== undefined) {
      fireDataOnMap = true;
    }
  };

  const throttle = createFrameThrottle({
    clock: { monotonicNow: () => performance.now() },
    scheduler: rafScheduler,
    callback: pushFireEvents,
  });

  const unsubscribe = deps.store.subscribe(() => {
    throttle.request();
  });
  // The store may already hold a snapshot by the time the lazy map chunk arrives.
  throttle.request();

  const reapplySelectedFeatureState = (): void => {
    if (selectedId !== null) setEventSelected(selectedId, true);
  };

  // Fires on the initial style and after every setStyle — including error recovery
  // paths that rebuild the style. applyFireLayers is idempotent by contract, the data
  // push bypasses the throttle (style swaps are rare user gestures, not data churn),
  // and feature-state is re-applied because a style rebuild clears it.
  map.on('style.load', () => {
    // Images first: a fill-pattern naming an unregistered image paints nothing.
    applyFireImages(map);
    applyFireLayers(map);
    pushFireEvents();
    reapplySelectedFeatureState();
    // A style swap drops the imagery raster; put it back if the shell still wants it.
    applyImageryLayer(map, imageryTilesUrl);
  });

  map.once('idle', () => {
    performance.mark('fw:map-idle');
  });

  /**
   * Evidence that the frame being marked ready has fires in it (`map-ready-probe.ts`). Runs
   * only when a harness opted in, in the same idle frame the mark describes: the fire
   * events the pushed collection places inside the viewport against the distinct ids
   * MapLibre's rendered-feature index holds for `fire-dot`. A layer the style dropped is
   * reported as absent rather than queried, which would only log an error.
   */
  const probeMapReady = (): MapReadyProbe => {
    const fireDotLayerPresent = map.getLayer(FIRE_DOT_LAYER_ID) !== undefined;
    const bounds = map.getBounds();
    const visibleIds = (lastFireEvents?.features ?? [])
      .filter((feature) => bounds.contains(feature.geometry.coordinates))
      .map((feature) => feature.id);
    const renderedIds = fireDotLayerPresent
      ? map
          .queryRenderedFeatures({ layers: [FIRE_DOT_LAYER_ID] })
          .map((feature) => String(feature.id ?? feature.properties['id']))
      : [];
    return buildMapReadyProbe({ fireDotLayerPresent, visibleIds, renderedIds });
  };

  // Map-ready, the metric of CI-12's timing half (08 §5.5.2 "basemap tiles + fire layer
  // painted"): the first idle frame — style loaded, every requested tile in, no transition
  // running — rendered after a non-empty snapshot reached the fire source. `idle` waits for
  // the GeoJSON worker too, so this frame has the fires in it. `fw:map-idle` alone can come
  // before the snapshot does, and `fw:snapshot-applied` before the style does.
  const markMapReady = (): void => {
    if (!fireDataOnMap) return;
    map.off('idle', markMapReady);
    performance.mark('fw:map-ready', { detail: mapReadyProbeEnabled() ? probeMapReady() : null });
  };
  map.on('idle', markMapReady);

  // Before 'load' the map has no real size, so its bounds are meaningless; the first
  // honest frame is this one, and the list waits for it rather than guessing. The detection
  // layers wait for it too — until now every frame test they ran was against a guess.
  map.on('load', () => {
    const viewport = readViewport();
    // No frame means the shell's viewport signal stays null — exactly the state it holds
    // before the first honest frame, where the list shows everything rather than nothing.
    // A fabricated one would be worse than none: it would scope the list to a box the
    // reader is not looking at, on the one machine that cannot see the map to correct it.
    if (viewport !== null) deps.onViewportChange(viewport);
    throttle.request();
  });

  // Viewport → fragment only; the route path and search stay untouched. `moveend` is the
  // settled-frame event, so the list re-sorts once per gesture rather than once per frame.
  map.on('moveend', () => {
    const viewport = readViewport();
    // Same rule as 'load': no frame, no fragment and no viewport handed on. A map that
    // cannot be measured also cannot be panned, so in practice this arm never runs.
    if (viewport !== null) {
      history.replaceState(history.state, '', formatMapHash(viewport));
      deps.onViewportChange(viewport);
    }
    // A pan changes which events are in frame, which changes which detections to hold and
    // to ask for. Through the throttle so a flick across the country is one pass, not ten.
    throttle.request();
  });

  // Both the dot and the hatched cells select their event, and a tap that lands on the
  // overlap delivers one click event per layer. Deduping on the underlying DOM event keeps
  // that a single selection instead of a double route push.
  let lastHandledClick: unknown = null;
  const handleFireClick = (event: MapLayerMouseEvent): void => {
    if (event.originalEvent === lastHandledClick) return;
    const feature = event.features?.[0];
    if (feature === undefined) return;
    // Every interactive fire layer carries the public id in `properties.id`; on
    // `fire-events` it is also the promoted feature id (spike B6), but the cells are their
    // own source with their own ids, so the property is the one uniform answer.
    // `properties` is an index signature of `any` in the MapLibre types; narrowing through
    // `unknown` keeps the check below the only thing that decides this is a public id.
    const publicId: unknown = feature.properties?.['id'];
    if (typeof publicId === 'string') {
      lastHandledClick = event.originalEvent;
      lastClickedId = publicId;
      deps.onSelectEvent(publicId);
    }
  };
  for (const layerId of INTERACTIVE_FIRE_LAYER_IDS) {
    map.on('click', layerId, handleFireClick);
    map.on('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });
  }

  return {
    setTheme(theme: ThemeName): void {
      // transformStyle carries our sources/layers across the swap atomically; the
      // following 'style.load' re-runs the idempotent registry (review 08 §5.3.5).
      map.setStyle(resolveBasemapStyle(theme, deps.styleUrls, deps.outdoorBasemap), {
        transformStyle: preserveFireStyle,
      });
    },

    setSelected(publicId: string | null): void {
      if (selectedId === publicId) return;
      if (selectedId !== null) setEventSelected(selectedId, false);
      selectedId = publicId;
      // No source reset and no fetch here: detections belong to the *frame*, not to the
      // selection (that is what puts points on old fires nobody selected). Selection only
      // widens the frame — `eventsInFrame` always includes it — so the push below covers it.
      // The new selection may also be older than the current window; re-pushing redraws it.
      throttle.request();
      if (publicId !== null) setEventSelected(publicId, true);
    },

    flyToEvent(publicId: string): void {
      // The user already has this fire under their finger — leave their frame alone.
      if (publicId === lastClickedId) {
        lastClickedId = null;
        return;
      }
      // A map that cannot say where it is looking cannot be told where to look: MapLibre's
      // flight path starts by projecting a screen point through the same absent transform.
      // Dropping the flight is the whole cost — the selection, the list and the detail page
      // are unaffected.
      if (!hasFrame()) return;
      for (const event of deps.store.state().events.values()) {
        if (event.id === publicId) {
          map.flyTo({ center: [event.lon, event.lat], zoom: FLY_TO_EVENT_ZOOM });
          return;
        }
      }
      // Unknown id: no-op — the shell owns "event not found" UX, the map holds still.
    },

    flyTo(camera: MapCamera): void {
      if (!hasFrame()) return;
      map.flyTo({ center: [camera.lon, camera.lat], zoom: camera.zoom });
    },

    setAgeCutoff(cutoffMs: number | null): void {
      if (cutoffMs === ageCutoff) return;
      ageCutoff = cutoffMs;
      // Through the throttle, not straight to the source: the cutoff moves with every
      // clock tick, and coalescing it with store updates keeps it to one setData a second.
      throttle.request();
    },

    setImagery(tilesUrl: string | null): void {
      if (tilesUrl === imageryTilesUrl) return;
      imageryTilesUrl = tilesUrl;
      // `isStyleLoaded()` is no guard here — it is also false while tiles are in flight, which
      // would swallow a toggle for no reason. MapLibre throws only while a style itself is
      // still loading, and the 'style.load' handler above applies the wanted state then.
      try {
        applyImageryLayer(map, imageryTilesUrl);
      } catch {
        // Style not loaded yet: 'style.load' will apply `imageryTilesUrl`.
      }
    },

    destroy(): void {
      unsubscribe();
      throttle.dispose();
      map.remove();
    },
  };
}
