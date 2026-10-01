/**
 * Page visibility and the document title, behind the {@link PageVisibility} port the
 * new-signal counter uses (TASKS F, "new since you last looked"). `pagehide` counts as
 * hidden too, so closing or reloading the tab records the visit like switching away does.
 */

import type { PageVisibility } from '../ui/new-signals.js';

export function createBrowserPageVisibility(): PageVisibility {
  return {
    isHidden: () => document.visibilityState === 'hidden',
    onChange(callback) {
      const onVisibility = (): void => {
        callback(document.visibilityState === 'hidden');
      };
      const onPageHide = (): void => {
        callback(true);
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', onPageHide);
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
      };
    },
    readTitle: () => document.title,
    writeTitle(title) {
      if (document.title !== title) document.title = title;
    },
  };
}
