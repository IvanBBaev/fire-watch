/**
 * The measure panel (V2-D3): distance along a line, the area of an outline, and the
 * distance from a picked place to the nearest active fire. Loaded lazily by the map
 * controls the first time a reader opens it, so neither the panel nor its maths
 * (`core/geo/measure.ts`) costs the entry chunk anything.
 *
 * Every action has a button, so the tool works without a pointer: "add the map centre"
 * places a point where the map's crosshair would be — pan with the keyboard, then add —
 * and Undo and Clear take points back. A tap or click on the map adds a point too (the map
 * pane routes it here while the panel is open), which is the quick path on a phone.
 *
 * The nearest-fire question asks only the fires the reader can see: active events that
 * pass the same time window and filters as the list and the map. A fire hidden by a filter
 * is not "the nearest fire" to someone who chose to hide it, and the panel says what it
 * searched when it finds none.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';

import {
  addMeasurePoint,
  lengthForDisplay,
  measureCollection,
  measureResult,
  MEASURE_MODES,
  pointsForMode,
  undoMeasurePoint,
  type LonLat,
  type MeasureMode,
  type MeasureResult,
  type NearestCandidate,
} from '../core/geo/measure.js';
import { formatNumber } from '../core/i18n/format.js';
import type { Messages } from '../core/i18n/messages.js';
import type { Locale, MeasureOverlay } from '../core/types.js';
import { useApp } from './context.js';

export interface MeasureCandidate extends NearestCandidate {
  readonly place: string;
}

/** "460 m", "1.2 km", "131 km" in the reader's locale. */
export function lengthText(meters: number, messages: Messages, locale: Locale): string {
  const { unit, value } = lengthForDisplay(meters);
  const text = formatNumber(value, locale);
  return unit === 'km' ? messages.eventDetail.kilometres(text) : messages.eventDetail.metres(text);
}

/** The sentence the result line reads. */
export function resultText(
  result: MeasureResult,
  places: ReadonlyMap<string, string>,
  messages: Messages,
  locale: Locale,
): string {
  switch (result.kind) {
    case 'needPoints':
      return messages.measure.hint[result.mode];
    case 'distance':
      return messages.measure.distanceResult(lengthText(result.meters, messages, locale));
    case 'area':
      return messages.measure.areaResult(
        messages.areaBothUnits(result.hectares),
        lengthText(result.perimeterMeters, messages, locale),
      );
    case 'nearest':
      return messages.measure.nearestResult(
        lengthText(result.meters, messages, locale),
        places.get(result.target.id) ?? '',
      );
    case 'nearestNone':
      return messages.measure.nearestNone;
  }
}

const NO_CANDIDATES: readonly MeasureCandidate[] = [];

/**
 * What the panel needs of the app's state comes in through its props, from
 * `measure-control.tsx` in the entry chunk. Of the app's own modules the panel imports only
 * the measure maths, the number formatter and the app context — the same shared set the
 * other lazy pages import — so loading it splits no module out of the entry chunk (CI-12).
 */
export interface MeasurePanelProps {
  readonly id: string;
  readonly open: boolean;
  /** The map's centre, or `null` while there is no frame. */
  readonly centre: LonLat | null;
  /** Active events that pass the reader's window and filters, with their place names. */
  readonly candidates: readonly MeasureCandidate[];
  /** Hands the map its drawing and its tap handler; `null` takes them away. */
  readonly onDrawing: (overlay: MeasureOverlay | null) => void;
}

export function MeasurePanel({
  id: panelId,
  open,
  centre,
  candidates: visibleActive,
  onDrawing,
}: MeasurePanelProps) {
  const { messages, locale } = useApp();
  const [mode, setMode] = useState<MeasureMode>('distance');
  const [points, setPoints] = useState<readonly LonLat[]>([]);
  const candidates = mode === 'nearest' ? visibleActive : NO_CANDIDATES;

  const result = measureResult(mode, points, candidates);
  const places = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.id, candidate.place])),
    [candidates],
  );

  // The drawing follows the points; a tap on the map comes back here through `onPick`.
  useEffect(() => {
    if (!open) return;
    onDrawing({
      collection: measureCollection(mode, points, result),
      onPick: (point) => {
        setPoints((current) => addMeasurePoint(mode, current, point));
      },
    });
  }, [open, mode, points, result.kind === 'nearest' ? result.target.id : null]);
  useEffect(
    () => () => {
      onDrawing(null);
    },
    [],
  );

  const groupName = `${panelId}-mode`;
  return (
    <section
      id={panelId}
      class="measure-panel"
      aria-label={messages.measure.panelLabel}
      hidden={!open}
    >
      <fieldset class="layers-group">
        <legend class="layers-group-title">{messages.measure.modeLabel}</legend>
        {MEASURE_MODES.map((id) => (
          <label key={id} class="layers-option">
            <input
              type="radio"
              name={groupName}
              value={id}
              checked={mode === id}
              onChange={() => {
                setMode(id);
                setPoints((current) => pointsForMode(id, current));
              }}
            />
            <span>{messages.measure.mode[id]}</span>
          </label>
        ))}
      </fieldset>
      <div class="measure-actions">
        <button
          type="button"
          class="map-control"
          disabled={centre === null}
          onClick={() => {
            if (centre === null) return;
            setPoints((current) => addMeasurePoint(mode, current, centre));
          }}
        >
          {messages.measure.addCentre}
        </button>
        <button
          type="button"
          class="map-control"
          disabled={points.length === 0}
          onClick={() => {
            setPoints(undoMeasurePoint);
          }}
        >
          {messages.measure.undo}
        </button>
        <button
          type="button"
          class="map-control"
          disabled={points.length === 0}
          onClick={() => {
            setPoints([]);
          }}
        >
          {messages.measure.clear}
        </button>
      </div>
      <p class="measure-result" role="status" aria-live="polite">
        {resultText(result, places, messages, locale)}
      </p>
      <p class="measure-note">{messages.measure.approxNote}</p>
    </section>
  );
}
