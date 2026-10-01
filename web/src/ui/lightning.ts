/**
 * The F18 lightning overlay as the shell reads it: the chosen body, re-classed by age
 * against the server-corrected clock once a minute (`core/lightning.ts`), and the draw the
 * map controller takes. The map pane and the Layers panel read the same hook, so the map
 * and the legend's counts can never disagree about which flashes are how old.
 */

import { useMemo } from 'preact/hooks';

import { CREDITS, renderCredit } from '@fire-watch/contracts';

import type { Messages } from '../core/i18n/messages.js';
import {
  lightningForDisplay,
  type LightningDisplay,
  type LightningDraw,
} from '../core/lightning.js';
import type { Clock } from '../core/ports.js';
import { useApp } from './context.js';
import { lightningOverlayPayload } from './layers.js';
import { creditRenderContext } from './logic/credits.js';
import { useNow } from './use-now.js';

const MINUTE_MS = 60_000;

/** The registry id the lightning layer owes (`eumetsat-meteosat`, EUMETSAT Data Policy Art. 6.3). */
export const LIGHTNING_CREDIT_ID = 'eumetsat-meteosat';

/** The EUMETSAT credit, rendered from the contracts registry exactly as `/credits` renders it. */
export function eumetsatCreditText(
  clock: Pick<Clock, 'epochNow'>,
  messages: Pick<Messages, 'appTitle'>,
): string {
  const credit = CREDITS.find((entry) => entry.id === LIGHTNING_CREDIT_ID);
  return credit === undefined ? '' : renderCredit(credit, creditRenderContext(clock, messages));
}

/** The chosen lightning body as of this minute, or `null` while none is chosen or loaded. */
export function useLightningDisplay(): LightningDisplay | null {
  const { serverNow } = useApp();
  const minute = Math.floor(useNow(serverNow) / MINUTE_MS);
  const body = lightningOverlayPayload.value;
  return useMemo(
    () => (body === null ? null : lightningForDisplay(body, minute * MINUTE_MS)),
    [body, minute],
  );
}

/**
 * What the map draws: the display's flashes with the EUMETSAT credit on the source, or
 * `null` when there is nothing to draw — so the map corner carries the credit exactly while
 * a flash is on screen (CI-13).
 */
export function useLightningDraw(): LightningDraw | null {
  const { clock, messages } = useApp();
  const display = useLightningDisplay();
  return useMemo(
    () =>
      display === null || display.collection.features.length === 0
        ? null
        : { collection: display.collection, attribution: eumetsatCreditText(clock, messages) },
    [display, clock, messages],
  );
}
