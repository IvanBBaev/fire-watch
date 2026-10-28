/** Slot 200: the protected-site note (`protected-site-note.tsx`). */

import { ProtectedSiteNote } from '../protected-site-note.js';
import type { EventSectionProps } from './registry.js';

export default function ProtectedSiteSection({ event, detail }: EventSectionProps) {
  return (
    <ProtectedSiteNote
      event={event}
      positions={detail.kind === 'ready' ? detail.summary.positions : null}
    />
  );
}
