/**
 * Slot 800: the V2-E2 before/after comparison, opened on the reader's press: until then
 * nothing is fetched from NASA, and the panel's code and credit line do not exist (CI-12,
 * CI-13). The button stays in place, so closing returns focus to it.
 */

import type { FunctionComponent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { useApp } from '../../context.js';
import type { BeforeAfterProps } from '../before-after.js';
import type { EventSectionProps } from './registry.js';

export default function BeforeAfterSection({ event, nowMs }: EventSectionProps) {
  const { messages } = useApp();
  const [open, setOpen] = useState(false);
  const [Panel, setPanel] = useState<FunctionComponent<BeforeAfterProps> | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setOpen(false);
  }, [event.id]);
  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (Panel !== null) return;
    import('../before-after.js').then(
      (module) => {
        setPanel(() => module.BeforeAfter);
      },
      () => {
        // A failed chunk load leaves the button closed; nothing else depends on the panel.
        setOpen(false);
      },
    );
  };
  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <>
      <p>
        <button
          ref={button}
          type="button"
          class="button-secondary before-after-open"
          aria-expanded={open}
          onClick={toggle}
        >
          {messages.beforeAfter.open}
        </button>
      </p>
      {open && Panel !== null && <Panel event={event} nowMs={nowMs} onClose={close} />}
    </>
  );
}
