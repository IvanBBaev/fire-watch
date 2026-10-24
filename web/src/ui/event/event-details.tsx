/**
 * The event panel's rich half: identity, satellite timeline, fire radiative power,
 * contributing sensors and an orientation-only "where". Everything here is a fact the
 * data carries; anything the detections file cannot support is left out and said so.
 *
 * GLOSSARY §5.2 ("no routing, ever"): the only outbound map link is an OpenStreetMap
 * *area* view at the rounded centre — no marker, no directions, no navigation apps.
 */

import { useEffect, useState } from 'preact/hooks';

import { relativePosition } from '../../core/geo/bearing.js';
import type { RelativePosition } from '../../core/geo/bearing.js';
import {
  formatDateTimeSofia,
  formatNumber,
  formatObservedStampSofia,
  relativeAgeFrom,
} from '../../core/i18n/format.js';
import type { FireEvent } from '../../core/types.js';
import { useApp } from '../context.js';
import { eventPath } from '../logic/event-resolution.js';
import { copyText } from './clipboard.js';
import type { FrpSummary, Overpass } from './detection-detail.js';
import { distanceText, orbitText, pixelText, sensorLabel } from './event-format.js';
import { geolocationAlreadyGranted } from './location-permission.js';
import { sparklineGeometry } from './sparkline.js';
import { FireOutlineNote } from './fire-outline-note.js';
import { LightningContextNote } from './lightning-context-note.js';
import { LandCoverNote } from './land-cover-note.js';
import { ProtectedSiteNote } from './protected-site-note.js';
import { StaticSourceNote } from './static-source-note.js';
import type { DetailState } from './use-detection-summary.js';
import { approximateCentre, coordinatesText, openStreetMapAreaUrl } from './where.js';

import './event-details.css';

type CopyStatus = 'idle' | 'copied' | 'failed';

/** A copy button with a polite live line that reports the outcome. */
function CopyButton({ label, text }: { readonly label: string; readonly text: () => string }) {
  const { messages } = useApp();
  const [status, setStatus] = useState<CopyStatus>('idle');
  const onClick = (): void => {
    void copyText(text()).then((ok) => {
      setStatus(ok ? 'copied' : 'failed');
    });
  };
  return (
    <>
      <button type="button" class="button-secondary" onClick={onClick}>
        {label}
      </button>
      <span class="copy-status" role="status">
        {status === 'copied'
          ? messages.eventDetail.copied
          : status === 'failed'
            ? messages.eventDetail.copyFailed
            : ''}
      </span>
    </>
  );
}

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

const SPARK_BOX = { width: 160, height: 40, pad: 4 } as const;

function FrpSection({ frp }: { readonly frp: FrpSummary | null }) {
  const { messages, locale } = useApp();
  const t = messages.eventDetail;
  if (frp === null) {
    return (
      <section class="event-section" aria-labelledby="event-frp-title">
        <h2 id="event-frp-title">{t.frpTitle}</h2>
        <p>{t.frpUnavailable}</p>
      </section>
    );
  }
  const mw = (pass: Overpass): string => formatNumber(pass.frpMw ?? 0, locale);
  const line = (
    template: (mw: string, sensor: string, time: string) => string,
    pass: Overpass,
  ): string =>
    template(mw(pass), sensorLabel(pass.sourceId), formatDateTimeSofia(pass.observedAt, locale));
  const values = frp.series.map((pass) => pass.frpMw ?? 0);
  const geometry = sparklineGeometry(
    frp.series.map((pass) => ({ tMs: pass.observedMs, value: pass.frpMw ?? 0 })),
    SPARK_BOX,
  );
  return (
    <section class="event-section" aria-labelledby="event-frp-title">
      <h2 id="event-frp-title">{t.frpTitle}</h2>
      <p>{line(t.frpLatest, frp.latest)}</p>
      {frp.peak !== frp.latest && <p>{line(t.frpPeak, frp.peak)}</p>}
      {geometry !== null && (
        <svg
          class="frp-sparkline"
          role="img"
          aria-label={t.frpChartLabel(
            frp.series.length,
            formatNumber(Math.min(...values), locale),
            formatNumber(Math.max(...values), locale),
          )}
          viewBox={`0 0 ${String(SPARK_BOX.width)} ${String(SPARK_BOX.height)}`}
          width={SPARK_BOX.width}
          height={SPARK_BOX.height}
        >
          <path d={geometry.path} />
          {geometry.points.map((point, index) => (
            <circle key={index} cx={point.x} cy={point.y} r="2" />
          ))}
        </svg>
      )}
      <p class="event-note">{t.frpNote}</p>
    </section>
  );
}

function DetectionSections({ detail }: { readonly detail: DetailState }) {
  const { messages, locale } = useApp();
  const t = messages.eventDetail;
  if (detail.kind === 'loading') return null;
  if (detail.kind === 'unavailable') return <p class="event-note">{t.detailUnavailable}</p>;
  const { summary } = detail;
  return (
    <>
      <FrpSection frp={summary.frp} />
      <section class="event-section" aria-labelledby="event-sensors-title">
        <h2 id="event-sensors-title">{t.sensorsTitle}</h2>
        <ul class="sensor-list">
          {summary.sensors.map((sensor) => {
            const size = pixelText(sensor.sourceId, messages, locale);
            const facts = [
              orbitText(sensor.sourceId, messages),
              size === null ? null : t.sensorPixel(size),
              messages.detectionCount(sensor.detections),
            ].filter((fact): fact is string => fact !== null);
            return (
              <li key={sensor.sourceId}>
                <strong>{sensorLabel(sensor.sourceId)}</strong> · {facts.join(' · ')}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

type WhereState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'locating' }
  | { readonly kind: 'fix'; readonly position: RelativePosition }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' };

function WhereSection({ event }: { readonly event: FireEvent }) {
  const { messages, locale, geolocator } = useApp();
  const t = messages.eventDetail;
  const centre = approximateCentre(event.lon, event.lat);
  const [where, setWhere] = useState<WhereState>({ kind: 'idle' });

  const locate = (): void => {
    setWhere({ kind: 'locating' });
    void geolocator.locate().then((outcome) => {
      setWhere(
        outcome.kind === 'fix'
          ? { kind: 'fix', position: relativePosition(outcome, event) }
          : { kind: outcome.kind },
      );
    });
  };

  // Only a permission the reader already granted is used silently; otherwise the button
  // asks, on their press. The page never raises a location prompt on its own.
  useEffect(() => {
    let cancelled = false;
    void geolocationAlreadyGranted().then((granted) => {
      if (granted && !cancelled) locate();
    });
    return () => {
      cancelled = true;
    };
  }, [event.id]);

  return (
    <section class="event-section" aria-labelledby="event-where-title">
      <h2 id="event-where-title">{t.whereTitle}</h2>
      <p class="event-id-line">
        <span>
          {t.approxCentreLabel}: <code>{coordinatesText(centre)}</code>
        </span>{' '}
        <CopyButton label={t.copyCoordinates} text={() => coordinatesText(centre)} />
      </p>
      {where.kind === 'fix' ? (
        <p class="key-fact">{distanceText(where.position, messages, locale)}</p>
      ) : (
        <p>
          <button
            type="button"
            class="button-secondary"
            onClick={locate}
            disabled={where.kind === 'locating'}
          >
            {t.showDistance}
          </button>{' '}
          <span role="status">
            {where.kind === 'locating'
              ? t.locating
              : where.kind === 'denied'
                ? t.locationDenied
                : where.kind === 'unavailable'
                  ? t.locationUnavailable
                  : ''}
          </span>
        </p>
      )}
      <p class="event-note">{t.orientationNote}</p>
      <p>
        <a
          class="external-link"
          href={openStreetMapAreaUrl(centre)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t.openStreetMap}
        </a>
      </p>
    </section>
  );
}

export interface EventDetailsProps {
  readonly event: FireEvent;
  readonly nowMs: number;
  readonly detail: DetailState;
}

export function EventDetails({ event, nowMs, detail }: EventDetailsProps) {
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
      <StaticSourceNote
        event={event}
        positions={detail.kind === 'ready' ? detail.summary.positions : null}
      />
      <ProtectedSiteNote
        event={event}
        positions={detail.kind === 'ready' ? detail.summary.positions : null}
      />
      <LandCoverNote
        event={event}
        positions={detail.kind === 'ready' ? detail.summary.positions : null}
      />
      <LightningContextNote eventId={event.id} />
      <FireOutlineNote eventId={event.id} />
      <DetectionSections detail={detail} />
      <WhereSection event={event} />
    </>
  );
}
