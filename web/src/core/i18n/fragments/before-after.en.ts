/** English copy for the `beforeAfter` fragment (V2-E2; moved here by V3-P1). */

import type { BeforeAfterMessages } from './before-after.js';

const fragment: { readonly beforeAfter: BeforeAfterMessages } = {
  beforeAfter: {
    open: 'Compare satellite images: before / after',
    close: 'Close comparison',
    title: 'Before / after (satellite)',
    sliderLabel: 'Divider between the before and after images',
    sliderValue: (percent) => `Divider at ${String(percent)}%`,
    beforeLabel: (date) => `Before: ${date}`,
    afterLabel: (date) => `After: ${date}`,
    afterLatestLabel: (date) => `Latest available: ${date}, not after the last detection`,
    beforeEarlier: 'Before image: one day earlier',
    beforeLater: 'Before image: one day later',
    afterEarlier: 'After image: one day earlier',
    afterLater: 'After image: one day later',
    imageLabel: (before, after) =>
      `True-colour satellite images around the event centre: ${before} on the left, ${after} on the right`,
    note:
      'NASA VIIRS daily mosaics, about 375 m per pixel, taken in the early afternoon. Cloud or ' +
      'smoke may hide the ground on either day, and nothing here checks for it. Not a ' +
      'burned-area map.',
    unavailable: "No satellite day before this event's first detection is available yet.",
    tilesFailed: 'Some of the imagery could not be loaded.',
  },
};

export default fragment;
