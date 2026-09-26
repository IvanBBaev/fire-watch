/**
 * The event list — a first-class peer surface to the map (07-product-ux P10): the
 * screen-reader strategy, the weak-device fallback and the fastest panic surface at
 * once. Every timestamp shown is satellite observation time (P1), never poll time.
 *
 * It is scoped on two axes, and states what each one hides. In time: only fires observed
 * inside the chosen window, because a feed that accumulates for two days answers "what
 * happened this week" when the reader asked "what is burning". In space: what the camera
 * shows comes first, nearest to the centre of the view, because that is the question a map
 * raises. What it never does is silently shrink — whatever either scope leaves out is
 * counted out loud, with one press to bring it back, so narrowing can never read as "the
 * fire went away".
 */

import { partitionByViewport } from '../core/geo/in-view.js';
import { sortedEvents } from '../core/store/index.js';
import { formatObservedStampSofia, relativeAgeFrom } from '../core/i18n/format.js';
import { AGE_WINDOW_IDS, ageCutoffMs, partitionByAge } from '../core/time/age-filter.js';
import type { FireEvent } from '../core/types.js';
import { eventPath } from './logic/event-resolution.js';
import { placeName } from './logic/place.js';
import { ageWindow, setAgeWindow } from './age-window.js';
import { useApp } from './context.js';
import { mapViewport } from './map-camera.js';
import { useNow } from './use-now.js';
import { useStoreState } from './use-store.js';

function EventRow({ event, nowMs }: { readonly event: FireEvent; readonly nowMs: number }) {
  const { messages, locale } = useApp();
  return (
    <li>
      <a class="event-row" href={eventPath(event.id)}>
        <span class="event-row-title key-fact">
          {messages.eventNearPlace(placeName(event, locale))}
        </span>
        <span class={`status-badge status-${event.status}`}>
          {messages.statusShort[event.status]}
        </span>
        <span class="event-row-observed">
          {messages.observedShort(
            formatObservedStampSofia(event.lastObservedAt, nowMs, locale),
            messages.relativeAge(relativeAgeFrom(nowMs, event.lastObservedAt)),
          )}
        </span>
      </a>
    </li>
  );
}

/**
 * The window picker. `aria-pressed` rather than a radio group: these are filter toggles on
 * one list, and the group label carries what the bare hour counts mean.
 */
function AgeWindowPicker() {
  const { messages } = useApp();
  const current = ageWindow.value;
  return (
    <div class="age-window" role="group" aria-label={messages.ageWindow.label}>
      {AGE_WINDOW_IDS.map((id) => (
        <button
          key={id}
          type="button"
          class={`age-window-option${id === current ? ' selected' : ''}`}
          aria-pressed={id === current}
          onClick={() => {
            setAgeWindow(id);
          }}
        >
          {messages.ageWindow.option[id]}
        </button>
      ))}
    </div>
  );
}

export function EventList({
  inViewOnly,
  onToggleInViewOnly,
}: {
  readonly inViewOnly: boolean;
  readonly onToggleInViewOnly: (next: boolean) => void;
}) {
  const { store, serverNow, messages } = useApp();
  const state = useStoreState(store);
  const nowMs = useNow(serverNow);
  // Before the map has reported a frame there is nothing to filter against, and a list
  // that waits for a slow map is a list that failed at its one job.
  const viewport = mapViewport.value;
  const windowId = ageWindow.value;

  if (state.lastSnapshotAt === null) {
    return <p class="list-placeholder">{messages.loading}</p>;
  }

  const all = sortedEvents(state);
  // Time first, then space: the window is a statement about the world, the frame is a
  // statement about the screen, and "3 outside the view" should count only fires the
  // reader has actually asked to see.
  const byAge = partitionByAge(all, ageCutoffMs(nowMs, windowId));
  const scoped =
    inViewOnly && viewport !== null ? partitionByViewport(byAge.recent, viewport) : null;
  const events = scoped?.inView ?? byAge.recent;
  const outsideCount = scoped?.outsideCount ?? 0;

  return (
    <div class="event-list-wrap">
      <AgeWindowPicker />
      {all.length === 0 ? (
        // GLOSSARY §3b empty_state: "no satellite detections", never "no fires".
        <p class="list-placeholder">{messages.status.emptyState}</p>
      ) : events.length === 0 ? (
        <p class="list-placeholder">
          {byAge.recent.length === 0
            ? messages.ageWindow.emptyInWindow
            : messages.listInView.emptyInView}
        </p>
      ) : (
        <ul class="event-list">
          {events.map((event) => (
            <EventRow key={event.id} event={event} nowMs={nowMs} />
          ))}
        </ul>
      )}
      {byAge.olderCount > 0 && (
        <p class="list-scope-note">
          <span>{messages.ageWindow.olderHidden(byAge.olderCount)}</span>
          <button
            type="button"
            class="link-button"
            onClick={() => {
              setAgeWindow('all');
            }}
          >
            {messages.ageWindow.showOlder}
          </button>
        </p>
      )}
      {scoped !== null && outsideCount > 0 && (
        <p class="list-scope-note">
          <span>{messages.listInView.outsideView(outsideCount)}</span>
          <button
            type="button"
            class="link-button"
            onClick={() => {
              onToggleInViewOnly(false);
            }}
          >
            {messages.listInView.showAll}
          </button>
        </p>
      )}
      {scoped === null && viewport !== null && all.length > 0 && (
        <p class="list-scope-note">
          <button
            type="button"
            class="link-button"
            onClick={() => {
              onToggleInViewOnly(true);
            }}
          >
            {messages.listInView.showInViewOnly}
          </button>
        </p>
      )}
    </div>
  );
}
