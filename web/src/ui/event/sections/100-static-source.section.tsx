/** Slot 100: the F16 known-heat-source caveat (`static-source-note.tsx`). */

import { StaticSourceNote } from '../static-source-note.js';
import type { EventSectionProps } from './registry.js';

export default function StaticSourceSection({ event, detail }: EventSectionProps) {
  return (
    <StaticSourceNote
      event={event}
      positions={detail.kind === 'ready' ? detail.summary.positions : null}
    />
  );
}
