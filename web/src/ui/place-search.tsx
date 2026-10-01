/**
 * Place search — an ARIA 1.2 combobox over settlements (Bulgarian or Latin, any common
 * romanisation) and typed coordinates (decimal, Bulgarian decimal comma, or DMS).
 *
 * Choosing a result flies the map through the same camera path as the map's own controls
 * (`camera-request.ts`), so a search made before the map chunk has loaded opens the map
 * there instead of animating away from somewhere else. Nothing leaves the browser: the
 * gazetteer is a same-origin asset, and the query is matched locally.
 */

import { useState } from 'preact/hooks';

import type { LatLon } from '../core/search/coordinates.js';
import { parseCoordinates } from '../core/search/coordinates.js';
import type { Place } from '../core/search/gazetteer.js';
import { COORDINATE_ZOOM, MIN_QUERY_LENGTH, zoomForPlace } from '../core/search/gazetteer.js';
import { oblastName } from '../core/filter/oblasts.js';
import { requestCamera } from './camera-request.js';
import { useApp } from './context.js';
import { gazetteer, gazetteerState, loadGazetteer } from './place-search-data.js';

const LISTBOX_ID = 'place-search-results';
const RESULT_LIMIT = 8;

type Option =
  | { readonly kind: 'coordinates'; readonly point: LatLon }
  | { readonly kind: 'place'; readonly place: Place };

export function formatLatLon(point: LatLon): string {
  return `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
}

export function PlaceSearch() {
  const { messages, locale } = useApp();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const index = gazetteer.value;
  const state = gazetteerState.value;

  const trimmed = query.trim();
  const point = parseCoordinates(trimmed);
  const options: Option[] = [];
  if (point !== null) options.push({ kind: 'coordinates', point });
  else if (index !== null) {
    for (const place of index.search(trimmed, RESULT_LIMIT)) options.push({ kind: 'place', place });
  }
  const asked = trimmed.length >= MIN_QUERY_LENGTH;
  const expanded = open && options.length > 0;

  const status = !asked
    ? ''
    : options.length > 0
      ? messages.search.resultCount(options.length)
      : point === null && state === 'loading'
        ? messages.search.loading
        : point === null && state === 'failed'
          ? messages.search.failed
          : messages.search.noResults;

  const choose = (option: Option): void => {
    if (option.kind === 'coordinates') {
      requestCamera({ ...option.point, zoom: COORDINATE_ZOOM });
    } else {
      const { place } = option;
      requestCamera({ lat: place.lat, lon: place.lon, zoom: zoomForPlace(place) });
      setQuery(locale === 'bg' ? place.name : place.latin);
    }
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown' && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % options.length);
    } else if (event.key === 'ArrowUp' && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (event.key === 'Enter') {
      const option = options[active] ?? options[0];
      if (option !== undefined) {
        event.preventDefault();
        choose(option);
      }
    } else if (event.key === 'Escape') {
      if (expanded) {
        event.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (query !== '') {
        event.preventDefault();
        setQuery('');
      }
    }
  };

  return (
    <div class="place-search">
      <label class="filter-label" for="place-search-input">
        {messages.search.label}
      </label>
      <input
        id="place-search-input"
        class="place-search-input"
        type="search"
        role="combobox"
        autocomplete="off"
        spellcheck={false}
        enterKeyHint="search"
        placeholder={messages.search.placeholder}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={LISTBOX_ID}
        aria-activedescendant={expanded && active >= 0 ? `${LISTBOX_ID}-${active}` : undefined}
        value={query}
        onFocus={() => {
          void loadGazetteer();
        }}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setOpen(false);
        }}
      />
      <ul id={LISTBOX_ID} class="place-search-results" role="listbox" hidden={!expanded}>
        {expanded &&
          options.map((option, i) => (
            <li
              key={option.kind === 'place' ? `${option.place.name}-${i}` : 'coordinates'}
              id={`${LISTBOX_ID}-${i}`}
              role="option"
              aria-selected={i === active}
              class={`place-search-option${i === active ? ' active' : ''}`}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
            >
              {option.kind === 'coordinates' ? (
                <span class="place-search-name">
                  {messages.search.goToCoordinates(formatLatLon(option.point))}
                </span>
              ) : (
                <>
                  <span class="place-search-name">
                    {locale === 'bg' ? option.place.name : option.place.latin}
                  </span>
                  <span class="place-search-detail">
                    {[
                      locale === 'bg' ? option.place.latin : option.place.name,
                      option.place.oblast === null ? null : oblastName(option.place.oblast, locale),
                    ]
                      .filter((part) => part !== null)
                      .join(' · ')}
                  </span>
                </>
              )}
            </li>
          ))}
      </ul>
      <p class="place-search-status" role="status">
        {status}
      </p>
    </div>
  );
}
