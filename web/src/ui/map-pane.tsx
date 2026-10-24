/**
 * The map pane: mounts a container div and lazy-loads the map chunk on mount
 * (ADR-005 D3 budget — maplibre never rides the entry chunk). The list is the peer
 * surface: a failed or slow map load leaves the pane empty and everything else usable.
 *
 * It is mounted by the shell, not by a route, so the instance survives navigation between
 * the list and an event permalink. Everything route-shaped therefore arrives as a prop
 * (`selectedId`) instead of being read here — one map, many routes.
 */

import { effect } from '@preact/signals';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { useLocation } from 'preact-iso';

import type { MapCamera } from '../core/geo/viewport.js';
import { scopePredicate } from '../core/filter/event-filter.js';
import { ageCutoffMs } from '../core/time/age-filter.js';
import type { EffisOverlayDraw, MapController } from '../core/types.js';
import { mapCornerAttribution } from './logic/credits.js';
import { eventPath } from './logic/event-resolution.js';
import { ageWindow } from './age-window.js';
import { cameraRequest } from './camera-request.js';
import { useApp } from './context.js';
import { MapControls } from './map-controls.js';
import { measureOverlay } from './measure-state.js';
import { initialCamera, publishViewport } from './map-camera.js';
import {
  regionFilter,
  regionIndex,
  sensitivityFilter,
  sourceFamily,
  startFilterUrlSync,
} from './filters.js';
import { imageryTilesUrl } from './imagery.js';
import {
  browserOverlayLoader,
  effisCreditText,
  effisOverlayPayload,
  OVERLAY_URLS,
  windOverlayPayload,
  startOverlaySync,
} from './layers.js';
import { startOverlayRevalidation } from './overlay-refresh.js';
import { useLightningDraw } from './lightning.js';
import { useSwathDraw } from './pass-swaths.js';
import { staticSourcesDraw } from './static-sources.js';
import { appliedTheme } from './theme.js';
import { startOverlayUrlSync } from './url-state.js';
import { useNow } from './use-now.js';

export function MapPane({ selectedId }: { readonly selectedId: string | null }) {
  const { store, clock, config, messages, serverNow } = useApp();
  const { route } = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<MapController | null>(null);
  // route() identity may change per render; the controller callback lives long.
  const routeRef = useRef(route);
  routeRef.current = route;
  // A camera chosen (by geolocation) before the chunk finished loading. Applied as the
  // opening frame rather than animated to, so nobody watches the map fly away from a
  // default view they never asked to see.
  const pendingCameraRef = useRef<MapCamera | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // The same instant the list is scoped by, so a fire cannot be on one surface and off the
  // other. It advances with the clock tick; the controller coalesces the churn.
  const cutoffMs = ageCutoffMs(useNow(serverNow), ageWindow.value);
  const cutoffRef = useRef(cutoffMs);
  cutoffRef.current = cutoffMs;
  // The source, region and sensitivity filters scope the map exactly as they scope the list. Read here
  // so a change re-renders the pane; the predicate is rebuilt only when an input moves.
  const family = sourceFamily.value;
  const oblast = regionFilter.value;
  const sensitivity = sensitivityFilter.value;
  const index = regionIndex.value;
  const predicate = useMemo(
    () => scopePredicate({ family, oblast, sensitivity }, index?.regionAt ?? null),
    [family, oblast, sensitivity, index],
  );
  const predicateRef = useRef(predicate);
  predicateRef.current = predicate;
  // The EFFIS overlays as the controller takes them: the chosen copies plus the registry's
  // credit, which rides on the burnt-area source into the map corner (TASKS G4).
  const effisDraw = (): EffisOverlayDraw => ({
    ...effisOverlayPayload.value,
    attribution: effisCreditText(clock, messages),
  });
  const effisDrawRef = useRef(effisDraw);
  effisDrawRef.current = effisDraw;
  // The F15 swaths, re-decided recent/next once a minute against the server clock.
  const swathDraw = useSwathDraw();
  const swathDrawRef = useRef(swathDraw);
  swathDrawRef.current = swathDraw;
  // The F18 lightning flashes, re-classed by age once a minute against the server clock.
  const lightningDraw = useLightningDraw();
  const lightningDrawRef = useRef(lightningDraw);
  lightningDrawRef.current = lightningDraw;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    let disposed = false;
    // Dynamic import only — this is the lazy chunk (ADR-005 D3).
    //
    // The rejection handler is `then`'s second argument rather than a trailing `.catch`,
    // and that placement is the whole point: a handler passed to `then` sees only the
    // *import* rejecting, never an error thrown by the fulfilment handler beside it. A
    // trailing `.catch` used to cover both, so every fault in map setup — a controller
    // constructor that threw, a selection applied to a style that was not loaded — was
    // swallowed here and left no trace anywhere. Only one of the two is expected: a chunk
    // that will not arrive is an offline or blocked reader, and the list carries the
    // product for them. Setup throwing is a bug, and now it escapes as an unhandled
    // rejection instead of being filed as a slow network.
    void import('../map/index.js').then(
      ({ createMapController }) => {
        if (disposed) {
          return;
        }
        const controller = createMapController({
          container,
          store,
          theme: appliedTheme.peek(),
          styleUrls: config.basemapStyleUrl,
          outdoorBasemap: config.outdoorBasemap ?? null,
          detectionsUrlTemplate: config.detectionsUrlTemplate,
          attributionLine: mapCornerAttribution(clock, messages),
          initialView: pendingCameraRef.current ?? initialCamera(),
          onSelectEvent: (publicId) => {
            routeRef.current(eventPath(publicId));
          },
          onViewportChange: publishViewport,
        });
        controllerRef.current = controller;
        pendingCameraRef.current = null;
        controller.setAgeCutoff(cutoffRef.current);
        controller.setEventFilter(predicateRef.current);
        controller.setImagery(imageryTilesUrl.peek());
        controller.setEffisOverlays(effisDrawRef.current());
        controller.setWindOverlay(windOverlayPayload.peek());
        controller.setStaticSources(staticSourcesDraw.peek());
        controller.setPassSwaths(swathDrawRef.current);
        controller.setLightning(lightningDrawRef.current);
        controller.setMeasure(measureOverlay.peek());
        // The route may already name an event — a permalink opened cold.
        const selected = selectedIdRef.current;
        if (selected !== null) {
          controller.setSelected(selected);
          controller.flyToEvent(selected);
        }
      },
      () => {
        // The chunk is unavailable (offline, blocked, a bad deploy). Marked, not logged:
        // this is the same fact the controller records when it is handed a browser that
        // refuses it a context — no map on this page — so the boot timeline carries it
        // once under one name whatever the cause, and the cause itself stays in the
        // console entry the failed request already wrote. The two are mutually exclusive:
        // there is no controller to latch if the chunk never loaded.
        performance.mark('fw:map-unavailable');
      },
    );
    return () => {
      disposed = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [store, config]);

  // Selection follows the URL: a tap, a list row and a pasted permalink all arrive here.
  // The controller decides whether to move — a fire the user just tapped stays put.
  useEffect(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    controller.setSelected(selectedId);
    if (selectedId !== null) controller.flyToEvent(selectedId);
  }, [selectedId]);

  // The window moved, or the clock ticked past a whole minute of it.
  useEffect(() => {
    controllerRef.current?.setAgeCutoff(cutoffMs);
  }, [cutoffMs]);

  useEffect(() => {
    controllerRef.current?.setEventFilter(predicate);
  }, [predicate]);

  // Filters live in the URL fragment beside the camera (`t=`, `src=`, `r=`): the pane is
  // mounted once by the shell, so it owns the sync for the page's lifetime.
  useEffect(() => startFilterUrlSync(), []);
  // The overlay choice rides beside them (`ov=`), with the same boot and storage rules.
  useEffect(() => startOverlayUrlSync(), []);

  // Theme changes reach the controller straight from the signal — no re-render needed.
  useEffect(
    () =>
      effect(() => {
        const theme = appliedTheme.value;
        controllerRef.current?.setTheme(theme);
      }),
    [],
  );

  // Imagery follows its signal the same way: a toggle, or the server withdrawing the handles
  // on the next client-config fetch, which drops the layer back to the basemap (A2.3).
  useEffect(
    () =>
      effect(() => {
        const tilesUrl = imageryTilesUrl.value;
        controllerRef.current?.setImagery(tilesUrl);
      }),
    [],
  );

  // The overlays follow their signals the same way. The pane is mounted once, so it also
  // owns fetching the chosen copies from the proxy for the page's lifetime.
  useEffect(
    () =>
      effect(() => {
        const draw = effisDrawRef.current();
        controllerRef.current?.setEffisOverlays(draw);
      }),
    [],
  );
  useEffect(
    () =>
      effect(() => {
        const wind = windOverlayPayload.value;
        controllerRef.current?.setWindOverlay(wind);
      }),
    [],
  );
  useEffect(
    () =>
      effect(() => {
        const mask = staticSourcesDraw.value;
        controllerRef.current?.setStaticSources(mask);
      }),
    [],
  );
  useEffect(() => {
    controllerRef.current?.setPassSwaths(swathDraw);
  }, [swathDraw]);
  useEffect(() => {
    controllerRef.current?.setLightning(lightningDraw);
  }, [lightningDraw]);
  // V2-D3: the measure drawing, and where a map tap goes while the tool is open.
  useEffect(
    () =>
      effect(() => {
        const overlay = measureOverlay.value;
        controllerRef.current?.setMeasure(overlay);
      }),
    [],
  );
  // The fixtures build reads wind, swaths and lightning from committed files; live reads the API's routes.
  const overlayUrls = {
    wind: config.windOverlayUrl ?? OVERLAY_URLS.wind,
    swaths: config.passSwathsUrl ?? OVERLAY_URLS.swaths,
    lightning: config.lightningOverlayUrl ?? OVERLAY_URLS.lightning,
  };
  useEffect(() => startOverlaySync(browserOverlayLoader(clock, overlayUrls)), []);
  // A daily copy (FWI) is asked for again once its day is over by the server's clock.
  useEffect(
    () =>
      startOverlayRevalidation({
        serverNow,
        loader: browserOverlayLoader(clock, overlayUrls),
        setTimeout: (callback, ms) => window.setTimeout(callback, ms),
        clearTimeout: (handle) => {
          window.clearTimeout(handle as number);
        },
      }),
    [],
  );

  const moveCamera = (camera: MapCamera): void => {
    const controller = controllerRef.current;
    if (controller === null) pendingCameraRef.current = camera;
    else controller.flyTo(camera);
  };
  const moveCameraRef = useRef(moveCamera);
  moveCameraRef.current = moveCamera;

  // A place chosen in search, from wherever the search box is mounted.
  useEffect(
    () =>
      effect(() => {
        const request = cameraRequest.value;
        if (request !== null) moveCameraRef.current(request.camera);
      }),
    [],
  );

  return (
    <>
      <div class="map-pane" ref={containerRef} aria-label={messages.nav.map} />
      <MapControls onMove={moveCamera} />
    </>
  );
}
