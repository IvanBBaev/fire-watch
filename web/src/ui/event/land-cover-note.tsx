/**
 * V2-F4 on an event: "Land cover (ESA WorldCover 2021): forest 60%, grassland 30%." `core/geo/land-cover.ts` has the rule — the mean over the distinct
 * 0.02° cells the detections fall in, rounded to tens — and builds the sentence.
 *
 * Per detection whenever the detections file gave positions, the event's centre otherwise
 * (while the file loads, and when there is none). Context, not a claim about what burns:
 * WorldCover is a 2021 snapshot and a 2 km cell mixes in the land around a fire. Nothing
 * renders until the grid has loaded (fetched from our own origin the first time an event
 * is opened), if it fails to load, or over open sea where the grid has no data.
 */

import { useEffect } from 'preact/hooks';

import type { FireEvent } from '../../core/types.js';
import { useApp } from '../context.js';
import { landCoverSentence, loadLandCover } from '../land-cover.js';
import type { DetectionPosition } from './detection-detail.js';

export interface LandCoverNoteProps {
  readonly event: Pick<FireEvent, 'lon' | 'lat'>;
  /** The detections' positions; `null` (or empty) falls back to the event's centre. */
  readonly positions?: readonly DetectionPosition[] | null;
}

export function LandCoverNote({ event, positions = null }: LandCoverNoteProps) {
  const { messages } = useApp();
  useEffect(() => {
    void loadLandCover();
  }, []);
  const text = landCoverSentence.value?.(
    positions?.length ? positions : [event],
    messages.eventDetail,
  );
  return text ? <p class="event-note land-cover-note">{text}</p> : null;
}
