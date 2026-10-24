/**
 * The V2-A4 estimated-outline legend in the Layers panel: one dashed violet swatch in the
 * map's own colours (`.layers-swatch-outline`, kept equal to `FIRE_OUTLINE_COLOR`), a line when the route capped the set, and a plain sentence when a
 * current copy holds no outline — so "none" is said, not implied by an empty map. The
 * panel's status line carries the honest "as of" (`computed_at`).
 */

import type { FireOutlineOverlayBody } from '../core/fire-outlines.js';
import { useApp } from './context.js';
import { fireOutlinesPayload } from './layers.js';

export function FireOutlineLegend() {
  const { messages } = useApp();
  const body: FireOutlineOverlayBody | null = fireOutlinesPayload.value;
  if (body === null) return null;
  return (
    <div class="layers-legend">
      <ul>
        <li>
          <span class="layers-swatch layers-swatch-outline" aria-hidden="true" />
          {messages.layers.outlinesLegend}
        </li>
      </ul>
      {body.truncated ? <p class="layers-note">{messages.layers.outlinesTruncated}</p> : null}
      {body.features.length === 0 ? (
        <p class="layers-note">{messages.layers.outlinesNone}</p>
      ) : null}
    </div>
  );
}
