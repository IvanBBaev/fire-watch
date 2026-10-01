/**
 * The Layers-panel row for the F16 static hot-source mask: a checkbox, what the layer is,
 * its load status, and — while it is on — the OSM credit with its link (CI-13). The credit
 * is owed always and the map corner carries it; the panel repeats it beside the layer so
 * the reader sees whose data the shapes are.
 *
 * Its own component so the panel gains one line, not a block.
 */

import { useEffect } from 'preact/hooks';

import { useApp } from './context.js';
import {
  loadStaticSources,
  setStaticSourcesChosen,
  staticSourcesChosen,
  staticSourcesCredit,
  staticSourcesState,
} from './static-sources.js';

/** Under the panel's id (`fw-layers-panel`), without importing the panel (no cycle). */
const NOTE_ID = 'fw-layers-panel-static-sources-note';

export function StaticSourcesOption() {
  const { messages } = useApp();
  const on = staticSourcesChosen.value;
  const state = staticSourcesState.value;
  // A choice persisted from an earlier visit loads the mask without a click.
  useEffect(() => {
    if (on && staticSourcesState.peek() === 'idle') void loadStaticSources();
  }, [on]);
  const credit = staticSourcesCredit();
  return (
    <div class="layers-overlay">
      <label class="layers-option">
        <input
          type="checkbox"
          checked={on}
          aria-describedby={NOTE_ID}
          onChange={() => {
            setStaticSourcesChosen(!on);
          }}
        />
        <span>{messages.layers.staticSources}</span>
      </label>
      <p id={NOTE_ID} class="layers-note">
        {messages.layers.staticSourcesNote}
      </p>
      <p class="layers-status" aria-live="polite">
        {on && state === 'loading' ? <span>{messages.layers.loading}</span> : null}
        {on && state === 'failed' ? <span>{messages.layers.unavailable}</span> : null}
      </p>
      {on && credit !== null ? (
        <p class="layers-credit">
          {credit.href === undefined ? (
            credit.text
          ) : (
            <a href={credit.href} rel="noopener noreferrer">
              {credit.text}
            </a>
          )}
        </p>
      ) : null}
    </div>
  );
}
