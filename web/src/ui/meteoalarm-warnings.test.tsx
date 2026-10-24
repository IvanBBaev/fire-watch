/**
 * V2-B3, web half: the warnings loader's state machine and the Layers-panel section's
 * markup. The loader runs against a fake `fetch`; the section renders the fixture document.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import { parseMeteoalarmDocument, type MeteoalarmDoc } from '../core/meteoalarm.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext, type AppServices } from './context.js';
import { setLayersPanelOpen } from './layers.js';
import {
  METEOALARM_REFETCH_AFTER_MS,
  type MeteoalarmLoaderDeps,
  ensureMeteoalarm,
  loadMeteoalarm,
  meteoalarmCredit,
  meteoalarmStatus,
  resetMeteoalarmForTest,
} from './meteoalarm.js';
import * as view from './meteoalarm-view.js';
import { MeteoalarmWarnings, setMeteoalarmViewForTest } from './meteoalarm-warnings.js';

const FIXTURE_TEXT = readFileSync(
  fileURLToPath(new URL('../../public/fixtures/meteoalarm/warnings.json', import.meta.url)),
  'utf8',
);
const DOC = parseMeteoalarmDocument(JSON.parse(FIXTURE_TEXT)) as MeteoalarmDoc;
const NOW = Date.parse(DOC.generated_at);
const URL_UNDER_TEST = '/overlays/meteoalarm/warnings.json';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeDeps extends MeteoalarmLoaderDeps {
  readonly requested: string[];
  clockMs: number;
}

function fakeDeps(answer: (url: string) => Response | Promise<Response>): FakeDeps {
  const deps: FakeDeps = {
    requested: [],
    clockMs: 1_000,
    load: (url) =>
      view.fetchMeteoalarmDocument(url, (target) => {
        deps.requested.push(target);
        return Promise.resolve(answer(target));
      }),
    now: () => deps.clockMs,
    url: URL_UNDER_TEST,
  };
  return deps;
}

const ok = () => new Response(FIXTURE_TEXT, { status: 200 });

beforeEach(() => {
  resetMeteoalarmForTest();
  setLayersPanelOpen(false);
  setMeteoalarmViewForTest(view);
});

afterEach(() => {
  resetMeteoalarmForTest();
  setLayersPanelOpen(false);
  setMeteoalarmViewForTest(null);
});

describe('loadMeteoalarm', () => {
  it('asks for the document and holds it', async () => {
    const deps = fakeDeps(ok);
    await loadMeteoalarm(deps);
    expect(deps.requested).toEqual([URL_UNDER_TEST]);
    const status = meteoalarmStatus.value;
    expect(status.kind).toBe('ready');
    expect(status.kind === 'ready' ? status.doc.warnings.length : 0).toBe(3);
  });

  it.each([
    ['a stale feed (503)', () => new Response('{}', { status: 503 })],
    ['an unreadable body', () => new Response('not json', { status: 200 })],
    ['another schema', () => new Response('{"schema_version":2}', { status: 200 })],
  ])('ends as unavailable on %s', async (_label, answer) => {
    await loadMeteoalarm(fakeDeps(answer));
    expect(meteoalarmStatus.value.kind).toBe('unavailable');
  });

  it('ends as unavailable when the network throws', async () => {
    await loadMeteoalarm(fakeDeps(() => Promise.reject(new TypeError('offline'))));
    expect(meteoalarmStatus.value.kind).toBe('unavailable');
  });
});

describe('ensureMeteoalarm', () => {
  it('asks once until the copy is older than the refetch interval', async () => {
    const deps = fakeDeps(ok);
    ensureMeteoalarm(deps);
    ensureMeteoalarm(deps);
    await flush();
    ensureMeteoalarm(deps);
    expect(deps.requested).toHaveLength(1);
    deps.clockMs += METEOALARM_REFETCH_AFTER_MS;
    ensureMeteoalarm(deps);
    await flush();
    expect(deps.requested).toHaveLength(2);
  });

  it('holds an unavailable answer too, so a build without a server asks once', async () => {
    const deps = fakeDeps(() => new Response('', { status: 404 }));
    ensureMeteoalarm(deps);
    await flush();
    ensureMeteoalarm(deps);
    await flush();
    expect(deps.requested).toHaveLength(1);
    expect(meteoalarmStatus.value.kind).toBe('unavailable');
  });
});

describe('meteoalarmCredit', () => {
  it('renders the registry entry with its link', () => {
    const credit = meteoalarmCredit({ epochNow: () => NOW }, en);
    expect(credit?.text).toContain('MeteoAlarm');
    expect(credit?.href).toMatch(/^https:\/\//u);
  });
});

function services(messages: Messages): AppServices {
  return {
    store: {} as FireEventStore,
    clock: { epochNow: () => NOW, monotonicNow: () => 0 },
    serverNow: () => NOW,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale: messages === bg ? 'bg' : 'en',
    messages,
    setLocale: () => {},
  };
}

async function render(messages: Messages = en): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(messages)}>
      <MeteoalarmWarnings />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

describe('MeteoalarmWarnings', () => {
  it('renders nothing while the Layers panel is closed', async () => {
    expect(await render()).toBe('');
  });

  it('renders nothing until its chunk has arrived', async () => {
    setLayersPanelOpen(true);
    setMeteoalarmViewForTest(null);
    expect(await render()).toBe('');
  });

  it('shows loading, the note and the credit before an answer arrives', async () => {
    setLayersPanelOpen(true);
    const html = await render();
    expect(html).toContain(en.meteoalarm.title);
    expect(html).toContain(en.meteoalarm.note);
    expect(html).toContain(en.layers.loading);
    expect(html).toContain('class="meteoalarm-credit"');
  });

  it('says so when the warnings are unavailable', async () => {
    setLayersPanelOpen(true);
    meteoalarmStatus.value = { kind: 'unavailable', fetchedAtMs: 0 };
    expect(await render()).toContain(en.layers.unavailable);
  });

  it('lists every warning with its level name, kind, region and official link', async () => {
    setLayersPanelOpen(true);
    meteoalarmStatus.value = { kind: 'ready', doc: DOC, fetchedAtMs: 0 };
    const html = await render();
    const rows = html.match(/<li class="meteoalarm-warning"[\s\S]*?<\/li>/gu) ?? [];
    expect(rows).toHaveLength(3);
    const [gr, bgFire, bgHeat] = rows;
    expect(gr).toContain(en.meteoalarm.level4);
    expect(gr).toContain(en.meteoalarm.forestFire);
    expect(gr).toContain('Evros (synthetic) · Greece');
    expect(gr).toContain('href="https://meteoalarm.org?region=GR"');
    expect(gr).toContain('rel="noopener noreferrer"');
    expect(bgFire).toContain(en.meteoalarm.level3);
    expect(bgHeat).toContain(en.meteoalarm.level2);
    expect(bgHeat).toContain(en.meteoalarm.highTemperature);
    expect(bgHeat).toContain('href="https://www.meteo.bg/"');
    expect(html).not.toContain(en.meteoalarm.noneInForce);
  });

  it('names a country whose feed was not read', async () => {
    setLayersPanelOpen(true);
    meteoalarmStatus.value = { kind: 'ready', doc: DOC, fetchedAtMs: 0 };
    expect(await render()).toContain(en.meteoalarm.notChecked('North Macedonia'));
  });

  it('says none are in force only from the services read', async () => {
    setLayersPanelOpen(true);
    const doc: MeteoalarmDoc = {
      ...DOC,
      warnings: [],
      countries: DOC.countries.map((state) => ({ ...state, ok: true })),
    };
    meteoalarmStatus.value = { kind: 'ready', doc, fetchedAtMs: 0 };
    const html = await render();
    expect(html).toContain(en.meteoalarm.noneInForce);
    expect(html).not.toContain('class="meteoalarm-caveat"');
    expect(html).not.toContain('meteoalarm-list');
  });

  it('shows a validity without an onset as "until"', async () => {
    setLayersPanelOpen(true);
    const [first, ...rest] = DOC.warnings;
    if (first === undefined) throw new Error('fixture has warnings');
    const doc: MeteoalarmDoc = { ...DOC, warnings: [{ ...first, onset: null }, ...rest] };
    meteoalarmStatus.value = { kind: 'ready', doc, fetchedAtMs: 0 };
    const html = await render();
    const firstRow = /<li class="meteoalarm-warning"[\s\S]*?<\/li>/u.exec(html)?.[0] ?? '';
    const untilPrefix = en.meteoalarm.validUntil('\u0000').split('\u0000')[0] ?? '';
    const fromPrefix = en.meteoalarm.validFromTo('\u0000', '\u0000').split('\u0000')[0] ?? '';
    expect(firstRow).toContain(untilPrefix);
    expect(firstRow).not.toContain(fromPrefix);
  });

  it('renders in Bulgarian from the same document', async () => {
    setLayersPanelOpen(true);
    meteoalarmStatus.value = { kind: 'ready', doc: DOC, fetchedAtMs: 0 };
    const html = await render(bg);
    expect(html).toContain(bg.meteoalarm.title);
    expect(html).toContain(bg.meteoalarm.level4);
    expect(html).toContain('Гърция');
  });
});
