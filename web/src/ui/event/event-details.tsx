/**
 * The event panel's rich half: identity, satellite timeline, then the sections in
 * `sections/` (static source, protected site, land cover, lightning, outline, CEMS, FRP and
 * sensors, before/after, where). Everything here is a fact the data carries; anything the
 * detections file cannot support is left out and said so.
 *
 * V3-P2: this file is not edited to add a section. A section is a
 * `sections/<slot>-<name>.section.tsx` file, found and ordered by `sections/registry.ts`.
 *
 * GLOSSARY §5.2 ("no routing, ever"): the only outbound map link is an OpenStreetMap
 * *area* view at the rounded centre — no marker, no directions, no navigation apps. (The
 * V2-E3 Copernicus EMS badge links to an activation's page, not to a place.)
 */

import { useEffect, useState } from 'preact/hooks';

import {
  formatDateTimeSofia,
  formatNumber,
  formatObservedStampSofia,
  relativeAgeFrom,
} from '../../core/i18n/format.js';
import type { FireEvent } from '../../core/types.js';
import { useApp } from '../context.js';
import { eventPath } from '../logic/event-resolution.js';
import { CopyButton } from './copy-button.js';
import { sensorLabel } from './event-format.js';
import {
  EVENT_SECTIONS,
  loadSections,
  loadedSections,
  type EventSectionEntry,
  type LoadedEventSection,
} from './sections/registry.js';
import type { DetailState } from './use-detection-summary.js';

import './event-details.css';

/** The public id and a copy of the canonical deep link (never the current URL's hash). */
export function EventIdentity({ eventId }: { readonly eventId: string }) {
  const { messages } = useApp();
  return (
    <p class="event-id-line">
      <span>
        {messages.eventDetail.eventIdLabel}: <code>{eventId}</code>
      </span>{' '}
      <CopyButton
        label={messages.copyLink}
        text={() => window.location.origin + eventPath(eventId)}
      />
    </p>
  );
}

function Age({ iso, nowMs }: { readonly iso: string; readonly nowMs: number }) {
  const { messages, locale } = useApp();
  return (
    <>
      <time dateTime={iso} title={formatDateTimeSofia(iso, locale)}>
        {messages.relativeAge(relativeAgeFrom(nowMs, iso))}
      </time>{' '}
      · {formatObservedStampSofia(iso, nowMs, locale)}
    </>
  );
}

export interface EventDetailsProps {
  readonly event: FireEvent;
  readonly nowMs: number;
  readonly detail: DetailState;
  /** The registry's sections; a test passes its own list. */
  readonly sections?: readonly EventSectionEntry[];
}

/** The registry's sections in slot order, rendered together once every chunk has loaded. */
function EventSections({
  sections,
  ...props
}: Omit<EventDetailsProps, 'sections'> & { readonly sections: readonly EventSectionEntry[] }) {
  const [ready, setReady] = useState<readonly LoadedEventSection[] | null>(() =>
    loadedSections(sections),
  );
  useEffect(() => {
    if (ready !== null) return undefined;
    let live = true;
    loadSections(sections).then(
      (loaded) => {
        if (live) setReady(loaded);
      },
      () => {
        // A failed chunk load leaves the timeline alone; the next event page tries again.
      },
    );
    return () => {
      live = false;
    };
  }, [sections, ready]);
  if (ready === null) return null;
  return (
    <>
      {ready.map(({ slot, Section }) => (
        <Section key={slot} {...props} />
      ))}
    </>
  );
}

export function EventDetails({
  event,
  nowMs,
  detail,
  sections = EVENT_SECTIONS,
}: EventDetailsProps) {
  const { messages, locale } = useApp();
  const t = messages.eventDetail;
  // "Last seen by" only when the detections file reaches the snapshot's own last
  // observation — an older file would name a sensor that did not make the latest pass.
  const lastSources =
    detail.kind === 'ready' &&
    Date.parse(detail.summary.latestObservedAt) === Date.parse(event.lastObservedAt)
      ? detail.summary.latestSources
      : null;
  return (
    <>
      <section class="event-section" aria-labelledby="event-timeline-title">
        <h2 id="event-timeline-title">{t.timelineTitle}</h2>
        <dl class="event-timeline">
          <dt>{t.firstDetected}</dt>
          <dd>
            <Age iso={event.firstObservedAt} nowMs={nowMs} />
          </dd>
          <dt>{t.lastDetected}</dt>
          <dd>
            <Age iso={event.lastObservedAt} nowMs={nowMs} />
          </dd>
          <dt>{t.detectionsLabel}</dt>
          <dd>{formatNumber(event.detectionCount, locale)}</dd>
          {lastSources !== null && (
            <>
              <dt>{t.lastSensorLabel}</dt>
              <dd>{lastSources.map(sensorLabel).join(', ')}</dd>
            </>
          )}
        </dl>
      </section>
      <EventSections event={event} nowMs={nowMs} detail={detail} sections={sections} />
    </>
  );
}
