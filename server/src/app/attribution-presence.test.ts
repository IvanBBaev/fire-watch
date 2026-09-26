/**
 * CI-13 — attribution presence, server half (ADR-001 A1.4, ADR-003 A1.3, TASKS G5).
 *
 * **What is walked.** For every surface the credits registry assigns to the server
 * ({@link CREDIT_SURFACE_OWNER}) and every credit context the registry can name, the
 * surface's real output is produced and the registry is asked what it owes:
 * - `api`: the whole HTTP server answers `GET /snapshot.json` — the full set and a cursor
 *   (`partial: true`) read alike — and the `attribution` member of the body is read back.
 *   A consumer who takes the API instead of the map inherits the obligation with the data.
 * - `alert-footer`: the footer the H6 draft templates render (`renderAlertTemplate`), for
 *   every template × channel × locale. Alert channels are plain text, so a licence link
 *   counts as carried when its URL appears in the footer text. The templates are drafts —
 *   the production gateway registers none of them until their copy is reviewed — but the
 *   footer is the one the gateway will send, so it is what this surface owes against.
 *
 * **Compiler-total.** {@link PROBES} is `satisfies Record<CreditSurfacesOf<'server'>, …>`
 * and {@link CONTEXTS} is `satisfies Record<CreditCondition, …>`.
 *
 * **What fails.** An owed credit (required, verified, not plugin-injected) whose asserted
 * wording or licence link is missing from the output, compared as an exact register
 * ({@link KNOWN_FINDINGS}) so a new gap and a silently closed one both go red.
 *
 * **Client style combinations (TASKS G3/G5/G6).** Which basemap, hillshade and imagery the
 * map draws is a client choice the server never learns, so a server surface must owe the
 * same credits under every one of them. {@link STYLE_COMBINATIONS} is every subset of the
 * style conditions the web can reach, and each server surface's real output is checked
 * against what the registry says it owes under each subset — a style-keyed credit that
 * names a server surface fails here with the combination that owes it.
 *
 * **What this does not see.** The stream's frames, `/api/v1/client-config` and the health
 * routes carry no `attribution` member; none of them is the registry's `api` surface today.
 */

import { describe, expect, it } from 'vitest';

import {
  CREDIT_SURFACE_OWNER,
  CREDITS,
  assertableCredits,
  attributionGaps,
} from '@fire-watch/contracts';
import type {
  CreditCondition,
  CreditSurface,
  CreditSurfacesOf,
  RenderContext,
  RenderedAttribution,
} from '@fire-watch/contracts';

import { createHealthServer } from '../adapters/http/health-server.js';
import { ALERT_LOCALES } from '../core/alerts/templates/alert-copy.js';
import { renderAlertTemplate } from '../core/alerts/templates/alert-templates.js';
import type { AlertChannel } from '../core/ports/alert-outbox-store.js';
import { CURSOR_PARAM, SNAPSHOT_PATH } from '../adapters/http/snapshot-route.js';
import { VirtualClock, epochMsFromIso } from '../core/ports/clock.js';
import type { ActiveEventRow, SnapshotReader } from '../core/ports/snapshot-reader.js';
import { PRODUCT_NAME } from '../core/snapshot/snapshot-builder.js';

const NOW = '2026-09-23T12:00:00Z';

/** The placeholders resolved independently of the code under test. */
const EXPECTED_CONTEXT: RenderContext = { year: 2026, productName: PRODUCT_NAME };

const EVENT: ActiveEventRow = {
  publicId: 'fw-2026-abc123',
  seq: 1040,
  status: 'active',
  score: 0.55,
  lon: 25.123456,
  lat: 42.654321,
  startedAt: epochMsFromIso('2026-09-22T09:00:00Z'),
  lastDetectionAt: epochMsFromIso('2026-09-23T11:40:00Z'),
  detectionCount: 7,
  nearestPlace: null,
};

const reader: SnapshotReader = {
  readActiveSet: (afterSeq) =>
    Promise.resolve({ maxSeq: 1042, events: [EVENT].filter((event) => event.seq > afterSeq) }),
  readSourceObservations: () => Promise.resolve([]),
};

const refuse = (what: string) => () => Promise.reject(new Error(`${what} must not be touched`));

// ── Probes ───────────────────────────────────────────────────────────────────

type Probe =
  | {
      readonly kind: 'rendered';
      readonly outputs: () => Promise<Record<string, RenderedAttribution>>;
    }
  | { readonly kind: 'absent'; readonly why: string };

interface AttributionEntry {
  readonly text: string;
  readonly href?: string;
}

async function snapshotOutputs(): Promise<Record<string, RenderedAttribution>> {
  const app = createHealthServer({
    reader: { readObservations: refuse('the probe reader') },
    probe: { ping: refuse('the probe') },
    clock: new VirtualClock(NOW),
    expected: [],
    snapshot: { reader, clock: new VirtualClock(NOW), sources: [] },
  });
  const urls = { full: SNAPSHOT_PATH, cursor: `${SNAPSHOT_PATH}?${CURSOR_PARAM}=1000` };
  const outputs: Record<string, RenderedAttribution> = {};
  for (const [name, url] of Object.entries(urls)) {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, url).toBe(200);
    const body = response.json<{ partial: boolean; attribution?: AttributionEntry[] }>();
    expect(body.partial, url).toBe(name === 'cursor');
    const entries = body.attribution ?? [];
    outputs[name] = {
      text: entries.map((entry) => entry.text).join('\n'),
      hrefs: entries.flatMap((entry) => (entry.href === undefined ? [] : [entry.href])),
    };
  }
  await app.close();
  return outputs;
}

const ALERT_CHANNELS: readonly AlertChannel[] = ['push', 'telegram', 'email'];

const NEW_FIRE_ENTRY = {
  eventUrl: 'https://firewatch.example/e/fw-2026-abc123',
  placeName: { bg: 'Малко Търново', en: 'Malko Tarnovo' },
  distanceKm: 6.2,
  observedAt: '2026-09-23T11:40:00Z',
  scoreBucket: 'likely',
  burnedAreaHa: null,
  areaSource: null,
  agriBurn: false,
};

/** One valid parameter set per draft template; only the footer is read. */
const FOOTER_PROBE_PARAMS: Readonly<Record<string, Record<string, unknown>>> = {
  'new_fire.v1': { ...NEW_FIRE_ENTRY, zoneLabel: null },
  'digest.v1': { windowStart: '2026-09-23T06:00:00Z', zoneLabel: null, entries: [NEW_FIRE_ENTRY] },
};

async function alertFooterOutputs(): Promise<Record<string, RenderedAttribution>> {
  const outputs: Record<string, RenderedAttribution> = {};
  for (const [templateId, templateParams] of Object.entries(FOOTER_PROBE_PARAMS)) {
    for (const channel of ALERT_CHANNELS) {
      for (const locale of ALERT_LOCALES) {
        const { footer } = renderAlertTemplate({
          templateId,
          templateParams,
          channel,
          locale,
          timeZone: 'Europe/Sofia',
        });
        outputs[`${templateId}/${channel}/${locale}`] = {
          text: footer,
          hrefs: footer.match(/https:\/\/\S+/gu) ?? [],
        };
      }
    }
  }
  return Promise.resolve(outputs);
}

const PROBES = {
  api: { kind: 'rendered', outputs: snapshotOutputs },
  'alert-footer': { kind: 'rendered', outputs: alertFooterOutputs },
} as const satisfies Record<CreditSurfacesOf<'server'>, Probe>;

// ── Contexts ─────────────────────────────────────────────────────────────────

type Context = { readonly reachable: true } | { readonly reachable: false; readonly why: string };

const NOT_IN_A_PAYLOAD = 'no server payload carries data from this layer yet';

const CONTEXTS = {
  always: { reachable: true },
  'basemap:openfreemap': { reachable: false, why: 'the basemap is a client choice' },
  'basemap:protomaps': { reachable: false, why: 'the basemap is a client choice' },
  'layer:gibs': { reachable: false, why: NOT_IN_A_PAYLOAD },
  'layer:effis': { reachable: false, why: NOT_IN_A_PAYLOAD },
  'layer:gwis': { reachable: false, why: NOT_IN_A_PAYLOAD },
  'layer:terrain': { reachable: false, why: NOT_IN_A_PAYLOAD },
  'layer:landsat': { reachable: false, why: NOT_IN_A_PAYLOAD },
  'imagery:sentinel-unmodified': { reachable: false, why: NOT_IN_A_PAYLOAD },
  'derived:ecmwf': { reachable: false, why: NOT_IN_A_PAYLOAD },
  'toggle:esri': { reachable: false, why: 'the imagery toggle is a client choice' },
  never: { reachable: false, why: 'the registry never owes these' },
} as const satisfies Record<CreditCondition, Context>;

const CONDITIONS = Object.keys(CONTEXTS) as CreditCondition[];
const REACHABLE = CONDITIONS.filter((condition) => CONTEXTS[condition].reachable);
const activeFor = (condition: CreditCondition): readonly CreditCondition[] =>
  condition === 'always' ? [] : [condition];

/**
 * The conditions the web reaches through its drawn style (the web half's COMBINATIONS):
 * basemap provider, the outdoor style's Terrarium hillshade, the imagery toggle.
 */
const STYLE_CONDITIONS = [
  'basemap:openfreemap',
  'basemap:protomaps',
  'layer:terrain',
  'toggle:esri',
] as const satisfies readonly CreditCondition[];

/** Every subset of {@link STYLE_CONDITIONS}, the empty one included. */
const STYLE_COMBINATIONS: readonly (readonly CreditCondition[])[] = STYLE_CONDITIONS.reduce<
  CreditCondition[][]
>((subsets, condition) => [...subsets, ...subsets.map((subset) => [...subset, condition])], [[]]);

const styleKey = (conditions: readonly CreditCondition[]): string =>
  conditions.length === 0 ? 'style:none' : `style:${conditions.join('+')}`;

const SERVER_SURFACES = (Object.keys(PROBES) as CreditSurfacesOf<'server'>[]).sort();

// ── The register ─────────────────────────────────────────────────────────────

/** `<surface>[/<output>] <context> <credit id> <text|href>` — licence findings, not copy to add. */
const KNOWN_FINDINGS = [] as const;

async function findings(): Promise<string[]> {
  const found: string[] = [];
  for (const surface of SERVER_SURFACES) {
    // Widened: with every surface rendered today, the `absent` branch must still compile.
    const probe = PROBES[surface] as Probe;
    for (const condition of REACHABLE) {
      const active = activeFor(condition);
      if (probe.kind === 'absent') {
        for (const credit of assertableCredits(surface, active)) {
          found.push(`${surface} ${condition} ${credit.id} text`);
          if (credit.href !== undefined) found.push(`${surface} ${condition} ${credit.id} href`);
        }
        continue;
      }
      for (const [output, rendered] of Object.entries(await probe.outputs())) {
        for (const gap of attributionGaps(surface, active, rendered, EXPECTED_CONTEXT)) {
          found.push(`${surface}/${output} ${condition} ${gap.creditId} ${gap.missing}`);
        }
      }
    }
  }
  return found.sort();
}

/** The gaps of every server surface under each client style combination. */
async function styleFindings(): Promise<string[]> {
  const found: string[] = [];
  for (const surface of SERVER_SURFACES) {
    const probe = PROBES[surface] as Probe;
    if (probe.kind === 'absent') continue;
    const outputs = await probe.outputs();
    for (const conditions of STYLE_COMBINATIONS) {
      for (const [output, rendered] of Object.entries(outputs)) {
        for (const gap of attributionGaps(surface, conditions, rendered, EXPECTED_CONTEXT)) {
          found.push(`${surface}/${output} ${styleKey(conditions)} ${gap.creditId} ${gap.missing}`);
        }
      }
    }
  }
  return found.sort();
}

// ── The gate ─────────────────────────────────────────────────────────────────

describe('CI-13 — attribution presence on the server surfaces', () => {
  it('probes exactly the surfaces the registry gives the server', () => {
    const owned = (Object.keys(CREDIT_SURFACE_OWNER) as CreditSurface[])
      .filter((surface) => CREDIT_SURFACE_OWNER[surface] === 'server')
      .sort();
    expect(SERVER_SURFACES).toStrictEqual(owned);
  });

  it('owes nothing on a server surface under a context no payload reaches', () => {
    // Were a conditional credit assigned to a server surface, it would be owed in a context
    // this file does not probe; the table above must then say how a payload reaches it.
    const conditional = CREDITS.filter(
      (credit) =>
        credit.condition !== 'never' &&
        !CONTEXTS[credit.condition].reachable &&
        credit.surfaces.some((surface) => CREDIT_SURFACE_OWNER[surface] === 'server'),
    ).map((credit) => credit.id);
    expect(conditional).toStrictEqual([]);
  });

  it('asks something of every server surface (the check is not vacuous)', () => {
    for (const surface of SERVER_SURFACES) {
      expect(assertableCredits(surface, []).length, surface).toBeGreaterThan(0);
    }
  });

  it('every owed credit is carried, except the recorded findings', async () => {
    expect(await findings()).toStrictEqual([...KNOWN_FINDINGS].sort());
  });

  it('owes the same on every server surface whatever style the client draws', async () => {
    expect(STYLE_COMBINATIONS).toHaveLength(2 ** STYLE_CONDITIONS.length);
    for (const surface of SERVER_SURFACES) {
      const unstyled = assertableCredits(surface, []).map((credit) => credit.id);
      for (const conditions of STYLE_COMBINATIONS) {
        const owed = assertableCredits(surface, conditions).map((credit) => credit.id);
        expect(owed, `${surface} ${styleKey(conditions)}`).toStrictEqual(unstyled);
      }
    }
    // The recorded findings are style-independent, so no combination adds a gap either.
    expect(await styleFindings()).toStrictEqual([]);
  });
});
