/**
 * The V2-E3 Copernicus EMS badge on an event: "Copernicus EMS activation EMSRxxx", a link
 * to the activation's public page, for every Rapid Mapping wildfire activation that matches
 * the event under `CEMS_MATCH` (DATA-SOURCES §V2-E3). The link's title carries the
 * activation-level citation the Copernicus EMS citation guidelines ask for.
 *
 * Loaded lazily by the slot-600 event section (`sections/600-cems.section.tsx`), so neither
 * the parser nor the matching sits on the critical path.
 *
 * Nothing renders while loading, on a failed, stale (503) or malformed answer, or when no
 * activation matches: the absence of the badge is not a claim that Copernicus was not
 * activated.
 */

import { useEffect, useState } from 'preact/hooks';

import {
  cemsActivationCitation,
  cemsActivationUrl,
  matchCemsActivations,
  parseCemsOverlay,
  type CemsActivation,
  type CemsMatchEvent,
} from '@fire-watch/contracts';

import type { Messages } from '../../core/i18n/messages.js';
import { useApp } from '../context.js';

/** A fetched body → the activations about `event`, or `null` for a body this version cannot read. */
export function cemsBadgeActivations(
  body: unknown,
  event: CemsMatchEvent,
): readonly CemsActivation[] | null {
  const overlay = parseCemsOverlay(body);
  return overlay === null ? null : matchCemsActivations(event, overlay.activations);
}

export interface CemsBadgeProps {
  readonly url: string;
  readonly event: CemsMatchEvent & { readonly id: string };
}

export function CemsBadge({ url, event }: CemsBadgeProps) {
  const { messages } = useApp();
  const [state, setState] = useState<{
    key: string | null;
    activations: readonly CemsActivation[] | null;
  }>({ key: null, activations: null });
  // A refetch per event, not per render: the list is small and cached for five minutes.
  const key = `${url}#${event.id}`;
  const { lon, lat, firstObservedAt, lastObservedAt } = event;

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
      .then((body) => {
        if (cancelled) return;
        setState({
          key,
          activations: cemsBadgeActivations(body, { lon, lat, firstObservedAt, lastObservedAt }),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ key, activations: null });
      });
    return () => {
      cancelled = true;
    };
  }, [url, key, lon, lat, firstObservedAt, lastObservedAt]);

  // Another event's answer must never show for a frame after a navigation.
  if (state.key !== key || state.activations === null) return null;
  return <CemsBadgeLinks activations={state.activations} t={messages.eventDetail} />;
}

/** One badge per matching activation; nothing for none. */
export function CemsBadgeLinks({
  activations,
  t,
}: {
  readonly activations: readonly CemsActivation[];
  readonly t: Messages['eventDetail'];
}) {
  if (activations.length === 0) return null;
  return (
    <>
      {activations.map((activation) => (
        <p class="event-note cems-badge" key={activation.code}>
          <a
            class="external-link"
            href={cemsActivationUrl(activation.code)}
            title={cemsActivationCitation(activation.code, activation.activation_time)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t.cemsActivation(activation.code)}
          </a>
        </p>
      ))}
    </>
  );
}
