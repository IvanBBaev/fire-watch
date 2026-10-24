/**
 * V2-A4: an event's estimated outline on its detail panel — its area as a band, how far an
 * edge may sit from where it is drawn, how many satellite pixels it joins, and the caveat
 * (an estimate from satellite detections; not an official perimeter, not a forecast).
 *
 * Read from the outlines body the Layers loader holds (`fireOutlinesBody`), the same copy
 * the map draws and `overlay-refresh.ts` keeps current, so the panel and the map can never
 * disagree about an outline and a stale pass (the route's 503) drops both. Nothing renders
 * before the outlines are loaded, after a failed or malformed answer, or when the event has
 * no outline: the absence of the note is not a claim about the fire's size.
 */

import { fireOutlineFor, type FireOutlineProperties } from '../../core/fire-outlines.js';
import type { Messages } from '../../core/i18n/messages.js';
import { useApp } from '../context.js';
import { fireOutlinesBody } from '../layers.js';

/** Edge uncertainty shown to one decimal: the pixel grid is not finer than that. */
function roundKm(km: number): number {
  return Math.max(0.1, Math.round(km * 10) / 10);
}

/** The area sentence for one outline. */
export function fireOutlineText(
  outline: FireOutlineProperties,
  messages: Pick<Messages, 'areaBothUnits' | 'eventDetail'>,
): string {
  const low = outline.area_low_ha > 0 ? messages.areaBothUnits(outline.area_low_ha) : null;
  return messages.eventDetail.fireOutlineArea(
    messages.areaBothUnits(outline.area_ha),
    low,
    messages.areaBothUnits(outline.area_high_ha),
    roundKm(outline.edge_uncertainty_km),
    outline.footprints,
  );
}

export function FireOutlineNote({ eventId }: { readonly eventId: string }) {
  const { messages } = useApp();
  const body = fireOutlinesBody.value;
  const outline = body === null ? null : fireOutlineFor(body, eventId);
  if (outline === null) return null;
  return (
    <div class="event-note fire-outline-note">
      <p>{fireOutlineText(outline, messages)}</p>
      <p>{messages.eventDetail.fireOutlineCaveat}</p>
    </div>
  );
}
