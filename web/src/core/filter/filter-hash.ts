/**
 * The filters in the URL fragment, so a filtered view can be shared and survives reload:
 *
 *   #map=8.0/42.6977/23.3219&t=6h&src=v&r=22
 *
 * - `t`   time window id (`1h` … `48h`, `all`) — see `AGE_WINDOW_IDS`.
 * - `src` sensor family (`v` VIIRS, `m` MODIS, `s` SLSTR, `g` geostationary).
 * - `r`   oblast, the ISO 3166-2:BG number (1–28).
 * - `sens` sensitivity (V2-A2): `bal`, `multi`, or custom `<band>.<detections>.<sensors>`
 *          — see `sensitivity.ts`.
 *
 * A member is written only when it differs from the default, so an unfiltered view keeps
 * the short `#map=…` links that already exist in the wild, and those old links (event
 * permalinks included — they are forever) still open exactly as before: no member means
 * "not specified", never "reset to default over what the reader stored".
 *
 * An unparseable value is ignored, not an error: a hand-edited link opens with that one
 * filter unset rather than failing.
 */

import type { AgeWindowId } from '../time/age-filter.js';
import { DEFAULT_AGE_WINDOW, parseAgeWindow } from '../time/age-filter.js';
import { readFragmentMember, withFragmentMembers } from '../url-fragment.js';
import { parseOblast } from './oblasts.js';
import type { SensitivityCriteria } from './sensitivity.js';
import { DEFAULT_SENSITIVITY, parseSensitivity, sensitivityHashValue } from './sensitivity.js';
import type { SourceFamily } from './source-families.js';
import { parseSourceFamily } from './source-families.js';

export const FILTER_HASH_KEYS = {
  window: 't',
  family: 'src',
  oblast: 'r',
  sensitivity: 'sens',
} as const;

export interface FilterSelection {
  readonly window: AgeWindowId;
  readonly family: SourceFamily | null;
  readonly oblast: number | null;
  readonly sensitivity: SensitivityCriteria;
}

export const DEFAULT_FILTERS: FilterSelection = {
  window: DEFAULT_AGE_WINDOW,
  family: null,
  oblast: null,
  sensitivity: DEFAULT_SENSITIVITY,
};

/**
 * What the fragment says, member by member; `undefined` where it says nothing (or
 * nothing valid), so the caller can fall back to storage for that member alone.
 */
export interface FilterHashState {
  readonly window?: AgeWindowId;
  readonly family?: SourceFamily | null;
  readonly oblast?: number | null;
  readonly sensitivity?: SensitivityCriteria;
}

export function parseFilterHash(hash: string): FilterHashState {
  const window = parseAgeWindow(readFragmentMember(hash, FILTER_HASH_KEYS.window));
  const rawFamily = readFragmentMember(hash, FILTER_HASH_KEYS.family);
  const family = parseSourceFamily(rawFamily);
  const oblast = parseOblast(readFragmentMember(hash, FILTER_HASH_KEYS.oblast));
  const sensitivity = parseSensitivity(readFragmentMember(hash, FILTER_HASH_KEYS.sensitivity));
  return {
    ...(window === null ? {} : { window }),
    ...(family === null ? {} : { family }),
    ...(oblast === null ? {} : { oblast }),
    ...(sensitivity === null ? {} : { sensitivity }),
  };
}

/** The filter members `selection` spells, `null` for each one left at its default. */
export function filterHashMembers(selection: FilterSelection): Record<string, string | null> {
  return {
    [FILTER_HASH_KEYS.window]:
      selection.window === DEFAULT_FILTERS.window ? null : selection.window,
    [FILTER_HASH_KEYS.family]: selection.family,
    [FILTER_HASH_KEYS.oblast]: selection.oblast === null ? null : String(selection.oblast),
    [FILTER_HASH_KEYS.sensitivity]: sensitivityHashValue(selection.sensitivity),
  };
}

/** The fragment with the filter members set to `selection`, defaults removed. */
export function withFilterHash(hash: string, selection: FilterSelection): string {
  return withFragmentMembers(hash, filterHashMembers(selection));
}
