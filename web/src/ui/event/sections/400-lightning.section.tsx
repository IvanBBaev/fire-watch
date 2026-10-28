/** Slot 400: the lightning context note (`lightning-context-note.tsx`). */

import { LightningContextNote } from '../lightning-context-note.js';
import type { EventSectionProps } from './registry.js';

export default function LightningSection({ event }: EventSectionProps) {
  return <LightningContextNote eventId={event.id} />;
}
