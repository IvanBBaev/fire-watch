/**
 * The F18 lightning layer's legend in the Layers panel: the three age classes in the map's
 * own colours (round, ringed swatches, like the flashes), and a plain sentence when a
 * current copy has no flash young enough to draw — so "no storms" is said, not implied by
 * an empty map. The panel's status line carries the honest "as of" (`covered_through`).
 */

import { LIGHTNING_AGE_CLASSES, LIGHTNING_RING_COLOR } from '../core/lightning.js';
import { useApp } from './context.js';
import { useLightningDisplay } from './lightning.js';

/** Under the panel's id (`fw-layers-panel`), without importing the panel (no cycle). */
const TITLE_ID = 'fw-layers-panel-lightning-legend';

export function LightningLegend() {
  const { messages } = useApp();
  const display = useLightningDisplay();
  if (display === null) return null;
  const drawn = display.counts[0] + display.counts[1] + display.counts[2];
  return (
    <div class="layers-legend">
      <p id={TITLE_ID} class="layers-legend-title">
        {messages.layers.lightningLegendTitle}
      </p>
      <ul aria-labelledby={TITLE_ID}>
        {LIGHTNING_AGE_CLASSES.map((entry, index) => (
          <li key={entry.color}>
            <span
              class="layers-swatch"
              style={{
                backgroundColor: entry.color,
                borderColor: LIGHTNING_RING_COLOR,
                borderRadius: '50%',
              }}
              aria-hidden="true"
            />
            {messages.layers.lightningClasses[index] ?? ''}
          </li>
        ))}
      </ul>
      {drawn === 0 ? <p class="layers-note">{messages.layers.lightningNone}</p> : null}
    </div>
  );
}
