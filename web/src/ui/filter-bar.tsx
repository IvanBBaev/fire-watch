/**
 * The filter bar above the event list: time window, sensor family, oblast, sensitivity
 * (V2-A2), and place search. Native `<select>`s on purpose — each is one tab stop, is 44 px tall by CSS, and
 * gets the platform's own accessible picker on a phone — where the old window picker was
 * four toggle buttons and four tab stops.
 *
 * It states what it cannot know rather than guessing: the sensor counts say how many fires
 * the feed did not attribute (they pass every sensor filter), and a region chosen before
 * the oblast borders have loaded says so instead of pretending to filter.
 *
 * The sensitivity picker offers three presets with live counts; the criteria behind them
 * sit in a folded "advanced" group, and any other combination shows as "custom". Whenever
 * signals are hidden the bar says that a hidden signal may still be a fire.
 */

import { SCORE_BUCKETS, type ScoreBucket } from '@fire-watch/contracts';

import type { FamilyCounts, SensitivityCounts } from '../core/filter/event-filter.js';
import { oblastsByName } from '../core/filter/oblasts.js';
import {
  DETECTION_STEPS,
  isDefaultSensitivity,
  presetOf,
  SENSITIVITY_PRESET_IDS,
  SENSITIVITY_PRESETS,
  SENSOR_STEPS,
  type SensitivityPresetId,
} from '../core/filter/sensitivity.js';
import { SOURCE_FAMILIES, parseSourceFamily } from '../core/filter/source-families.js';
import { AGE_WINDOW_IDS, parseAgeWindow } from '../core/time/age-filter.js';
import { ageWindow, setAgeWindow } from './age-window.js';
import { useApp } from './context.js';
import {
  regionFilter,
  regionIndexState,
  sensitivityFilter,
  setRegionFilter,
  setSensitivity,
  setSourceFamily,
  sourceFamily,
} from './filters.js';
import { PlaceSearch } from './place-search.js';

const CUSTOM = 'custom';

/** A step list that always holds the current value, so a custom link's value is selectable. */
function stepsWith(steps: readonly number[], current: number): readonly number[] {
  return steps.includes(current) ? steps : [...steps, current].sort((a, b) => a - b);
}

function isPresetId(value: string): value is SensitivityPresetId {
  return (SENSITIVITY_PRESET_IDS as readonly string[]).includes(value);
}

export function FilterBar({
  counts,
  sensitivityCounts,
}: {
  readonly counts: FamilyCounts;
  readonly sensitivityCounts: SensitivityCounts;
}) {
  const { messages, locale } = useApp();
  const windowId = ageWindow.value;
  const family = sourceFamily.value;
  const oblast = regionFilter.value;
  const regionState = regionIndexState.value;
  const sensitivity = sensitivityFilter.value;
  const preset = presetOf(sensitivity);

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
        <div class="filter-field">
          <label class="filter-label" for="filter-sensitivity">
            {messages.filters.sensitivityLabel}
          </label>
          <select
            id="filter-sensitivity"
            class="filter-select"
            value={preset ?? CUSTOM}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              if (isPresetId(raw)) setSensitivity(SENSITIVITY_PRESETS[raw]);
            }}
          >
            {SENSITIVITY_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {messages.filters.sensitivityOption(
                  messages.filters.sensitivityPreset[id],
                  sensitivityCounts.byPreset[id],
                )}
              </option>
            ))}
            {preset === null && (
              <option value={CUSTOM}>
                {messages.filters.sensitivityOption(
                  messages.filters.sensitivityCustom,
                  sensitivityCounts.current,
                )}
              </option>
            )}
          </select>
        </div>
      </div>
      <details class="filter-advanced">
        <summary>{messages.filters.sensitivityAdvanced}</summary>
        <div class="filter-selects">
          <div class="filter-field">
            <label class="filter-label" for="filter-min-band">
              {messages.filters.sensitivityMinBand}
            </label>
            <select
              id="filter-min-band"
              class="filter-select"
              value={sensitivity.minBand}
              onChange={(event) => {
                const raw = event.currentTarget.value;
                const band = SCORE_BUCKETS.find((b) => b === raw);
                if (band !== undefined) setSensitivity({ ...sensitivity, minBand: band });
              }}
            >
              {SCORE_BUCKETS.map((band: ScoreBucket) => (
                <option key={band} value={band}>
                  {messages.tierLabel[band]}
                </option>
              ))}
            </select>
          </div>
          <div class="filter-field">
            <label class="filter-label" for="filter-min-detections">
              {messages.filters.sensitivityMinDetections}
            </label>
            <select
              id="filter-min-detections"
              class="filter-select"
              value={String(sensitivity.minDetections)}
              onChange={(event) => {
                setSensitivity({
                  ...sensitivity,
                  minDetections: Number(event.currentTarget.value),
                });
              }}
            >
              {stepsWith(DETECTION_STEPS, sensitivity.minDetections).map((n) => (
                <option key={n} value={String(n)}>
                  {messages.filters.sensitivityAtLeast(n)}
                </option>
              ))}
            </select>
          </div>
          <div class="filter-field">
            <label class="filter-label" for="filter-min-sensors">
              {messages.filters.sensitivityMinSensors}
            </label>
            <select
              id="filter-min-sensors"
              class="filter-select"
              value={String(sensitivity.minSensors)}
              onChange={(event) => {
                setSensitivity({ ...sensitivity, minSensors: Number(event.currentTarget.value) });
              }}
            >
              {stepsWith(SENSOR_STEPS, sensitivity.minSensors).map((n) => (
                <option key={n} value={String(n)}>
                  {messages.filters.sensitivityAtLeast(n)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </details>
      {!isDefaultSensitivity(sensitivity) && (
        <p class="filter-note">{messages.filters.sensitivityHint}</p>
      )}
      {sensitivityCounts.sensorsUnreported > 0 && (
        <p class="filter-note">
          {messages.filters.sensitivityUnreported(sensitivityCounts.sensorsUnreported)}
        </p>
      )}
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
