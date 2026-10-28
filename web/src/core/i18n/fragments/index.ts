/**
 * Per-feature i18n catalog fragments (V3-P1).
 *
 * A feature that brings its own copy does not edit `messages.ts`, `en.ts` or `bg.ts`. It adds
 * three files here, named after its namespace in kebab case:
 *
 * - `<name>.ts` — the namespace's interface. It must not import `../messages.js` (that would
 *   close a type cycle through {@link FragmentMessages}).
 * - `<name>.en.ts`, `<name>.bg.ts` — a default export `{ <namespace>: { … } }` typed with
 *   that interface.
 *
 * and appends one line to each of three lists: {@link FragmentMessages} below (the
 * namespace's key in `Messages`, which extends it), `en-fragments.ts` and `bg-fragments.ts`.
 * On a rebase conflict in any of them, keep both sides. Every consumer keeps reading
 * `messages.<namespace>`. The locale catalog spreads the merged fragments
 * after its own keys, so the merge happens at build time inside the locale's lazy chunk
 * (CI-12 `locale` role) — there is no runtime loader and nothing reaches the entry chunk.
 *
 * What still guards the copy is unchanged: the governance record, the render arguments and
 * `PENDING_FOUNDER_REVIEW` (and its test) are total over the merged `Messages`, so a fragment
 * namespace has to be classified there exactly like a core one. `fragments.test.ts` checks
 * the merge itself: a type module and both locales per fragment, one namespace per fragment
 * named after its file, and every fragment spread into its locale unchanged.
 *
 * This module is type-only; it emits nothing.
 */

import type { BeforeAfterMessages } from './before-after.js';

/**
 * The fragment namespaces' part of `Messages` (`interface Messages extends FragmentMessages`).
 * One key per fragment, appended.
 */
export interface FragmentMessages {
  /** V2-E2 — the before/after satellite comparison. */
  readonly beforeAfter: BeforeAfterMessages;
}
