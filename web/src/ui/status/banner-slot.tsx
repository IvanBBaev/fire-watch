/**
 * The one fixed banner slot (GLOSSARY §3b "One degraded slot"). `pickBanner` is the
 * arbiter; this component only renders its verdict — exactly one banner or nothing,
 * never two. The user learns how old the data is, never which transport tier they are
 * on (ADR-003 D2).
 */

import { formatObservedStampSofia } from '../../core/i18n/format.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { Locale, StoreState } from '../../core/types.js';
import { pickBanner } from './pick-banner.js';
import './status.css';

export interface BannerSlotProps {
  readonly state: StoreState;
  /** Server-time epoch ms from `serverNow()` — never the raw client clock. */
  readonly serverNowMs: number;
  readonly messages: Messages;
  readonly locale: Locale;
}

export function BannerSlot({ state, serverNowMs, messages, locale }: BannerSlotProps) {
  const banner = pickBanner(state, serverNowMs);
  if (banner === null) return null;

  const text =
    banner.kind === 'offline'
      ? messages.bannerOffline
      : // A bare HH:MM is only unambiguous while "since" is today. Data can be days old —
        // and "delayed since 12:58" on a 15-day-old snapshot reads as *this* 12:58, which
        // is the false reassurance the banner exists to prevent. The stamp widens to carry
        // the date exactly when it has to (§3b's HH:MM placeholder, honestly filled).
        messages.status.staleSources(
          formatObservedStampSofia(banner.sinceIso, serverNowMs, locale),
        );

  return (
    <div class="fw-banner" role="status">
      {text}
    </div>
  );
}
