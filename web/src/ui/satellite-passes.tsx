/**
 * The Layers-panel section for F15 satellite passes: per fire-detecting platform, when it
 * last passed over the area and when it is next predicted to, as a Sofia time plus a
 * relative one, with day or night beside it.
 *
 * The area is the selected event when one is open, else the map centre — never the
 * reader's location, which is not asked for. It is coarsened to a 0.5° cell before it
 * leaves the page (`core/passes.ts`). Nothing is fetched while the panel is closed.
 *
 * Every time is labelled a prediction; the copy never says a pass will happen or will
 * detect anything (`passes.note`). Colours are the panel's neutrals and the teal accent —
 * never the red–orange band fire owns (CI-14).
 *
 * Its own component so the panel gains one line, not a block.
 */

import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';

import { DEFAULT_VIEW } from '../core/config.js';
import { formatObservedStampSofia, relativeAgeFrom } from '../core/i18n/format.js';
import {
  PASS_PLATFORM_LABELS,
  lastAndNext,
  passCellFor,
  passesWindowEnded,
  type PassEntry,
  type PassesDoc,
} from '../core/passes.js';
import { useApp } from './context.js';
import { PassCloudCaveat, PassCloudChip, PassCloudCredits } from './pass-cloud.js';
import { layersPanelOpen } from './layers.js';
import { selectedEventIdFrom } from './logic/layout.js';
import { mapViewport } from './map-camera.js';
import { browserPassesLoader, celestrakCredit, ensurePasses, passesStatus } from './passes.js';
import { useNow } from './use-now.js';
import { useStoreState } from './use-store.js';

const TITLE_ID = 'fw-passes-title';

interface Target {
  readonly lat: number;
  readonly lon: number;
  readonly kind: 'event' | 'map-centre';
}

export function SatellitePasses() {
  // `useLocation` outside a router yields an empty object: no path, no selection.
  const { path } = useLocation() as { path?: string };
  if (!layersPanelOpen.value) return null;
  const selectedId = typeof path === 'string' ? selectedEventIdFrom(path) : null;
  return selectedId === null ? <MapCentrePasses /> : <SelectedEventPasses id={selectedId} />;
}

function MapCentrePasses() {
  const view = mapViewport.value ?? DEFAULT_VIEW;
  return <PassesBody target={{ lat: view.lat, lon: view.lon, kind: 'map-centre' }} />;
}

/** Split out so the store is only read while an event is actually selected. */
function SelectedEventPasses({ id }: { readonly id: string }) {
  const { store } = useApp();
  const event = useStoreState(store).events.get(id);
  if (event === undefined) return <MapCentrePasses />;
  return <PassesBody target={{ lat: event.lat, lon: event.lon, kind: 'event' }} />;
}

function PassesBody({ target }: { readonly target: Target }) {
  const { clock, config, messages, serverNow } = useApp();
  const now = useNow(serverNow);
  const cell = passCellFor(target.lat, target.lon);
  useEffect(() => {
    if (cell !== null) ensurePasses(cell, browserPassesLoader(clock, config.passesUrlTemplate));
  }, [cell, clock, config.passesUrlTemplate]);
  const status = passesStatus.value;
  const credit = celestrakCredit(clock, messages);
  const t = messages.passes;

  let body;
  if (cell === null) {
    body = <p class="passes-status">{t.outsideArea}</p>;
  } else if (status.kind === 'ready' && status.cell === cell) {
    body = <PassesTable doc={status.doc} nowMs={now} />;
  } else if (status.kind === 'unavailable' && status.cell === cell) {
    body = <p class="passes-status">{messages.layers.unavailable}</p>;
  } else {
    body = <p class="passes-status">{messages.layers.loading}</p>;
  }

  return (
    <section class="passes" aria-labelledby={TITLE_ID}>
      <h3 id={TITLE_ID} class="passes-title">
        {t.title}
      </h3>
      <p class="passes-note">{t.note}</p>
      <p class="passes-target">{target.kind === 'event' ? t.forEvent : t.forMapCentre}</p>
      <div aria-live="polite">{body}</div>
      {credit !== null ? (
        <p class="passes-credit">
          {credit.href === undefined ? (
            credit.text
          ) : (
            <a href={credit.href} rel="noopener noreferrer">
              {credit.text}
            </a>
          )}
        </p>
      ) : null}
      <PassCloudCredits doc={status.kind === 'ready' && status.cell === cell ? status.doc : null} />
    </section>
  );
}

function PassesTable({ doc, nowMs }: { readonly doc: PassesDoc; readonly nowMs: number }) {
  const { locale, messages } = useApp();
  const t = messages.passes;
  const ended = passesWindowEnded(doc, nowMs);
  const nowIso = new Date(nowMs).toISOString();

  const describe = (pass: PassEntry, relative: string) => (
    <>
      {`${formatObservedStampSofia(pass.culmination, nowMs, locale)} (${relative}) · ${
        pass.daylight === 'day' ? t.day : t.night
      }`}
      <PassCloudChip pct={pass.cloud_forecast_pct} />
    </>
  );

  return (
    <>
      <p class="passes-computed">
        <span class="passes-badge">{t.predicted}</span>{' '}
        {t.computedFor(formatObservedStampSofia(doc.computed_for, nowMs, locale))}
      </p>
      {ended ? <p class="passes-caveat">{t.expired}</p> : null}
      <PassCloudCaveat doc={doc} />
      <ul class="passes-list">
        {doc.platforms.map((platform) => {
          const { last, next } = lastAndNext(platform, nowMs);
          return (
            <li key={platform.id} class="passes-platform" data-platform={platform.id}>
              <span class="passes-name">{PASS_PLATFORM_LABELS[platform.id]}</span>
              {platform.elements === 'missing' ? (
                <p class="passes-caveat">{t.elementsMissing}</p>
              ) : (
                <dl class="passes-times">
                  <dt>{t.lastPass}</dt>
                  <dd>
                    {last === null
                      ? t.none
                      : describe(
                          last,
                          messages.relativeAge(relativeAgeFrom(nowMs, last.culmination)),
                        )}
                  </dd>
                  <dt>{t.nextPass}</dt>
                  <dd>
                    {next !== null
                      ? describe(
                          next,
                          t.inTime(relativeAgeFrom(Date.parse(next.culmination), nowIso)),
                        )
                      : ended
                        ? t.expired
                        : t.none}
                  </dd>
                </dl>
              )}
              {platform.elements === 'stale' ? (
                <p class="passes-caveat">{t.elementsStale}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
