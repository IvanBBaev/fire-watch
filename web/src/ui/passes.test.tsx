/**
 * TASKS F15, web half: the pass loader's state machine and the Layers-panel section's
 * markup. The loader runs against a fake `fetch`; the section renders the fixture document
 * at a fixed server time, so every relative time below is exact.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import { parsePassesDocument, type PassesDoc } from '../core/passes.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext, type AppServices } from './context.js';
import { setLayersPanelOpen } from './layers.js';
import {
  PASSES_REFETCH_AFTER_MS,
  type PassesLoaderDeps,
  celestrakCredit,
  ensurePasses,
  loadPasses,
  passesStatus,
  resetPassesForTest,
} from './passes.js';
import { SatellitePasses } from './satellite-passes.js';

const FIXTURE_TEXT = readFileSync(
  fileURLToPath(new URL('../../public/fixtures/passes/sample.json', import.meta.url)),
  'utf8',
);
const DOC = parsePassesDocument(JSON.parse(FIXTURE_TEXT)) as PassesDoc;
const CELL = DOC.cell;
/** 13:10 UTC — the fixture's own `computed_for`; 16:10 in Sofia. */
const NOW = Date.parse(DOC.computed_for);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeDeps extends PassesLoaderDeps {
  readonly requested: string[];
  clockMs: number;
}

function fakeDeps(answer: (url: string) => Response | Promise<Response>): FakeDeps {
  const deps: FakeDeps = {
    requested: [],
    clockMs: 1_000,
    fetch: (url) => {
      deps.requested.push(url);
      return Promise.resolve(answer(url));
    },
    now: () => deps.clockMs,
    urlTemplate: '/api/v1/passes/{cell}',
  };
  return deps;
}

const ok = () => new Response(FIXTURE_TEXT, { status: 200 });

beforeEach(() => {
  resetPassesForTest();
  setLayersPanelOpen(false);
});

afterEach(() => {
  resetPassesForTest();
  setLayersPanelOpen(false);
});

describe('loadPasses', () => {
  it('asks for the cell and holds the parsed document', async () => {
    const deps = fakeDeps(ok);
    await loadPasses(CELL, deps);
    expect(deps.requested).toEqual([`/api/v1/passes/${CELL}`]);
    const status = passesStatus.value;
    expect(status.kind).toBe('ready');
    expect(status.kind === 'ready' ? status.doc.cell : null).toBe(CELL);
  });

  it.each([
    ['a refused cell', () => new Response('{}', { status: 404 })],
    ['an unreadable body', () => new Response('not json', { status: 200 })],
    ['another schema', () => new Response('{"schema_version":2}', { status: 200 })],
  ])('ends as unavailable on %s', async (_label, answer) => {
    await loadPasses(CELL, fakeDeps(answer));
    expect(passesStatus.value.kind).toBe('unavailable');
  });

  it('ends as unavailable when the network throws', async () => {
    await loadPasses(
      CELL,
      fakeDeps(() => Promise.reject(new Error('offline'))),
    );
    expect(passesStatus.value.kind).toBe('unavailable');
  });

  it('drops a slow answer for a cell the reader has since left', async () => {
    let release: (response: Response) => void = () => {};
    const slow = fakeDeps(() => new Promise<Response>((resolve) => (release = resolve)));
    const first = loadPasses('41.75_23.25', slow);
    await loadPasses(CELL, fakeDeps(ok));
    release(ok());
    await first;
    const status = passesStatus.value;
    expect(status.kind === 'ready' ? status.cell : null).toBe(CELL);
  });
});

describe('ensurePasses', () => {
  it('asks once per cell until the copy is older than the refetch interval', async () => {
    const deps = fakeDeps(ok);
    ensurePasses(CELL, deps);
    ensurePasses(CELL, deps); // still loading
    await flush();
    ensurePasses(CELL, deps); // fresh
    expect(deps.requested).toHaveLength(1);
    deps.clockMs += PASSES_REFETCH_AFTER_MS;
    ensurePasses(CELL, deps);
    await flush();
    expect(deps.requested).toHaveLength(2);
  });

  it('holds an unavailable answer too, so a build without a server asks once', async () => {
    const deps = fakeDeps(() => new Response('', { status: 503 }));
    ensurePasses(CELL, deps);
    await flush();
    ensurePasses(CELL, deps);
    expect(deps.requested).toHaveLength(1);
  });

  it('asks again at once when the cell changes', async () => {
    const deps = fakeDeps(ok);
    ensurePasses(CELL, deps);
    await flush();
    ensurePasses('41.75_23.25', deps);
    expect(deps.requested).toHaveLength(2);
  });
});

describe('celestrakCredit', () => {
  it('renders the registry entry with its link', () => {
    const credit = celestrakCredit({ epochNow: () => NOW }, en);
    expect(credit?.text).toContain('CelesTrak');
    expect(credit?.href).toBe('https://celestrak.org/');
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
      <SatellitePasses />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

describe('SatellitePasses', () => {
  it('renders nothing while the Layers panel is closed', async () => {
    expect(await render()).toBe('');
  });

  it('shows loading for the map-centre cell before an answer arrives', async () => {
    setLayersPanelOpen(true);
    const html = await render();
    expect(html).toContain(en.passes.title);
    expect(html).toContain(en.passes.forMapCentre);
    expect(html).toContain(en.layers.loading);
    expect(html).toContain('href="https://celestrak.org/"');
  });

  it('says so when the prediction is unavailable', async () => {
    setLayersPanelOpen(true);
    passesStatus.value = { kind: 'unavailable', cell: CELL, fetchedAtMs: 0 };
    expect(await render()).toContain(en.layers.unavailable);
  });

  it('labels every platform row as predicted, with last and next looks', async () => {
    setLayersPanelOpen(true);
    passesStatus.value = { kind: 'ready', cell: CELL, doc: DOC, fetchedAtMs: 0 };
    const html = await render();
    expect(html).toContain(en.passes.predicted);
    for (const id of ['noaa20', 'snpp', 'noaa21', 's3a', 's3b']) {
      expect(html).toContain(`data-platform="${id}"`);
    }
    // Suomi NPP: last in-swath culmination 12:18:49Z (51 min before 13:10), next 00:36:20Z.
    const snpp = /data-platform="snpp"[\s\S]*?<\/li>/u.exec(html)?.[0] ?? '';
    expect(snpp).toContain(en.passes.lastPass);
    expect(snpp).toContain('15:18');
    expect(snpp).toContain(en.relativeAge({ unit: 'minutes', minutes: 51 }));
    expect(snpp).toContain(en.passes.nextPass);
    expect(snpp).toContain(en.passes.inTime({ unit: 'hours', hours: 11, minutes: 26 }));
    expect(snpp).toContain(en.passes.night);
    expect(html).not.toContain(en.passes.expired);
  });

  it('renders in Bulgarian from the same document', async () => {
    setLayersPanelOpen(true);
    passesStatus.value = { kind: 'ready', cell: CELL, doc: DOC, fetchedAtMs: 0 };
    const html = await render(bg);
    expect(html).toContain(bg.passes.title);
    expect(html).toContain(bg.passes.predicted);
  });

  it('flags missing and stale orbital elements instead of inventing times', async () => {
    setLayersPanelOpen(true);
    const [first, second, ...rest] = DOC.platforms;
    if (first === undefined || second === undefined) throw new Error('fixture has platforms');
    const doc: PassesDoc = {
      ...DOC,
      platforms: [
        {
          ...first,
          elements: 'missing',
          elements_epoch: null,
          elements_age_hours: null,
          passes: [],
        },
        { ...second, elements: 'stale', elements_age_hours: 96 },
        ...rest,
      ],
    };
    passesStatus.value = { kind: 'ready', cell: CELL, doc, fetchedAtMs: 0 };
    const html = await render();
    expect(html).toContain(en.passes.elementsMissing);
    expect(html).toContain(en.passes.elementsStale);
  });
});
