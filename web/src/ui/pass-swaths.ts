/**
 * The F15 swath overlay as the shell reads it: the chosen document, re-decided against the
 * server-corrected clock once a minute (`core/pass-swaths.ts`), and the draw the map
 * controller takes. The map pane and the Layers panel read the same hook, so the map and
 * the panel's list can never disagree about which passes are recent or next.
 */

import { useMemo } from 'preact/hooks';

import { formatTimeSofia } from '../core/i18n/format.js';
import { swathsForDisplay, type PassSwathsDraw, type SwathDisplay } from '../core/pass-swaths.js';
import { useApp } from './context.js';
import { passSwathsPayload } from './layers.js';
import { celestrakCredit } from './passes.js';
import { useNow } from './use-now.js';

const MINUTE_MS = 60_000;

/** The chosen swath document as of this minute, or `null` while none is chosen or loaded. */
export function useSwathDisplay(): SwathDisplay | null {
  const { serverNow, locale } = useApp();
  const minute = Math.floor(useNow(serverNow) / MINUTE_MS);
  const doc = passSwathsPayload.value;
  return useMemo(
    () =>
      doc === null
        ? null
        : swathsForDisplay(doc, minute * MINUTE_MS, (iso) => formatTimeSofia(iso, locale)),
    [doc, minute, locale],
  );
}

/**
 * What the map draws: the display's features with the CelesTrak credit on the source, or
 * `null` when there is nothing to draw — so the map corner carries the credit exactly while
 * a swath is on screen (CI-13).
 */
export function useSwathDraw(): PassSwathsDraw | null {
  const { clock, messages } = useApp();
  const display = useSwathDisplay();
  return useMemo(
    () =>
      display === null || display.collection.features.length === 0
        ? null
        : {
            collection: display.collection,
            attribution: celestrakCredit(clock, messages)?.text ?? '',
          },
    [display, clock, messages],
  );
}
