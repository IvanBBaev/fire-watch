/** Slot 300: the land-cover note (`land-cover-note.tsx`). */

import { LandCoverNote } from '../land-cover-note.js';
import type { EventSectionProps } from './registry.js';

export default function LandCoverSection({ event, detail }: EventSectionProps) {
  return (
    <LandCoverNote
      event={event}
      positions={detail.kind === 'ready' ? detail.summary.positions : null}
    />
  );
}
