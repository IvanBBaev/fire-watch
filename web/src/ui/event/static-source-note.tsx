/**
 * The F16 caveat on an event: "near a known solar park / industrial heat source — this
 * hotspot may not be a fire", within `STATIC_SOURCE_CAVEAT.radiusM` of a source in the OSM
 * mask (11 §3.6).
 *
 * Per detection whenever the detections file gave positions: "2 of 5 detections are near a
 * known solar park". The centre is only a stand-in — an event whose centre sits between a
 * solar park and a real fire would otherwise be caveated wholesale, or one whose centre
 * falls just outside a park would lose the caveat its pixels on the park deserve. The
 * centre caveat remains the fallback while the file loads and when there is none. Live
 * data reads the per-event detections route, which holds the 1000 newest detections, so
 * "N of M" on a truncated event counts over those.
 *
 * The server's verdict can only add to this: when the snapshot says `annotated` and the
 * bundled mask finds nothing (the server's mask is newer, or the bundle has not loaded), a
 * kind-neutral "server check" sentence appears instead; a `clear` verdict never removes a
 * sentence the bundled mask supports (`eventStaticSourceCaveat` has the rule).
 *
 * A caveat, never a filter: the event, its score and its detections render exactly as
 * before. Without a server `annotated`, nothing renders until the mask has loaded (fetched
 * from our own origin the first time an event is opened), and nothing renders if it fails
 * to load — the absence of a caveat is not a claim that the hotspot is a fire.
 */

import { useEffect } from 'preact/hooks';

import type { FireEvent } from '../../core/types.js';
import { useApp } from '../context.js';
import {
  bundledStaticSourceLookup,
  eventStaticSourceCaveat,
  loadStaticSources,
  staticSourceMask,
} from '../static-sources.js';
import type { DetectionPosition } from './detection-detail.js';

export interface StaticSourceNoteProps {
  readonly event: Pick<FireEvent, 'lon' | 'lat' | 'staticSourceVerdict'>;
  /** The detections' positions; `null` (or empty) falls back to the event's centre. */
  readonly positions?: readonly DetectionPosition[] | null;
}

export function StaticSourceNote({ event, positions = null }: StaticSourceNoteProps) {
  const { messages } = useApp();
  useEffect(() => {
    void loadStaticSources();
  }, []);
  const t = messages.eventDetail;
  const caveat = eventStaticSourceCaveat(
    event.staticSourceVerdict,
    bundledStaticSourceLookup(staticSourceMask.value, event, positions),
  );
  if (caveat === null) return null;
  let text: string;
  switch (caveat.basis) {
    case 'detections':
      text =
        caveat.caveat === 'solar'
          ? t.staticSourceDetectionsSolar(caveat.near, caveat.total)
          : t.staticSourceDetectionsIndustrial(caveat.near, caveat.total);
      break;
    case 'centre':
      text = caveat.caveat === 'solar' ? t.staticSourceSolar : t.staticSourceIndustrial;
      break;
    case 'server':
      text = t.staticSourceServer;
      break;
  }
  return <p class="event-note static-source-note">{text}</p>;
}
