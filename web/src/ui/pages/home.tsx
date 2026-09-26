/**
 * Home: the list side of the map+list pair (07-product-ux P10). The map itself belongs to
 * the shell, which keeps it alive across routes — Home is what sits *next to* it, and on a
 * phone what slides up over it. The list renders immediately and never waits on the map
 * chunk. The onboarding gate overlays Home on first visit only.
 */

import { useState } from 'preact/hooks';

import { EventList } from '../event-list.js';
import {
  ONBOARDING_DONE_VALUE,
  ONBOARDING_STORAGE_KEY,
  shouldShowOnboarding,
} from '../logic/onboarding.js';
import { Onboarding } from '../onboarding.js';
import { readStorage, writeStorage } from '../storage.js';
import { useApp } from '../context.js';

export function HomePage() {
  const { messages } = useApp();
  // Follow the frame by default: the map is the thing being looked at, and a list of
  // fires three provinces away is not an answer to "what is in front of me?".
  const [inViewOnly, setInViewOnly] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(() =>
    shouldShowOnboarding(readStorage(ONBOARDING_STORAGE_KEY)),
  );

  const dismissOnboarding = (): void => {
    writeStorage(ONBOARDING_STORAGE_KEY, ONBOARDING_DONE_VALUE);
    setShowOnboarding(false);
  };

  return (
    <div class="home-list" aria-label={messages.nav.list} aria-live="polite">
      <EventList inViewOnly={inViewOnly} onToggleInViewOnly={setInViewOnly} />
      {/* The standing answer to "which areas do you watch?" — stated where the list can
          be read as a complete picture of a region, because it is not one. */}
      <p class="coverage-note">{messages.mapControls.coverageNote}</p>
      {/* The list is where the map is read as a picture of a region, so the way to the
          limits of that picture — and to the privacy notice — stays one tap away (TASKS I5). */}
      <p class="list-footer">
        <a class="disclaimer-link" href="/privacy">
          {messages.disclaimer.linkLabel}
        </a>
      </p>
      {showOnboarding && <Onboarding onDone={dismissOnboarding} />}
    </div>
  );
}
