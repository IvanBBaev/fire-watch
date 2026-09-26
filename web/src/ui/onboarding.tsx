/**
 * First-launch onboarding (07-product-ux P7, P13): exactly three cards and one button,
 * shown once, skippable, no permission prompts. Rendered as a gate over Home; the
 * backdrop click and the button both dismiss — over-explaining must never trap anyone
 * during a fire.
 */

import { useApp } from './context.js';

export function Onboarding({ onDone }: { readonly onDone: () => void }) {
  const { messages } = useApp();
  const onboarding = messages.onboarding;
  return (
    <div
      class="onboarding-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={messages.appTitle}
      onClick={onDone}
    >
      <div
        class="onboarding-cards"
        onClick={(clickEvent) => {
          clickEvent.stopPropagation();
        }}
      >
        <section class="onboarding-card">
          <h2>{onboarding.card1Title}</h2>
          <p>{onboarding.card1Body}</p>
        </section>
        <section class="onboarding-card">
          <h2>{onboarding.card2Title}</h2>
          <p>{onboarding.card2Body}</p>
        </section>
        <section class="onboarding-card">
          <h2>{onboarding.card3Title}</h2>
          <p>{onboarding.card3Body}</p>
          {/* The first-run short layer links to the full disclaimer (TASKS I5). Following
              it counts as having seen the cards: the reader chose to read further. The
              cards stop click propagation, so the router never sees this click and the
              browser loads the page itself, which also lands it on the #disclaimer anchor. */}
          <a class="disclaimer-link" href="/privacy#disclaimer" onClick={onDone}>
            {messages.disclaimer.linkLabel}
          </a>
        </section>
        <button type="button" class="button-primary" onClick={onDone}>
          {onboarding.showTheMap}
        </button>
      </div>
    </div>
  );
}
