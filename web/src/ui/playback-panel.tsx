/**
 * The playback scrubber (V2-A1): a disclosure button among the map controls and the panel
 * it opens.
 *
 * Like the Layers panel, two components because they live in two places, and the panel is
 * always in the DOM (`hidden` when closed) so `aria-controls` never points at nothing.
 *
 * This is the eager shell: the title and the honesty note (the dots are satellite
 * hotspots, not confirmed fires, and nothing here predicts). Everything else — the window
 * choice, the slider, the legend, the credit, the way back to live — is the lazy replay
 * chunk's `PlaybackReplayPanel`, imported the first time the panel opens (CI-12).
 */

import { useEffect } from 'preact/hooks';

import { useApp } from './context.js';
import { setLayersPanelOpen } from './layers.js';
import { playbackPanelOpen } from './playback.js';
import { loadReplayModule, replayModule } from './playback-loader.js';

export const PLAYBACK_PANEL_ID = 'fw-playback-panel';

/** Open or close the scrubber; opening it closes the Layers panel so one panel hangs at a time. */
export function setPlaybackPanelOpen(open: boolean): void {
  playbackPanelOpen.value = open;
  if (open) setLayersPanelOpen(false);
}

export function PlaybackToggle() {
  const { messages } = useApp();
  const open = playbackPanelOpen.value;
  return (
    <button
      type="button"
      class="map-control"
      aria-expanded={open}
      aria-controls={PLAYBACK_PANEL_ID}
      onClick={() => {
        setPlaybackPanelOpen(!open);
      }}
    >
      {messages.playback.toggle}
    </button>
  );
}

export function PlaybackPanel() {
  const { messages } = useApp();
  const open = playbackPanelOpen.value;
  const Body = replayModule.value?.PlaybackReplayPanel ?? null;

  useEffect(() => {
    if (open) void loadReplayModule();
  }, [open]);

  return (
    <section
      id={PLAYBACK_PANEL_ID}
      class="layers-panel playback-panel"
      aria-label={messages.playback.title}
      hidden={!open}
    >
      <p class="layers-legend-title">{messages.playback.title}</p>
      <p class="layers-note">{messages.playback.note}</p>
      {Body === null ? (
        open ? (
          <p class="layers-status" aria-live="polite">
            {messages.playback.loading}
          </p>
        ) : null
      ) : (
        <Body />
      )}
    </section>
  );
}
