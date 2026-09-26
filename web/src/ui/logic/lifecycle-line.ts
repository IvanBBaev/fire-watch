/**
 * The frozen §3 lifecycle line for one event — shared by the event page and the share card.
 *
 * The two surfaces differ in exactly one respect, and it is the reason for the `clock`
 * parameter: the page is read *now*, so an active event's last detection may shrink to a
 * bare "14:05" while it is still today in Sofia; a share card is read later and elsewhere,
 * so every stamp it carries must be a full date and time that stays true after the image
 * has left the app (07-product-ux §5.2.2 — relative-only labels fail in screenshots).
 */

import {
  formatDateSofia,
  formatDateTimeSofia,
  formatObservedStampSofia,
} from '../../core/i18n/format.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { FireEvent, Locale } from '../../core/types.js';
import { wholeDaysBetween } from './time.js';

/**
 * `signal_weakening` requires >= 2 passes of falling signal by definition (GLOSSARY §3);
 * FireEvent does not carry the actual pass count yet, so the definitional floor is the
 * only honest value available. Tracked as a contract gap.
 */
export const SIGNAL_WEAKENING_MIN_PASSES = 2;

/**
 * Placeholder for the declaring authority of `officially_*` states: FireEvent carries
 * no declared-by/declared-at fields yet (contract gap). An em dash is punctuation, not
 * copy — never invent a source name.
 */
export const UNKNOWN_SOURCE_PLACEHOLDER = '—';

/**
 * Who reads the stamp: `page` — a live reader, for whom today's time needs no date;
 * `card` — a reader of a copy, for whom every stamp is absolute.
 */
export type LifecycleClock = 'page' | 'card';

export function lifecycleLine(
  event: FireEvent,
  messages: Messages,
  locale: Locale,
  nowMs: number,
  clock: LifecycleClock = 'page',
): string {
  switch (event.status) {
    case 'active':
      // A bare time reads as "today" — but an active event's last pass can be older than
      // that, so on the page the stamp grows a date as soon as it stops being today's.
      return messages.lifecycle.active(
        clock === 'card'
          ? formatDateTimeSofia(event.lastObservedAt, locale)
          : formatObservedStampSofia(event.lastObservedAt, nowMs, locale),
      );
    case 'signal_weakening':
      return messages.lifecycle.signalWeakening(SIGNAL_WEAKENING_MIN_PASSES);
    case 'no_longer_detected':
      return messages.lifecycle.noLongerDetected(formatDateTimeSofia(event.lastObservedAt, locale));
    case 'officially_contained':
      return messages.lifecycle.officiallyContained(
        formatDateSofia(event.lastObservedAt, locale),
        UNKNOWN_SOURCE_PLACEHOLDER,
      );
    case 'officially_extinguished':
      return messages.lifecycle.officiallyExtinguished(
        formatDateSofia(event.lastObservedAt, locale),
        UNKNOWN_SOURCE_PLACEHOLDER,
      );
    case 'archived':
      return messages.lifecycle.archived(wholeDaysBetween(nowMs, event.lastObservedAt));
  }
}
