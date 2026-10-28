/**
 * Every Bulgarian i18n fragment, merged for `../bg.ts` (V3-P1; conventions in `index.ts`).
 *
 * One import and one spread per fragment, appended; on a rebase conflict keep both sides.
 * `fragments.test.ts` fails if a fragment file on disk is missing here.
 */

import beforeAfter from './before-after.bg.js';

export const BG_FRAGMENTS = {
  ...beforeAfter,
};
