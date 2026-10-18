/**
 * `readStorage` / `writeStorage` degrade instead of throwing: private-mode Safari,
 * storage-disabled WebViews and full quotas all raise, and the shell must still boot.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readStorage, writeStorage } from './storage.js';

function stubStorage(storage: Partial<Storage>): void {
  vi.stubGlobal('window', { localStorage: storage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storage', () => {
  it('round-trips a value through localStorage', () => {
    const data = new Map<string, string>();
    stubStorage({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
    });
    writeStorage('k', 'v');
    expect(readStorage('k')).toBe('v');
  });

  it('reads null for a key that was never written', () => {
    stubStorage({ getItem: () => null });
    expect(readStorage('missing')).toBeNull();
  });

  it('reads null when localStorage throws', () => {
    stubStorage({
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(readStorage('k')).toBeNull();
  });

  it('swallows a write that throws (quota exceeded)', () => {
    stubStorage({
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    expect(() => writeStorage('k', 'v')).not.toThrow();
  });

  it('degrades when the localStorage accessor itself throws', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(readStorage('k')).toBeNull();
    expect(() => writeStorage('k', 'v')).not.toThrow();
  });
});
