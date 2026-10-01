/**
 * Wording helpers for the event panel: catalog templates filled with locale-formatted
 * numbers. Pure — no DOM, no clock.
 */

import { formatNumber } from '../../core/i18n/format.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { Locale } from '../../core/types.js';
import type { RelativePosition } from '../../core/geo/bearing.js';
import { SENSORS, isKnownSource, pixelSize } from './sensors.js';

/** The instrument name for a source id; an id the registry does not know is shown as is. */
export function sensorLabel(sourceId: string): string {
  return isKnownSource(sourceId) ? SENSORS[sourceId].label : sourceId;
}

/** "375 m", "1 km", "~4 km", "~3–4.5 km" — the nominal pixel size, or `null` if unknown. */
export function pixelText(sourceId: string, messages: Messages, locale: Locale): string | null {
  if (!isKnownSource(sourceId)) return null;
  const size = pixelSize(SENSORS[sourceId]);
  const value =
    size.min === size.max
      ? formatNumber(size.max, locale)
      : `${formatNumber(size.min, locale)}–${formatNumber(size.max, locale)}`;
  const worded =
    size.unit === 'km'
      ? messages.eventDetail.kilometres(value)
      : messages.eventDetail.metres(value);
  return size.approximate ? `~${worded}` : worded;
}

/** The orbit label for a known source, or `null`. */
export function orbitText(sourceId: string, messages: Messages): string | null {
  return isKnownSource(sourceId) ? messages.eventDetail.orbit[SENSORS[sourceId].orbit] : null;
}

/** "About 12 km north-east of your location", or the nearby line under 1 km. */
export function distanceText(
  position: RelativePosition,
  messages: Messages,
  locale: Locale,
): string {
  if (position.nearby) return messages.eventDetail.nearby;
  return messages.eventDetail.distance(
    formatNumber(position.km, locale),
    messages.eventDetail.compass[position.compass],
  );
}
