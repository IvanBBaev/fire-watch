import { describe, expect, it } from 'vitest';

import {
  ONBOARDING_DONE_VALUE,
  ONBOARDING_STORAGE_KEY,
  shouldShowOnboarding,
} from './onboarding.js';

describe('shouldShowOnboarding', () => {
  it('shows on first visit (nothing stored)', () => {
    expect(shouldShowOnboarding(null)).toBe(true);
  });

  it('hides once the done marker is stored', () => {
    expect(shouldShowOnboarding(ONBOARDING_DONE_VALUE)).toBe(false);
  });

  it('shows again for any value that is not the exact done marker', () => {
    expect(shouldShowOnboarding('')).toBe(true);
    expect(shouldShowOnboarding('0')).toBe(true);
    expect(shouldShowOnboarding('true')).toBe(true);
    expect(shouldShowOnboarding(' 1')).toBe(true);
  });

  it('keys are stable — changing them silently re-onboards every user', () => {
    expect(ONBOARDING_STORAGE_KEY).toBe('fw:onboarded');
    expect(ONBOARDING_DONE_VALUE).toBe('1');
  });
});
