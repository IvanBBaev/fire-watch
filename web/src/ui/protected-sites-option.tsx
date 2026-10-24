/**
 * The Layers-panel row for the V2-F1 Natura 2000 protected sites: a checkbox, what the
 * layer is, its load status, and — while it is on — the EEA credit with its link (CI-13).
 * The credit is owed always and `/credits` carries it; the panel repeats it beside the
 * layer so the reader sees whose data the shapes are (the map corner line is fixed).
 */

import { useEffect } from 'preact/hooks';

import { useApp } from './context.js';
import {
  loadProtectedSites,
  protectedSitesChosen,
  protectedSitesCredit,
  protectedSitesState,
  setProtectedSitesChosen,
} from './protected-sites.js';

/** Under the panel's id (`fw-layers-panel`), without importing the panel (no cycle). */
const NOTE_ID = 'fw-layers-panel-protected-sites-note';

export function ProtectedSitesOption() {
  const { messages } = useApp();
  const on = protectedSitesChosen.value;
  const state = protectedSitesState.value;
  // A choice persisted from an earlier visit loads the sites without a click.
  useEffect(() => {
    if (on && protectedSitesState.peek() === 'idle') void loadProtectedSites();
  }, [on]);
  const credit = protectedSitesCredit();
  return (
    <div class="layers-overlay">
      <label class="layers-option">
        <input
          type="checkbox"
          checked={on}
          aria-describedby={NOTE_ID}
          onChange={() => {
            setProtectedSitesChosen(!on);
          }}
        />
        <span>{messages.layers.protectedSites}</span>
      </label>
      <p id={NOTE_ID} class="layers-note">
        {messages.layers.protectedSitesNote}
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
