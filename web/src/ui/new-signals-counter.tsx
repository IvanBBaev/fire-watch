/**
 * The "new since you last looked" counter in the header (TASKS F). A situational-awareness
 * cue, not an alarm: a polite live region with the count, the age of the newest
 * observation shown beside it, "Show" to fly to the newest one (each press acknowledges it,
 * so repeated presses walk through the rest, newest first) and "Mark all seen".
 *
 * Selection follows the URL (see map-pane.tsx): "Show" routes to the event's permalink and
 * the map flies there on its own. Opening an event by any route acknowledges it.
 */

import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';

import { relativeAgeFrom } from '../core/i18n/format.js';
import { useApp } from './context.js';
import { eventPath } from './logic/event-resolution.js';
import { selectedEventIdFrom } from './logic/layout.js';
import { acknowledgeAllSignals, acknowledgeSignals, newSignals } from './new-signals.js';
import { useNow } from './use-now.js';

export function NewSignalsCounter() {
  const { messages, serverNow } = useApp();
  const { path, route } = useLocation();
  const nowMs = useNow(serverNow);
  const signals = newSignals.value;
  const selectedId = selectedEventIdFrom(path);

  // Looking at an event is seeing it — including a growth that lands while it is open.
  useEffect(() => {
    if (selectedId !== null && signals.some((signal) => signal.id === selectedId)) {
      acknowledgeSignals([selectedId]);
    }
  }, [selectedId, signals]);

  const newest = signals[0];
  const copy = messages.newSignals;

  return (
    <div class="new-signals" role="group" aria-label={copy.regionLabel}>
      {/* The live region holds the count alone: the age ticks every 30 s and must not be
          re-announced each time. Polite, never assertive — this is not an alarm. */}
      <p class="new-signals-count" aria-live="polite" aria-atomic="true">
        {newest === undefined ? '' : copy.count(signals.length)}
      </p>
      {newest !== undefined && (
        <>
          <span class="new-signals-age">
            {copy.latest(messages.relativeAge(relativeAgeFrom(nowMs, newest.event.lastObservedAt)))}
          </span>
          <button
            type="button"
            class="button-secondary new-signals-show"
            onClick={() => {
              acknowledgeSignals([newest.id]);
              route(eventPath(newest.id));
            }}
          >
            {copy.showNewest}
          </button>
          <button
            type="button"
            class="button-secondary new-signals-clear"
            onClick={() => {
              acknowledgeAllSignals();
            }}
          >
            {copy.markAllSeen}
          </button>
        </>
      )}
    </div>
  );
}
