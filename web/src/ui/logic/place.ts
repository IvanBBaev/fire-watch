/**
 * Place-name selection (ADR-002 D5): the event's display name is "Fire near <place>",
 * and both language variants travel on the event itself.
 */

import type { Locale } from '../../core/types.js';

export function placeName(
  names: { readonly placeNameBg: string; readonly placeNameEn: string },
  locale: Locale,
): string {
  return locale === 'bg' ? names.placeNameBg : names.placeNameEn;
}
