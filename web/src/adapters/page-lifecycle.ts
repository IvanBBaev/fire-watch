/**
 * Page visibility and connectivity behind the {@link PageLifecycle} port (ADR-003 D3:
 * "tab wake and `online` events force a snapshot refetch before trusting any
 * transport"). `onWake` fires on the hidden → visible transition only; the `hidden`
 * side of `visibilitychange` is nobody's cue to fetch anything.
 */

import type { PageLifecycle } from '../core/ports.js';

export function createBrowserPageLifecycle(): PageLifecycle {
  return {
    onWake(callback) {
      const listener = (): void => {
        if (document.visibilityState === 'visible') callback();
      };
      document.addEventListener('visibilitychange', listener);
      return () => {
        document.removeEventListener('visibilitychange', listener);
      };
    },
    onOnline(callback) {
      const listener = (): void => {
        callback();
      };
      window.addEventListener('online', listener);
      return () => {
        window.removeEventListener('online', listener);
      };
    },
  };
}
