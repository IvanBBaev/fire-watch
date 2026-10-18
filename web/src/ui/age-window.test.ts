/**
 * The time window signal: seeded from storage at import, a valid choice is remembered, an
 * invalid or missing stored value falls back to the default.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGE_WINDOW_STORAGE_KEY, DEFAULT_AGE_WINDOW } from '../core/time/age-filter.js';

function stubStorage(initial: Record<string, string>): Map<string, string> {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    },
  });
  return data;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ageWindow', () => {
  it('defaults when nothing is stored', async () => {
    stubStorage({});
    const { ageWindow } = await import('./age-window.js');
    expect(ageWindow.value).toBe(DEFAULT_AGE_WINDOW);
  });

  it('starts from a valid stored window', async () => {
    stubStorage({ [AGE_WINDOW_STORAGE_KEY]: '6h' });
    const { ageWindow } = await import('./age-window.js');
    expect(ageWindow.value).toBe('6h');
  });

  it('ignores a stored value it does not recognise', async () => {
    stubStorage({ [AGE_WINDOW_STORAGE_KEY]: '7d' });
    const { ageWindow } = await import('./age-window.js');
    expect(ageWindow.value).toBe(DEFAULT_AGE_WINDOW);
  });

  it('setAgeWindow updates the signal and remembers the choice', async () => {
    const data = stubStorage({});
    const { ageWindow, setAgeWindow } = await import('./age-window.js');
    setAgeWindow('1h');
    expect(ageWindow.value).toBe('1h');
    expect(data.get(AGE_WINDOW_STORAGE_KEY)).toBe('1h');
  });

  it('boots without a window at all (storage unreachable)', async () => {
    const { ageWindow } = await import('./age-window.js');
    expect(ageWindow.value).toBe(DEFAULT_AGE_WINDOW);
  });
});
