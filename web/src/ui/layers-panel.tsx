/**
 * The Layers panel (TASKS G4): a disclosure button among the map controls and the panel it
 * opens — the basemap choice, the EFFIS context overlays, the FWI legend and the EFFIS
 * credit.
 *
 * Two components because they live in two places: the button sits in the controls' button
 * row (after Home and Locate, whose positions tests and the a11y suite rely on), the panel
 * below the row. Both read the same `layersPanelOpen` signal. The panel is always in the
 * DOM, `hidden` when closed, so `aria-controls` never points at nothing.
 *
 * Every date shown is the data's own: FWI says which day the index is *for* (and says so
 * when that is not today in Sofia), burnt areas say when EFFIS made the copy available.
 * Neither ever shows the time we fetched it — that would make a week-old copy look fresh.
 */

import { formatDateSofia, formatShortDateTimeSofia, formatTimeSofia } from '../core/i18n/format.js';
import type { Messages } from '../core/i18n/messages.js';
import type { Locale } from '../core/types.js';
import { WIND_SPEED_CLASSES, type WindOverlayBody } from '../core/wind.js';
import { useApp } from './context.js';
import { BasemapChoice } from './imagery-toggle.js';
import { SwathLegend } from './pass-swaths-option.js';
import { LightningLegend } from './lightning-legend.js';
import { eumetsatCreditText } from './lightning.js';
import { celestrakCredit } from './passes.js';
import { SatellitePasses } from './satellite-passes.js';
import { ProtectedSitesOption } from './protected-sites-option.js';
import { StaticSourcesOption } from './static-sources-option.js';
import {
  FWI_CLASSES,
  type OverlayId,
  type OverlayStatus,
  OVERLAY_IDS,
  chosenOverlays,
  effisChosen,
  effisCreditText,
  ecmwfCreditTexts,
  layersPanelOpen,
  lightningChosen,
  overlayStatus,
  setLayersPanelOpen,
  swathsChosen,
  toggleOverlay,
  windChosen,
  windOverlayPayload,
} from './layers.js';

export const LAYERS_PANEL_ID = 'fw-layers-panel';

export function LayersToggle() {
  const { messages } = useApp();
  const open = layersPanelOpen.value;
  return (
    <button
      type="button"
      class="map-control"
      aria-expanded={open}
      aria-controls={LAYERS_PANEL_ID}
      onClick={() => {
        setLayersPanelOpen(!open);
      }}
    >
      {messages.layers.toggle}
    </button>
  );
}

function statusLines(
  id: OverlayId,
  status: OverlayStatus,
  messages: Messages,
  locale: Locale,
  todayIso: string,
): readonly string[] {
  switch (status.kind) {
    case 'idle':
      return [];
    case 'loading':
      return [messages.layers.loading];
    case 'unavailable':
      return [messages.layers.unavailable];
    case 'ready': {
      if (id === 'wind') {
        const body = windOverlayPayload.value;
        return body === null ? [] : [windValidLine(body, messages, locale, todayIso)];
      }
      // F15: a prediction says when it was computed for, never when we fetched it.
      if (id === 'swaths') {
        return [messages.passes.computedFor(formatShortDateTimeSofia(status.availableAt, locale))];
      }
      // F18: flashes are "as of" the end of the newest product merged, never the fetch.
      if (id === 'lightning' && status.validAt !== undefined) {
        const sameDay =
          formatDateSofia(status.validAt, locale) === formatDateSofia(todayIso, locale);
        const time = sameDay
          ? formatTimeSofia(status.validAt, locale)
          : formatShortDateTimeSofia(status.validAt, locale);
        return [messages.layers.lightningAsOf(time)];
      }
      const lines: string[] = [];
      if (id === 'fwi' && status.validFor !== null) {
        const validFor = formatDateSofia(status.validFor, locale);
        lines.push(messages.layers.fwiValidFor(validFor));
        if (validFor !== formatDateSofia(todayIso, locale)) lines.push(messages.layers.fwiNotToday);
      } else {
        lines.push(messages.layers.copyDated(formatShortDateTimeSofia(status.availableAt, locale)));
      }
      if (status.state === 'suspect') lines.push(messages.layers.suspect);
      return lines;
    }
  }
}

function FwiLegend({ messages }: { readonly messages: Messages }) {
  const titleId = `${LAYERS_PANEL_ID}-fwi-legend`;
  return (
    <div class="layers-legend">
      <p id={titleId} class="layers-legend-title">
        {messages.layers.fwiLegendTitle}
      </p>
      <ul aria-labelledby={titleId}>
        {FWI_CLASSES.map((entry, index) => (
          <li key={entry.color}>
            <span
              class="layers-swatch"
              style={{ backgroundColor: entry.color }}
              aria-hidden="true"
            />
            {messages.layers.fwiClasses[index] ?? ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * F14: the hour the arrows are *for* and the model run, both from the body. The hour alone
 * when it is today in Sofia; with its date otherwise (a step near midnight).
 */
export function windValidLine(
  body: WindOverlayBody,
  messages: Messages,
  locale: Locale,
  todayIso: string,
): string {
  const sameDay = formatDateSofia(body.valid_at, locale) === formatDateSofia(todayIso, locale);
  const time = sameDay
    ? formatTimeSofia(body.valid_at, locale)
    : formatShortDateTimeSofia(body.valid_at, locale);
  return messages.layers.windValidFor(time, formatShortDateTimeSofia(body.run_at, locale));
}

function WindLegend({ messages }: { readonly messages: Messages }) {
  const titleId = `${LAYERS_PANEL_ID}-wind-legend`;
  return (
    <div class="layers-legend">
      <p id={titleId} class="layers-legend-title">
        {messages.layers.windLegendTitle}
      </p>
      <ul aria-labelledby={titleId}>
        {WIND_SPEED_CLASSES.map((entry, index) => (
          <li key={entry.color}>
            <span
              class="layers-swatch"
              style={{ backgroundColor: entry.color }}
              aria-hidden="true"
            />
            {messages.layers.windClasses[index] ?? ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

const OVERLAY_LABEL = {
  fwi: 'fwi',
  ba: 'ba',
  wind: 'wind',
  swaths: 'swaths',
  lightning: 'lightning',
} as const;
const OVERLAY_NOTE = {
  fwi: 'fwiNote',
  ba: 'baNote',
  wind: 'windNote',
  swaths: 'swathsNote',
  lightning: 'lightningNote',
} as const;

export function LayersPanel() {
  const { messages, locale, clock, serverNow } = useApp();
  const open = layersPanelOpen.value;
  const chosen = chosenOverlays.value;
  const statuses = overlayStatus.value;
  // "Today" is a staleness read, so server-corrected (ADR-003 A1.6); new Date(ms) is a
  // pure conversion, no wall-clock read.
  const todayIso = new Date(serverNow()).toISOString();
  return (
    <section
      id={LAYERS_PANEL_ID}
      class="layers-panel"
      aria-label={messages.layers.panelLabel}
      hidden={!open}
    >
      <BasemapChoice />
      <fieldset class="layers-group">
        <legend class="layers-group-title">{messages.layers.overlaysTitle}</legend>
        {OVERLAY_IDS.map((id) => {
          const on = chosen.includes(id);
          const noteId = `${LAYERS_PANEL_ID}-${id}-note`;
          return (
            <div key={id} class="layers-overlay">
              <label class="layers-option">
                <input
                  type="checkbox"
                  checked={on}
                  aria-describedby={noteId}
                  onChange={() => {
                    toggleOverlay(id);
                  }}
                />
                <span>{messages.layers[OVERLAY_LABEL[id]]}</span>
              </label>
              <p id={noteId} class="layers-note">
                {messages.layers[OVERLAY_NOTE[id]]}
              </p>
              {on && id === 'fwi' ? <FwiLegend messages={messages} /> : null}
              {on && id === 'wind' ? <WindLegend messages={messages} /> : null}
              {on && id === 'swaths' ? <SwathLegend /> : null}
              {on && id === 'lightning' ? <LightningLegend /> : null}
              <p class="layers-status" aria-live="polite">
                {on
                  ? statusLines(id, statuses[id], messages, locale, todayIso).map((line) => (
                      <span key={line}>{line}</span>
                    ))
                  : null}
              </p>
            </div>
          );
        })}
        <StaticSourcesOption />
        <ProtectedSitesOption />
      </fieldset>
      {effisChosen.value ? <p class="layers-credit">{effisCreditText(clock, messages)}</p> : null}
      {/* F14: all five ECMWF components together, or none (the Terms owe them as a unit). */}
      {windChosen.value
        ? ecmwfCreditTexts(clock, messages).map((text) => (
            <p key={text} class="layers-credit">
              {text}
            </p>
          ))
        : null}
      {/* F15: the orbital elements behind the swaths are CelesTrak's (CI-13). */}
      {swathsChosen.value ? (
        <p class="layers-credit">{celestrakCredit(clock, messages)?.text}</p>
      ) : null}
      {/* F18: EUMETSAT Data Policy Art. 6.3 — the credit while the layer is on (CI-13). */}
      {lightningChosen.value ? (
        <p class="layers-credit">{eumetsatCreditText(clock, messages)}</p>
      ) : null}
      <SatellitePasses />
    </section>
  );
}
