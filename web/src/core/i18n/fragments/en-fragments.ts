/**
 * Every English i18n fragment, merged for `../en.ts` (V3-P1; conventions in `index.ts`).
 *
 * One import and one spread per fragment, appended; on a rebase conflict keep both sides.
 * `fragments.test.ts` fails if a fragment file on disk is missing here.
 */

import beforeAfter from './before-after.en.js';

export const EN_FRAGMENTS = {
  ...beforeAfter,
};
