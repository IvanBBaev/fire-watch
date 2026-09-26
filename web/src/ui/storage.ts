/**
 * localStorage, defensively. Private-mode Safari, storage-disabled WebViews and full
 * quotas all throw; every preference here (theme, onboarding) has a safe default, so a
 * failed read or write degrades to defaults instead of crashing the shell.
 */

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preference will not survive the session — acceptable degradation.
  }
}
