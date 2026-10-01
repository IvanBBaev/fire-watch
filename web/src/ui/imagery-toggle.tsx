/**
 * The basemap choice (ADR-001 A2.3, TASKS G6 → G4): plain map or satellite imagery, a
 * radio pair inside the Layers panel. It exists only while the server's client-config
 * carries an `imagery` block; when the block goes — quota tripwire, kill switch, no key —
 * the choice is simply not rendered, and the map falls back to the basemap on its own
 * through `imageryTilesUrl`. Missing, never broken: no disabled state, no explanation,
 * nothing to dismiss.
 *
 * Radios rather than a pressed button: the two options are mutually exclusive, and a
 * named group reads to a screen reader as the choice it is. Each option is a whole
 * 44 px label, not just the dot.
 *
 * The imagery option's label stays `mapControls.imagery`; `layers.basemapTitle` and
 * `layers.basemapMap` name the group and the plain option. All three are implementer copy
 * held in `PENDING_FOUNDER_REVIEW`.
 */

import { useApp } from './context.js';
import { imageryOffered, imageryOn, toggleImagery } from './imagery.js';

function choose(imagery: boolean): void {
  if (imageryOn.peek() !== imagery) toggleImagery();
}

export function BasemapChoice() {
  const { messages } = useApp();
  if (!imageryOffered.value) return null;
  const on = imageryOn.value;
  return (
    <fieldset class="layers-group">
      <legend class="layers-group-title">{messages.layers.basemapTitle}</legend>
      <label class="layers-option">
        <input
          type="radio"
          name="fw-basemap"
          value="map"
          checked={!on}
          onChange={() => {
            choose(false);
          }}
        />
        <span>{messages.layers.basemapMap}</span>
      </label>
      <label class="layers-option">
        <input
          type="radio"
          name="fw-basemap"
          value="imagery"
          checked={on}
          onChange={() => {
            choose(true);
          }}
        />
        <span>{messages.mapControls.imagery}</span>
      </label>
    </fieldset>
  );
}
