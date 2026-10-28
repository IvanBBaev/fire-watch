/**
 * Slot 900: an orientation-only "where" — the rounded centre, a distance on the reader's
 * press, and an OpenStreetMap *area* view.
 *
 * GLOSSARY §5.2 ("no routing, ever"): no marker, no directions, no navigation apps. Only a
 * permission the reader already granted is used silently; the page never raises a location
 * prompt on its own.
 */

import { useEffect, useState } from 'preact/hooks';

import { relativePosition } from '../../../core/geo/bearing.js';
import type { RelativePosition } from '../../../core/geo/bearing.js';
import { useApp } from '../../context.js';
import { CopyButton } from '../copy-button.js';
import { distanceText } from '../event-format.js';
import { geolocationAlreadyGranted } from '../location-permission.js';
import { approximateCentre, coordinatesText, openStreetMapAreaUrl } from '../where.js';
import type { EventSectionProps } from './registry.js';

type WhereState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'locating' }
  | { readonly kind: 'fix'; readonly position: RelativePosition }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' };

export default function WhereSection({ event }: EventSectionProps) {
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
