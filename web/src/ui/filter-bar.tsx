/**
 * The filter bar above the event list: time window, sensor family, oblast, and place
 * search. Native `<select>`s on purpose — each is one tab stop, is 44 px tall by CSS, and
 * gets the platform's own accessible picker on a phone — where the old window picker was
 * four toggle buttons and four tab stops.
 *
 * It states what it cannot know rather than guessing: the sensor counts say how many fires
 * the feed did not attribute (they pass every sensor filter), and a region chosen before
 * the oblast borders have loaded says so instead of pretending to filter.
 */

import type { FamilyCounts } from '../core/filter/event-filter.js';
import { oblastsByName } from '../core/filter/oblasts.js';
import { SOURCE_FAMILIES, parseSourceFamily } from '../core/filter/source-families.js';
import { AGE_WINDOW_IDS, parseAgeWindow } from '../core/time/age-filter.js';
import { ageWindow, setAgeWindow } from './age-window.js';
import { useApp } from './context.js';
import {
  regionFilter,
  regionIndexState,
  setRegionFilter,
  setSourceFamily,
  sourceFamily,
} from './filters.js';
import { PlaceSearch } from './place-search.js';

export function FilterBar({ counts }: { readonly counts: FamilyCounts }) {
  const { messages, locale } = useApp();
  const windowId = ageWindow.value;
  const family = sourceFamily.value;
  const oblast = regionFilter.value;
  const regionState = regionIndexState.value;

  return (
    <div class="filter-bar" role="group" aria-label={messages.filters.label}>
      <PlaceSearch />
      <div class="filter-selects">
        <div class="filter-field">
          <label class="filter-label" for="filter-window">
            {messages.ageWindow.label}
          </label>
          <select
            id="filter-window"
            class="filter-select"
            value={windowId}
            onChange={(event) => {
              const next = parseAgeWindow(event.currentTarget.value);
              if (next !== null) setAgeWindow(next);
            }}
          >
            {AGE_WINDOW_IDS.map((id) => (
              <option key={id} value={id}>
                {messages.ageWindow.option[id]}
              </option>
            ))}
          </select>
        </div>
        <div class="filter-field">
          <label class="filter-label" for="filter-source">
            {messages.filters.sourceLabel}
          </label>
          <select
            id="filter-source"
            class="filter-select"
            value={family ?? ''}
            onChange={(event) => {
              setSourceFamily(parseSourceFamily(event.currentTarget.value));
            }}
          >
            <option value="">{messages.filters.sourceAll(counts.total)}</option>
            {SOURCE_FAMILIES.map((id) => (
              <option key={id} value={id}>
                {messages.filters.sourceOption(messages.filters.family[id], counts.byFamily[id])}
              </option>
            ))}
          </select>
        </div>
        <div class="filter-field">
          <label class="filter-label" for="filter-region">
            {messages.filters.regionLabel}
          </label>
          <select
            id="filter-region"
            class="filter-select"
            value={oblast === null ? '' : String(oblast)}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              setRegionFilter(raw === '' ? null : Number(raw));
            }}
          >
            <option value="">{messages.filters.regionAll}</option>
            {oblastsByName(locale).map(({ number, name }) => (
              <option key={number} value={String(number)}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {family !== null && counts.unreported > 0 && (
        <p class="filter-note">{messages.filters.sourceUnreported(counts.unreported)}</p>
      )}
      {oblast !== null && regionState === 'loading' && (
        <p class="filter-note" role="status">
          {messages.filters.regionLoading}
        </p>
      )}
      {oblast !== null && regionState === 'failed' && (
        <p class="filter-note" role="status">
          {messages.filters.regionFailed}
        </p>
      )}
    </div>
  );
}
