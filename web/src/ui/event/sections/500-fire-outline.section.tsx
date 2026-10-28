/** Slot 500: the V2-A4 estimated-outline note (`fire-outline-note.tsx`). */

import { FireOutlineNote } from '../fire-outline-note.js';
import type { EventSectionProps } from './registry.js';

export default function FireOutlineSection({ event }: EventSectionProps) {
  return <FireOutlineNote eventId={event.id} />;
}
