/**
 * Credits: rendered from the frozen attribution registry (`@fire-watch/contracts`) — never
 * retyped, never paraphrased. The registry decides what is owed for the active basemap
 * and layers; this page only renders it.
 */

import { creditsFor, renderCredit } from '@fire-watch/contracts';
import { activeCreditConditions, creditRenderContext } from '../logic/credits.js';
import { useApp } from '../context.js';

export function CreditsPage() {
  const { messages, clock, config } = useApp();

  const renderContext = creditRenderContext(clock, messages);
  const credits = creditsFor('credits-page', activeCreditConditions(config));

  return (
    <article class="page credits-page">
      <h1>{messages.creditsTitle}</h1>
      <ul class="credits-list">
        {credits.map((credit) => (
          <li class="credit-line" key={credit.id}>
            {credit.href !== undefined ? (
              <a href={credit.href} rel="noopener noreferrer">
                {renderCredit(credit, renderContext)}
              </a>
            ) : (
              renderCredit(credit, renderContext)
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}
