/**
 * The F18 lightning context on an event: MTG-LI flashes within a radius in the hours before
 * the first detection (DATA-SOURCES §F18), read from `config.lightningContextUrlTemplate`.
 *
 * **Context, never cause** (GLOSSARY §5.2): the copy gives a count and a distance and says
 * that a flash does not mean lightning started the fire. "No data" and "no lightning" are
 * kept apart: a `complete` answer with zero flashes says none were recorded and that the
 * instrument misses some; `pending` and `no_data` say there is no lightning data — never
 * a zero.
 *
 * Nothing renders while loading, on a failed or malformed answer, or when no template is
 * configured: the absence of the note is not a claim about lightning.
 */

import { useEffect, useState } from 'preact/hooks';

import type { Messages } from '../../core/i18n/messages.js';
import { useApp } from '../context.js';

/** The parts of the route's body the note renders. */
export type LightningContext =
  | {
      readonly status: 'complete';
      readonly radiusKm: number;
      readonly windowHours: number;
      readonly flashCount: number;
      readonly nearestKm: number | null;
    }
  | { readonly status: 'pending' | 'no_data' };

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** A fetched body → what to render, or `null` for anything this version does not read. */
export function parseLightningContext(body: unknown): LightningContext | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record['schema_version'] !== 1) return null;
  const status = record['status'];
  if (status === 'pending' || status === 'no_data') return { status };
  if (status !== 'complete') return null;
  const radiusKm = record['radius_km'];
  const windowHours = record['window_hours'];
  const flashCount = record['flash_count'];
  const nearest = record['nearest_km'];
  if (!isPositive(radiusKm) || !isPositive(windowHours) || !isCount(flashCount)) return null;
  if (flashCount > 0 && !(typeof nearest === 'number' && Number.isFinite(nearest))) return null;
  return {
    status,
    radiusKm,
    windowHours,
    flashCount,
    nearestKm: flashCount > 0 ? (nearest as number) : null,
  };
}

/** The sentence for an answer. */
export function lightningContextText(
  context: LightningContext,
  t: Messages['eventDetail'],
): string {
  if (context.status !== 'complete') return t.lightningContextNoData;
  if (context.flashCount === 0 || context.nearestKm === null) {
    return t.lightningContextNone(context.radiusKm, context.windowHours);
  }
  return t.lightningContextFlashes(
    context.flashCount,
    context.radiusKm,
    context.windowHours,
    context.nearestKm,
  );
}

export function lightningContextUrl(template: string | undefined, eventId: string): string | null {
  return template === undefined ? null : template.replace('{id}', encodeURIComponent(eventId));
}

export function LightningContextNote({ eventId }: { readonly eventId: string }) {
  const { messages, config } = useApp();
  const url = lightningContextUrl(config.lightningContextUrlTemplate, eventId);
  const [state, setState] = useState<{ url: string | null; context: LightningContext | null }>({
    url: null,
    context: null,
  });

  useEffect(() => {
    if (url === null) return undefined;
    let cancelled = false;
    fetch(url)
      .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
      .then((body) => {
        if (!cancelled) setState({ url, context: parseLightningContext(body) });
      })
      .catch(() => {
        if (!cancelled) setState({ url, context: null });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Another event's answer must never show for a frame after a navigation.
  if (state.url !== url || state.context === null) return null;
  return (
    <p class="event-note lightning-context-note">
      {lightningContextText(state.context, messages.eventDetail)}
    </p>
  );
}
