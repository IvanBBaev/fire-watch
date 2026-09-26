/**
 * The satellite-imagery toggle (ADR-001 A2.3, TASKS G6). It exists only while the server's
 * client-config carries an `imagery` block; when the block goes — quota tripwire, kill
 * switch, no key — the button is simply not rendered, and the map falls back to the
 * basemap on its own through `imageryTilesUrl`. Missing, never broken: no disabled state,
 * no explanation, nothing to dismiss.
 *
 * The label is `mapControls.imagery`, implementer copy held in `PENDING_FOUNDER_REVIEW`.
 */

import { useApp } from './context.js';
import { imageryOffered, imageryOn, toggleImagery } from './imagery.js';

export function ImageryToggle() {
  const { messages } = useApp();
  if (!imageryOffered.value) return null;
  return (
    <button
      type="button"
      class="map-control"
      aria-pressed={imageryOn.value}
      onClick={toggleImagery}
    >
      {messages.mapControls.imagery}
    </button>
  );
}
