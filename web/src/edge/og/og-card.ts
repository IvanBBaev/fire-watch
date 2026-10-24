/**
 * The og:image card at the edge (TASKS V2-D4): the same card the event page's Share button
 * draws (`share-card.ts`), built from the published snapshot instead of the browser's
 * store, so a link preview and a shared image can never say different things.
 *
 * Pure: snapshot, id, locale and instant in; the event, its meta and its SVG out. Nothing
 * here reads a clock, a request or the network — the handlers inject all three.
 *
 * What it reuses, and why each piece matters:
 * - `resolveEvent` — a merged id previews as its survivor, exactly as the permalink
 *   redirects to it (ADR-002 I1); an id the snapshot does not hold has no card.
 * - `staleSnapshotSince` — a card made from a snapshot that stopped updating carries the
 *   §3b delay line, the same rule the Share button applies to the live banner.
 * - `buildShareCard` / `renderShareCardSvg` — every word and every layout decision.
 *
 * No PII: the card's inputs are the public snapshot and the requested locale. Nothing of
 * the request (address, agent, cookies) reaches the card, the URL or the cache key.
 */

import bg from '../../core/i18n/bg.js';
import en from '../../core/i18n/en.js';
import type { Messages } from '../../core/i18n/messages.js';
import { resolveLocale } from '../../core/i18n/locale.js';
import { resolveEvent } from '../../core/store/selectors.js';
import type { FireEvent, Locale, Snapshot } from '../../core/types.js';
import { eventPath } from '../../ui/logic/event-resolution.js';
import {
  buildShareCard,
  renderShareCardSvg,
  type ShareCardImage,
} from '../../ui/share/share-card.js';
import { shareMetaFor, type MetaTag } from '../../ui/share/share-meta.js';
import { staleSnapshotSince } from '../../ui/status/pick-banner.js';

export const OG_CATALOGS: Readonly<Record<Locale, Messages>> = { bg, en };

/** The PNG route, relative to the site origin; `{id}` is the canonical public id. */
export function ogImagePath(publicId: string, locale: Locale): string {
  return `/og/event/${encodeURIComponent(publicId)}.png?lang=${locale}`;
}

/** Public ids are short slugs (`fw-2026-q7f3d`); anything else is not looked up at all. */
const PUBLIC_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function isPublicId(value: string): boolean {
  return PUBLIC_ID.test(value);
}

/**
 * The request's locale: an explicit `lang` (the image URL always carries one, so the
 * picture matches the page that named it) wins, then `Accept-Language`, then Bulgarian.
 */
export function requestLocale(lang: string | null, acceptLanguage: string | null): Locale {
  return resolveLocale(lang, acceptLanguage);
}

export function findSnapshotEvent(snapshot: Snapshot, requestedId: string): FireEvent | null {
  if (!isPublicId(requestedId)) return null;
  const events = new Map(snapshot.events.map((event) => [event.id, event] as const));
  return resolveEvent({ events }, requestedId)?.event ?? null;
}

export interface OgCardInput {
  readonly snapshot: Snapshot;
  readonly event: FireEvent;
  readonly locale: Locale;
  /** `https://host`, no trailing slash. */
  readonly origin: string;
  /** Server-side epoch ms of the render — the card's "image created" stamp. */
  readonly nowMs: number;
}

export function ogCardImage(input: OgCardInput): ShareCardImage {
  const { snapshot, event, locale, origin, nowMs } = input;
  return renderShareCardSvg(
    buildShareCard({
      event,
      messages: OG_CATALOGS[locale],
      locale,
      nowMs,
      staleSinceIso: staleSnapshotSince(snapshot.generatedAt, nowMs),
      permalinkUrl: origin + eventPath(event.id),
    }),
  );
}

/** The shell's tags for an event: the F6 meta plus the image that route will render. */
export function ogMetaTags(input: OgCardInput): readonly MetaTag[] {
  const { event, locale, origin } = input;
  const image = ogCardImage(input);
  return shareMetaFor({
    event,
    messages: OG_CATALOGS[locale],
    locale,
    permalinkUrl: origin + eventPath(event.id),
    image: {
      url: origin + ogImagePath(event.id, locale),
      width: image.width,
      height: image.height,
    },
  });
}
