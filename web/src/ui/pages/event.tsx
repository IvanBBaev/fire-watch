/**
 * The event page — the "10-second panel" (07-product-ux P7) behind a stable permalink.
 * Merged ids resolve to their survivor and the URL is replaced with the canonical path
 * (ADR-002 I1). Every timestamp is satellite observation time, formatted Europe/Sofia.
 */

import { useEffect, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';

import { formatDateTimeSofia } from '../../core/i18n/format.js';
import { resolveEvent } from '../../core/store/index.js';
import { FreshnessChip, pickBanner } from '../status/index.js';
import { eventPath, redirectTargetFor } from '../logic/event-resolution.js';
import { lifecycleLine } from '../logic/lifecycle-line.js';
import { placeName } from '../logic/place.js';
import { applyMetaTags } from '../share/document-meta.js';
import { buildShareCard, renderShareCardSvg } from '../share/share-card.js';
import { shareCardImage } from '../share/share-image.js';
import { shareMetaFor } from '../share/share-meta.js';
import { useApp } from '../context.js';
import { useNow } from '../use-now.js';
import { useStoreState } from '../use-store.js';

export function EventPage() {
  const { store, serverNow, messages, locale } = useApp();
  const state = useStoreState(store);
  const nowMs = useNow(serverNow);
  const { route } = useLocation();
  const { params } = useRoute();
  const requestedId = params['id'] ?? '';

  const resolved = resolveEvent(state, requestedId);
  const event = resolved === null ? null : resolved.event;

  // Merged tombstone (or any stale id): replace the URL with the survivor's canonical
  // path, preserving the #map= camera hash — never push, so Back keeps working.
  const redirectTarget = redirectTargetFor(requestedId, event?.id ?? null);
  useEffect(() => {
    if (redirectTarget !== null) {
      route(redirectTarget + window.location.hash, true);
    }
  }, [redirectTarget, route]);

  // OG/Twitter meta for the canonical permalink while the page is mounted (F-9: a
  // JavaScript-running crawler and the share sheet read these; link-preview scrapers need
  // the edge injection, which reuses `shareMetaFor`). Keyed on the content, so a poll that
  // changes nothing the tags say does not touch the document.
  const metaTags =
    event == null
      ? null
      : shareMetaFor({
          event,
          messages,
          locale,
          permalinkUrl: window.location.origin + eventPath(event.id),
        });
  const metaKey = metaTags === null ? '' : JSON.stringify(metaTags);
  useEffect(() => {
    if (metaTags === null) return undefined;
    return applyMetaTags(document, metaTags);
  }, [metaKey]);

  const [sharing, setSharing] = useState(false);

  if (event == null) {
    return (
      <article class="page event-page">
        <p class="key-fact">{messages.eventNotFound}</p>
        <p>
          <a class="back-link" href="/">
            {messages.backToMap}
          </a>
        </p>
      </article>
    );
  }

  const copyLink = (): void => {
    void navigator.clipboard.writeText(window.location.href).catch(() => {
      // Clipboard unavailable (permissions, insecure context) — the URL bar remains.
    });
  };

  // The card is built at the moment of the click, from server time: its "made at" stamp is
  // the instant the image left the app, and a stale banner up at that instant goes with it.
  const shareCard = (): void => {
    if (sharing) return;
    const madeAtMs = serverNow();
    const banner = pickBanner(state, madeAtMs);
    const permalinkUrl = window.location.origin + eventPath(event.id);
    const card = buildShareCard({
      event,
      messages,
      locale,
      nowMs: madeAtMs,
      staleSinceIso: banner?.kind === 'stale-sources' ? banner.sinceIso : null,
      permalinkUrl,
    });
    setSharing(true);
    void shareCardImage({
      ...renderShareCardSvg(card),
      baseName: event.id,
      title: messages.eventNearPlace(placeName(event, locale)),
      url: permalinkUrl,
    })
      .catch(() => {
        // Nothing to recover: the page itself still carries every fact the card would.
      })
      .finally(() => {
        setSharing(false);
      });
  };

  return (
    <article class="page event-page">
      <p>
        <a class="back-link" href="/">
          {messages.backToMap}
        </a>
      </p>
      <h1>{messages.eventNearPlace(placeName(event, locale))}</h1>
      <p class="tier-line">
        {messages.satelliteDetected} · {messages.tierLabel[event.scoreBucket]}
      </p>
      {event.scoreBucket === 'unverified' && (
        <p class="unverified-note">{messages.unverifiedNote}</p>
      )}
      <FreshnessChip
        lastObservedAt={event.lastObservedAt}
        serverNowMs={nowMs}
        messages={messages}
        locale={locale}
      />
      <p class="lifecycle-line key-fact">{lifecycleLine(event, messages, locale, nowMs)}</p>
      <div class="event-facts">
        {event.areaHa !== null && <p class="key-fact">{messages.areaBothUnits(event.areaHa)}</p>}
        <p>{messages.detectionCount(event.detectionCount)}</p>
        <p>{messages.firstObserved(formatDateTimeSofia(event.firstObservedAt, locale))}</p>
      </div>
      <div class="safety-block">
        <p class="safety-line key-fact">{messages.safetyNoTravel}</p>
        <p class="emergency-line key-fact">{messages.emergencyLine}</p>
      </div>
      <p class="share-actions">
        <button type="button" class="button-secondary" onClick={copyLink}>
          {messages.copyLink}
        </button>{' '}
        <button
          type="button"
          class="button-secondary share-card-button"
          onClick={shareCard}
          disabled={sharing}
          aria-busy={sharing}
        >
          {messages.shareCard.share}
        </button>
      </p>
      {/* The short disclaimer layer at the moment of reliance (07 §5.6.3, 09 §3.4), linked to
          the full layer on the privacy page (TASKS I5). */}
      <footer class="panel-footer">
        <p>{messages.panelFooterDisclaimer}</p>
        <a class="disclaimer-link" href="/privacy#disclaimer">
          {messages.disclaimer.linkLabel}
        </a>
      </footer>
    </article>
  );
}
