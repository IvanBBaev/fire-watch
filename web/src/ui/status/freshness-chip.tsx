/**
 * The freshness chip (07-product-ux P2; GLOSSARY §3b).
 *
 * The pass predictor is not built, so the chip always renders the
 * `freshness_chip_unknown` template — never the windowed variant, never a guessed range,
 * never a hidden chip ("when the predictor has no window, render `freshness_chip_unknown`").
 * Age is styled neutrally (gray/amber, never red — red belongs to fire on the map), and
 * the [?] affordance links to the data-freshness explainer on the About page.
 */

import {
  formatObservedStampSofia,
  minutesAgoFrom,
  relativeAgeFrom,
} from '../../core/i18n/format.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { Locale } from '../../core/types.js';
import './status.css';

export interface FreshnessChipProps {
  /** ISO-8601 UTC satellite observation time — never poll time (07-product-ux P1). */
  readonly lastObservedAt: string;
  /** Server-time epoch ms from `serverNow()` — never the raw client clock. */
  readonly serverNowMs: number;
  readonly messages: Messages;
  readonly locale: Locale;
}

export type FreshnessAge = 'fresh' | 'aging' | 'stale';

const AGING_FROM_MINUTES = 90;
const STALE_FROM_MINUTES = 180;

/** Neutral age styling buckets: fresh < 90 min, aging < 180 min, stale ≥ 180 min. */
export function freshnessAge(minutesAgo: number): FreshnessAge {
  if (minutesAgo < AGING_FROM_MINUTES) return 'fresh';
  if (minutesAgo < STALE_FROM_MINUTES) return 'aging';
  return 'stale';
}

export function FreshnessChip({
  lastObservedAt,
  serverNowMs,
  messages,
  locale,
}: FreshnessChipProps) {
  // Minutes still drive the neutral color bucket; the words drive what the reader sees.
  const minutesAgo = minutesAgoFrom(serverNowMs, lastObservedAt);
  const text = messages.status.freshnessChipUnknown(
    formatObservedStampSofia(lastObservedAt, serverNowMs, locale),
    messages.relativeAge(relativeAgeFrom(serverNowMs, lastObservedAt)),
  );

  return (
    <span class={`fw-chip fw-chip--${freshnessAge(minutesAgo)}`}>
      {text}
      <a
        class="fw-chip__help"
        href="/about#data-freshness"
        aria-label={messages.about.freshnessExplainerTitle}
      >
        ?
      </a>
    </span>
  );
}
