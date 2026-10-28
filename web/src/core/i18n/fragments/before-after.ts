/**
 * The `beforeAfter` namespace's type: an i18n fragment (V3-P1, conventions in `index.ts`).
 * `FragmentMessages` adds it to `Messages`, so every consumer still reads
 * `messages.beforeAfter` and both locale catalogs fail to compile without it.
 */

/**
 * V2-E2: the before/after satellite comparison on an event page (NASA GIBS true colour).
 * Own voice; every key is implementer copy held in `PENDING_FOUNDER_REVIEW`. Dates are
 * pre-worded (`formatDateSofia`); no label may call either image cloud-free.
 */
export interface BeforeAfterMessages {
  readonly open: string;
  readonly close: string;
  readonly title: string;
  readonly sliderLabel: string;
  /** The slider's spoken value; `percent` is the divider position, 0–100. */
  readonly sliderValue: (percent: number) => string;
  readonly beforeLabel: (date: string) => string;
  readonly afterLabel: (date: string) => string;
  /** "After" is the newest day available and not after the last detection (active event). */
  readonly afterLatestLabel: (date: string) => string;
  readonly beforeEarlier: string;
  readonly beforeLater: string;
  readonly afterEarlier: string;
  readonly afterLater: string;
  /** The comparison's accessible name; both dates pre-worded. */
  readonly imageLabel: (before: string, after: string) => string;
  /** What the imagery is and is not: resolution, cloud and smoke, not a burned-area map. */
  readonly note: string;
  readonly unavailable: string;
  readonly tilesFailed: string;
}
