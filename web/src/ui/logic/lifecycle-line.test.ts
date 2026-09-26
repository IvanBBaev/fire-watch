/**
 * The lifecycle line's two clocks: the event page may shorten an active event's stamp to
 * a bare time while it is still today in Sofia; the share card never does (07 §5.2.2).
 */

import { describe, expect, it } from 'vitest';

import en from '../../core/i18n/en.js';
import type { FireEvent } from '../../core/types.js';
import { lifecycleLine } from './lifecycle-line.js';

const EVENT: FireEvent = {
  id: 'fw-2026-q7f3d',
  seq: 4,
  status: 'active',
  scoreBucket: 'likely',
  mergedInto: null,
  lon: 25.9,
  lat: 41.9,
  firstObservedAt: '2026-08-09T08:02:00Z',
  // 14:14 in Sofia (EEST, UTC+3).
  lastObservedAt: '2026-08-09T11:14:00Z',
  detectionCount: 7,
  placeNameBg: 'Сакар',
  placeNameEn: 'Sakar',
  areaHa: null,
  nextPassWindow: null,
};

/** Later the same Sofia day. */
const SAME_DAY_MS = Date.parse('2026-08-09T13:00:00Z');

describe('lifecycleLine', () => {
  it('shows a bare time on the page while the observation is still today', () => {
    expect(lifecycleLine(EVENT, en, 'en', SAME_DAY_MS)).toBe(en.lifecycle.active('14:14'));
    expect(lifecycleLine(EVENT, en, 'en', SAME_DAY_MS, 'page')).toBe(en.lifecycle.active('14:14'));
  });

  it('always shows the full Sofia date and time on the card', () => {
    expect(lifecycleLine(EVENT, en, 'en', SAME_DAY_MS, 'card')).toBe(
      en.lifecycle.active('09/08/2026, 14:14'),
    );
  });

  it('does not depend on the clock for states whose stamp is already absolute', () => {
    const ended: FireEvent = { ...EVENT, status: 'no_longer_detected' };

    expect(lifecycleLine(ended, en, 'en', SAME_DAY_MS, 'card')).toBe(
      lifecycleLine(ended, en, 'en', SAME_DAY_MS, 'page'),
    );
    expect(lifecycleLine(ended, en, 'en', SAME_DAY_MS, 'card')).toBe(
      en.lifecycle.noLongerDetected('09/08/2026, 14:14'),
    );
  });
});
