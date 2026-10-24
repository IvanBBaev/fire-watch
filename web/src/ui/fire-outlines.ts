/**
 * V2-A4 estimated outlines as the shell reads them: the draw the map controller takes, and
 * the FIRMS credit it carries. The outlines are drawn from FIRMS detections, so the credit
 * they owe is the FIRMS acknowledgement, rendered from the contracts registry exactly as
 * `/credits` renders it.
 */

import { useMemo } from 'preact/hooks';

import { CREDITS, renderCredit } from '@fire-watch/contracts';

import type { FireOutlineDraw } from '../core/fire-outlines.js';
import type { Messages } from '../core/i18n/messages.js';
import type { Clock } from '../core/ports.js';
import { useApp } from './context.js';
import { fireOutlinesPayload } from './layers.js';
import { creditRenderContext } from './logic/credits.js';

/** The registry id the outlines owe: they are drawn from FIRMS detections. */
export const FIRE_OUTLINE_CREDIT_ID = 'firms-acknowledgement';

/** The FIRMS acknowledgement, rendered from the contracts registry. */
export function firmsCreditText(
  clock: Pick<Clock, 'epochNow'>,
  messages: Pick<Messages, 'appTitle'>,
): string {
  const credit = CREDITS.find((entry) => entry.id === FIRE_OUTLINE_CREDIT_ID);
  return credit === undefined ? '' : renderCredit(credit, creditRenderContext(clock, messages));
}

/**
 * What the map draws: the chosen outlines with the FIRMS credit on the source, or `null`
 * when none is chosen, loaded, or present — so the map corner carries the credit exactly
 * while an outline is on screen (CI-13).
 */
export function useFireOutlineDraw(): FireOutlineDraw | null {
  const { clock, messages } = useApp();
  const body = fireOutlinesPayload.value;
  return useMemo(
    () =>
      body === null || body.features.length === 0
        ? null
        : {
            collection: { type: 'FeatureCollection', features: body.features },
            attribution: firmsCreditText(clock, messages),
          },
    [body, clock, messages],
  );
}
