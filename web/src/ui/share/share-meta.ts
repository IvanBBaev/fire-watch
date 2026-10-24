/**
 * Open Graph / Twitter meta for an event permalink (TASKS F6; 08-frontend F-9, §5.1.6).
 *
 * Pure: event in, tags out. The same function is meant for both places a `/event/<id>`
 * document gets its meta:
 * - **in the browser** (`document-meta.ts`), which is what a JavaScript-running crawler
 *   (Google) and the browser's own share sheet read;
 * - **at the edge** (08 §5.1.6, v1: a Pages Function that string-replaces the static block
 *   in the cached shell), because link-preview scrapers do not run JavaScript. That
 *   function is deploy work and does not exist yet; this module has no DOM dependency so
 *   it can be bundled there as-is.
 *
 * The description carries the observation stamp as an absolute Europe/Sofia date and
 * time, for the same reason the card does: a preview is read long after it was fetched.
 *
 * `og:image` only when the caller has one (TASKS V2-D4): the edge shell passes the URL of
 * the PNG route that rasterises the same card (`web/src/edge/og`). The browser passes
 * none, because a JavaScript-running crawler reads the edge-injected tags first and the
 * browser cannot vouch that the route is deployed. Without an image `twitter:card` stays
 * `summary`, which renders honestly with no picture; with one it is
 * `summary_large_image`.
 */

import { formatDateTimeSofia } from '../../core/i18n/format.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { FireEvent, Locale } from '../../core/types.js';
import { placeName } from '../logic/place.js';

export interface MetaTag {
  /** Open Graph uses `property`, Twitter uses `name`. */
  readonly attribute: 'property' | 'name';
  readonly key: string;
  readonly content: string;
}

export interface ShareMetaInput {
  readonly event: FireEvent;
  readonly messages: Messages;
  readonly locale: Locale;
  /** Absolute URL of the event's canonical permalink. */
  readonly permalinkUrl: string;
  /** The rendered card, when a route serves one (the edge shell); absent in the browser. */
  readonly image?: ShareMetaImage;
}

export interface ShareMetaImage {
  /** Absolute URL of the PNG. */
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/** OG locale tags for the two catalogs (the formatter tags, underscore form). */
const OG_LOCALE: Readonly<Record<Locale, string>> = { bg: 'bg_BG', en: 'en_GB' };

const DOT = ' · ';

export function shareMetaFor(input: ShareMetaInput): readonly MetaTag[] {
  const { event, messages, locale, permalinkUrl, image } = input;
  const place = placeName(event, locale);
  const title = messages.eventNearPlace(place);
  const description = [
    `${messages.satelliteDetected}${DOT}${messages.tierLabel[event.scoreBucket]}`,
    messages.statusShort[event.status],
    messages.shareCard.observedAt(formatDateTimeSofia(event.lastObservedAt, locale)),
  ].join(DOT);
  const tags: MetaTag[] = [
    { attribute: 'property', key: 'og:site_name', content: messages.appTitle },
    { attribute: 'property', key: 'og:type', content: 'website' },
    { attribute: 'property', key: 'og:locale', content: OG_LOCALE[locale] },
    { attribute: 'property', key: 'og:title', content: title },
    { attribute: 'property', key: 'og:description', content: description },
    { attribute: 'property', key: 'og:url', content: permalinkUrl },
  ];
  if (image === undefined) {
    tags.push({ attribute: 'name', key: 'twitter:card', content: 'summary' });
  } else {
    const alt = messages.ogImage.alt(place);
    tags.push(
      { attribute: 'property', key: 'og:image', content: image.url },
      { attribute: 'property', key: 'og:image:type', content: 'image/png' },
      { attribute: 'property', key: 'og:image:width', content: String(image.width) },
      { attribute: 'property', key: 'og:image:height', content: String(image.height) },
      { attribute: 'property', key: 'og:image:alt', content: alt },
      { attribute: 'name', key: 'twitter:card', content: 'summary_large_image' },
      { attribute: 'name', key: 'twitter:image', content: image.url },
      { attribute: 'name', key: 'twitter:image:alt', content: alt },
    );
  }
  tags.push(
    { attribute: 'name', key: 'twitter:title', content: title },
    { attribute: 'name', key: 'twitter:description', content: description },
  );
  return tags;
}
