/**
 * Onboarding gate decision (07-product-ux P7): the three-card intro shows exactly once.
 * Storage access lives in the component; this module owns the decision so the "what
 * counts as onboarded" rule is testable without a DOM.
 */

export const ONBOARDING_STORAGE_KEY = 'fw:onboarded';

export const ONBOARDING_DONE_VALUE = '1';

/**
 * Show the cards unless the exact done-marker is present. Any other value (missing,
 * empty, a stray '0' from an older build) shows them again — the cards are skippable,
 * so over-showing is the cheap failure direction.
 */
export function shouldShowOnboarding(storedValue: string | null): boolean {
  return storedValue !== ONBOARDING_DONE_VALUE;
}
