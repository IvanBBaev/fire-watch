/**
 * The accessibility statement (TASKS L16; GATES.md §3 L-16; review 19 §5.10.1, review 09
 * §4.3).
 *
 * In reading order: the draft notice, the date line, the target, what the statement
 * covers (review 19 §5.2's three scope classes), the alternative to the map, the known
 * gaps, how the service is tested, the legal position and how to report a barrier. Review
 * 19 §5.10.1 lists those contents; their order puts what a reader can *do* (use the list)
 * ahead of what the operator *owes* (the legal position).
 *
 * The draft notice comes first for the same reason as on the privacy page: every string is
 * held in `PENDING_FOUNDER_REVIEW`, the WCAG version is an open founder decision and the
 * manual assistive-technology pass (docs/accessibility/manual-pass.md) has not been run.
 * `accessibility-page.test.tsx` keeps the notice on the page for as long as any of the
 * copy is pending.
 *
 * The page is itself in scope (Appendix A), so the CI-18 sweep and the axe-core sweep in
 * `e2e/a11y.e2e.ts` both visit it.
 */

import type { PrivacySection } from '../../core/i18n/messages.js';
import { useApp } from '../context.js';

function Section({ id, section }: { readonly id: string; readonly section: PrivacySection }) {
  return (
    <section class="accessibility-section" aria-labelledby={id}>
      <h2 id={id}>{section.title}</h2>
      {section.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </section>
  );
}

export function AccessibilityPage() {
  const { accessibility } = useApp().messages;

  return (
    <article class="page accessibility-page">
      <h1>{accessibility.title}</h1>
      <p class="accessibility-draft-notice" role="note">
        {accessibility.draftNotice}
      </p>
      <p class="accessibility-dated">{accessibility.dated}</p>
      <Section id="accessibility-target" section={accessibility.target} />
      <Section id="accessibility-scope" section={accessibility.scope} />
      <Section id="accessibility-alternative" section={accessibility.alternative} />
      <Section id="accessibility-known-gaps" section={accessibility.knownGaps} />
      <Section id="accessibility-testing" section={accessibility.testing} />
      <Section id="accessibility-legal" section={accessibility.legal} />
      <Section id="accessibility-contact" section={accessibility.contact} />
    </article>
  );
}
