/**
 * The F17 cloud forecast in the satellite-pass section: a neutral chip per pass
 * ("cloud forecast: partly cloudy, 48%"), the one-line caveat that a fire under cloud may
 * be missed, and the ECMWF credit that is owed while any of it is on screen (CI-13).
 *
 * Neutral on purpose (CI-14): cloud is not fire, and a red–orange "cloudy" would read as
 * danger. The level word is always next to the number, so colour is never the carrier.
 *
 * No cloud raster layer: the per-pass number answers the only question the section asks
 * ("will the next look see the ground?") without a new tile, a new byte budget or a new
 * colour ramp on the map.
 */

import { computed } from '@preact/signals';

import { passCloudLevel, passesCloudShown, type PassCloudLevel } from '../core/pass-cloud.js';
import type { Messages } from '../core/i18n/messages.js';
import type { PassesDoc } from '../core/passes.js';
import { useApp } from './context.js';
import { ecmwfCreditTexts, layersPanelOpen, windChosen } from './layers.js';
import { passesStatus } from './passes.js';

/**
 * Whether forecast cloud is on screen now: the pass section is open and holds a document
 * with cloud values. The credits page reads it to owe the ECMWF credit (`cloudOn`).
 */
export const passesCloudOn = computed(() => {
  const status = passesStatus.value;
  return layersPanelOpen.value && status.kind === 'ready' && passesCloudShown(status.doc.cloud);
});

function levelWord(level: PassCloudLevel, t: Messages['passes']): string {
  if (level === 'clear') return t.cloudClear;
  if (level === 'partly') return t.cloudPartly;
  return t.cloudCloudy;
}

/** One pass's forecast cloud; nothing when the pass has no forecast. */
export function PassCloudChip({ pct }: { readonly pct: number | null }) {
  const { messages } = useApp();
  if (pct === null) return null;
  const level = passCloudLevel(pct);
  return (
    <span class="pass-cloud" data-cloud-level={level}>
      {messages.passes.cloudForecast(levelWord(level, messages.passes), pct)}
    </span>
  );
}

/** The caveat line, shown once above the platforms whenever any pass carries a forecast. */
export function PassCloudCaveat({ doc }: { readonly doc: PassesDoc }) {
  const { messages } = useApp();
  if (!passesCloudShown(doc.cloud)) return null;
  return <p class="passes-caveat pass-cloud-caveat">{messages.passes.cloudCaveat}</p>;
}

/**
 * All five ECMWF components, together (the Terms owe them as a unit) — unless the wind
 * layer is chosen, in which case the panel already prints the same five lines just above
 * this section and a second copy would only repeat them.
 */
export function PassCloudCredits({ doc }: { readonly doc: PassesDoc | null }) {
  const { clock, messages } = useApp();
  if (doc === null || !passesCloudShown(doc.cloud) || windChosen.value) return null;
  return (
    <>
      {ecmwfCreditTexts(clock, messages).map((text) => (
        <p key={text} class="passes-credit pass-cloud-credit">
          {text}
        </p>
      ))}
    </>
  );
}
