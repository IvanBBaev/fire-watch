/**
 * Privacy and limits of the service (TASKS I5; review 09 §2.2.A, §3.4, §5; review 05 §5.3).
 *
 * Layered, in reading order: the draft notice, the short summary, the full privacy notice,
 * then the full disclaimer layer under #disclaimer — the anchor the short layers elsewhere
 * (first launch, event panel footer, list, About, Settings) link to.
 *
 * The draft notice comes first because none of this copy has been through legal review: it
 * is all held in `PENDING_FOUNDER_REVIEW`, and `privacy-page.test.tsx` keeps the notice on
 * the page for as long as any of it is.
 *
 * NASA LANCE's disclaimer is not retyped from the catalog. It is the provider's own wording,
 * so it is rendered from the credits registry by id — the same verbatim text `/credits` and
 * the alert footer carry, which CI-13 asserts against the registry.
 */

import { CREDITS, renderCredit } from '@fire-watch/contracts';
import type { Credit } from '@fire-watch/contracts';

import type { PrivacySection } from '../../core/i18n/messages.js';
import { creditRenderContext } from '../logic/credits.js';
import { useApp } from '../context.js';

/** The registry rows that carry NASA LANCE's redistribution disclaimer, in reading order. */
export const LANCE_DISCLAIMER_CREDIT_IDS = ['lance-tactical-disclaimer', 'lance-as-is'] as const;

function lanceDisclaimerCredits(): readonly Credit[] {
  return LANCE_DISCLAIMER_CREDIT_IDS.map((id) => {
    const credit = CREDITS.find((candidate) => candidate.id === id);
    if (credit === undefined) {
      throw new Error(`privacy page: credit "${id}" is missing from the credits registry`);
    }
    return credit;
  });
}

function Section({ id, section }: { readonly id: string; readonly section: PrivacySection }) {
  return (
    <section class="privacy-section" aria-labelledby={id}>
      <h3 id={id}>{section.title}</h3>
      {section.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </section>
  );
}

export function PrivacyPage() {
  const { messages, clock } = useApp();
  const { privacy, disclaimer } = messages;
  const renderContext = creditRenderContext(clock, messages);

  return (
    <article class="page privacy-page">
      <h1>{privacy.title}</h1>
      <p class="privacy-draft-notice" role="note">
        {privacy.draftNotice}
      </p>

      <section class="privacy-summary" aria-labelledby="privacy-summary">
        <h2 id="privacy-summary">{privacy.summaryTitle}</h2>
        {privacy.summary.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </section>

      <section class="privacy-full" aria-labelledby="privacy-full">
        <h2 id="privacy-full">{privacy.fullNoticeTitle}</h2>
        <Section id="privacy-controller" section={privacy.controller} />
        <Section id="privacy-data" section={privacy.data} />
        <Section id="privacy-legal-bases" section={privacy.legalBases} />
        <Section id="privacy-recipients" section={privacy.recipients} />
        <Section id="privacy-sources" section={privacy.sources} />
        <Section id="privacy-transfers" section={privacy.transfers} />
        <Section id="privacy-retention" section={privacy.retention} />
        <Section id="privacy-rights" section={privacy.rights} />
      </section>

      <section class="privacy-disclaimer" aria-labelledby="disclaimer">
        <h2 id="disclaimer">{disclaimer.title}</h2>
        {disclaimer.paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <p>{disclaimer.lanceIntro}</p>
        <blockquote class="lance-disclaimer" lang="en">
          {lanceDisclaimerCredits().map((credit) => (
            <p key={credit.id}>{renderCredit(credit, renderContext)}</p>
          ))}
        </blockquote>
      </section>
    </article>
  );
}
