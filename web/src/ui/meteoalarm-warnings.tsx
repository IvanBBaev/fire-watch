/**
 * Where the V2-B3 official-warnings section mounts in the Layers panel.
 *
 * The markup and the document parser live in their own chunk (`meteoalarm-view.tsx`),
 * fetched the first time the panel opens, so they add nothing to the critical path
 * (CI-12). This shell half holds only the state, the fetch and the credit; once the chunk
 * is in, it asks for the document and hands everything to the view. Until the chunk
 * arrives — or if it never does, for an offline or blocked reader — the slot renders
 * nothing, and the panel's other sections do not depend on it. Nothing is fetched while
 * the panel is closed.
 */

import { signal } from '@preact/signals';
import { Fragment, h } from 'preact';
import { useEffect } from 'preact/hooks';

import { formatObservedStampSofia } from '../core/i18n/format.js';
import { useApp } from './context.js';
import { layersPanelOpen } from './layers.js';
import { ensureMeteoalarm, meteoalarmCredit, meteoalarmStatus } from './meteoalarm.js';
import type * as ViewModuleNamespace from './meteoalarm-view.js';
import { useNow } from './use-now.js';

type ViewModule = typeof ViewModuleNamespace;

interface LoadedView {
  readonly load: ViewModule['fetchMeteoalarmDocument'];
  readonly View: ReturnType<ViewModule['createMeteoalarmView']>;
}

/** Builds the section's components over this shell's Preact (see `meteoalarm-view.tsx`). */
function adopt(module: ViewModule): LoadedView {
  return { load: module.fetchMeteoalarmDocument, View: module.createMeteoalarmView(h, Fragment) };
}

const viewModule = signal<LoadedView | null>(null);

/**
 * Ask for the chunk. A chunk that will not arrive leaves the slot empty; the next opening of
 * the panel mounts the section again and so asks again.
 */
function requestView(): void {
  void import('./meteoalarm-view.js').then(
    (module) => {
      viewModule.value = adopt(module);
    },
    () => {},
  );
}

export function MeteoalarmWarnings() {
  if (!layersPanelOpen.value) return null;
  return <MeteoalarmBody />;
}

function MeteoalarmBody() {
  const { clock, config, locale, messages, serverNow } = useApp();
  const now = useNow(serverNow);
  const url = config.meteoalarmUrl;
  const view = viewModule.value;
  useEffect(() => {
    if (url === undefined) return;
    if (view === null) requestView();
    else ensureMeteoalarm({ load: view.load, now: () => clock.monotonicNow(), url });
  }, [clock, url, view]);
  if (url === undefined || view === null) return null;
  return (
    <view.View
      status={meteoalarmStatus.value}
      messages={messages}
      locale={locale}
      stamp={(iso) => formatObservedStampSofia(iso, now, locale)}
      credit={meteoalarmCredit(clock, messages)}
    />
  );
}

/** Test seam: render as if the chunk had already arrived. */
export function setMeteoalarmViewForTest(module: ViewModule | null): void {
  viewModule.value = module === null ? null : adopt(module);
}
