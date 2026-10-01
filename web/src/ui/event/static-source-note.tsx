/**
 * The F16 caveat on an event: "near a known solar park / industrial heat source — this
 * hotspot may not be a fire", within `STATIC_SOURCE_CAVEAT.radiusM` of a source in the OSM
 * mask (11 §3.6).
 *
 * Per detection whenever the detections file gave positions: "2 of 5 detections are near a
 * known solar park". The centre is only a stand-in — an event whose centre sits between a
 * solar park and a real fire would otherwise be caveated wholesale, or one whose centre
 * falls just outside a park would lose the caveat its pixels on the park deserve. The
 * centre caveat remains the fallback while the file loads and when there is none (live
 * data has no per-event detections route yet).
 *
 * A caveat, never a filter: the event, its score and its detections render exactly as
 * before. Nothing renders until the mask has loaded (fetched from our own origin the first
 * time an event is opened), and nothing renders if it fails to load — the absence of a
 * caveat is not a claim that the hotspot is a fire.
 */

import { useEffect } from 'preact/hooks';

import type { FireEvent } from '../../core/types.js';
import { useApp } from '../context.js';
import {
  loadStaticSources,
  staticSourceCaveat,
  staticSourceDetectionCaveat,
  staticSourceMask,
} from '../static-sources.js';
import type { DetectionPosition } from './detection-detail.js';

export interface StaticSourceNoteProps {
  readonly event: Pick<FireEvent, 'lon' | 'lat'>;
  /** The detections' positions; `null` (or empty) falls back to the event's centre. */
  readonly positions?: readonly DetectionPosition[] | null;
}

export function StaticSourceNote({ event, positions = null }: StaticSourceNoteProps) {
  const { messages } = useApp();
  useEffect(() => {
    void loadStaticSources();
  }, []);
  const t = messages.eventDetail;
  if (positions !== null && positions.length > 0) {
    const perDetection = staticSourceDetectionCaveat(staticSourceMask.value, positions);
    if (perDetection === null) return null;
    const { caveat: kind, near, total } = perDetection;
    return (
      <p class="event-note static-source-note">
        {kind === 'solar'
          ? t.staticSourceDetectionsSolar(near, total)
          : t.staticSourceDetectionsIndustrial(near, total)}
      </p>
    );
  }
  const caveat = staticSourceCaveat(staticSourceMask.value, event);
  if (caveat === null) return null;
  return (
    <p class="event-note static-source-note">
      {caveat === 'solar' ? t.staticSourceSolar : t.staticSourceIndustrial}
    </p>
  );
}
