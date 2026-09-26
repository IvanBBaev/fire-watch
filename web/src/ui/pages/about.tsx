/**
 * About: capability → limitation → action, layered disclosure (07-product-ux P10/P13).
 * Hosts the #data-freshness anchor the freshness chip's [?] affordance points at, and
 * the attribution rows whose registry condition targets the 'about' surface.
 */

import { creditsFor, renderCredit } from '@fire-watch/contracts';
import { activeCreditConditions, creditRenderContext } from '../logic/credits.js';
import { useApp } from '../context.js';

export function AboutPage() {
  const { messages, clock, config } = useApp();
  const about = messages.about;

  const renderContext = creditRenderContext(clock, messages);
  const aboutCredits = creditsFor('about', activeCreditConditions(config));

  return (
    <article class="page about-page">
      <h1>{about.title}</h1>
      {about.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <p>
        <a class="disclaimer-link" href="/privacy#disclaimer">
          {messages.disclaimer.linkLabel}
        </a>
      </p>
      <h2 id="data-freshness">{about.freshnessExplainerTitle}</h2>
      {about.freshnessExplainerParagraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <section class="about-credits">
        {aboutCredits.map((credit) => (
          <p class="credit-line" key={credit.id}>
            {renderCredit(credit, renderContext)}
          </p>
        ))}
      </section>
    </article>
  );
}
