/**
 * CI-11, in two halves.
 *
 * **Frozen wording.** Every literal fragment of the frozen templates in bg.ts / en.ts must
 * appear byte-exact in docs/GLOSSARY.md (§2, §3, §3b, §5.2). Templates are rendered with
 * sentinel substitutions, split on those sentinels, and each remaining fragment is asserted
 * verbatim against the (lightly de-markdowned) glossary text — so a paraphrase, a swapped
 * dash, or a dropped clause fails here.
 *
 * **Which copy that is.** The glossary freezes four sections and leaves the rest of the
 * product's voice to the product, so most of the catalog is legitimately free. What this
 * file used to lack was any way to tell *deliberately free* from *nobody looked*: it
 * enumerated sixteen paths by hand out of eighty, and a message added under `lifecycle.` or
 * `status.` tomorrow would ship with CI-11 green and covering less. `catalog-governance.ts`
 * removes that possibility — every path carries a posture, the record is total over a union
 * read off `Messages`, and the assertions below are a `Record` over the subset it calls
 * glossary-governed. An unclassified path does not compile; an unasserted frozen path does
 * not compile either. Nothing here is a list anyone has to remember to extend.
 */

// The web tsconfig is browser-only (`types: ["vite/client"]`), but this test runs in the
// node vitest project and reads the glossary off disk. The reference is scoped to the one
// file that needs node builtins instead of widening the package's `types` for everything.
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Locale } from '../types.js';
import { N, N_STR, T1, T2, T3, T4 } from './catalog-render.js';
import type { GlossaryGovernedPath } from './catalog-governance.js';
import {
  CATALOG_GOVERNANCE,
  CatalogGovernanceError,
  classificationKey,
  classifyCatalog,
} from './catalog-governance.js';
import { formatNumber } from './format.js';
import type { Messages } from './messages.js';
import bg from './bg.js';
import en from './en.js';

const glossary = readFileSync(
  fileURLToPath(new URL('../../../../docs/GLOSSARY.md', import.meta.url)),
  'utf8',
)
  // Strip markdown emphasis and table escapes so cell text compares as rendered prose.
  .replaceAll('**', '')
  .replaceAll('\\<', '<')
  .replaceAll('\\>', '>')
  .replaceAll('\\|', '|');

// The substitution sentinels are shared with `never-send-catalog.test.ts` rather than
// declared twice: both gates split rendered copy on them, and two copies of a value whose
// whole job is "cannot collide with real copy" is two chances to pick a colliding one.
// `catalog-render.ts` documents why these particular tokens are safe.

/**
 * Splits `rendered` on every substitution and asserts each remaining literal fragment
 * appears verbatim in the glossary. Fragments shorter than 3 characters after trimming
 * (lone dashes, brackets) carry no wording and are skipped.
 */
function expectFragments(rendered: string, substitutions: readonly string[]): void {
  let fragments = [rendered];
  for (const substitution of substitutions) {
    fragments = fragments.flatMap((fragment) => fragment.split(substitution));
  }
  for (const fragment of fragments) {
    const trimmed = fragment.trim();
    if (trimmed.length < 3) continue;
    expect(glossary).toContain(trimmed);
  }
}

const catalogs: readonly (readonly [Locale, Messages])[] = [
  ['bg', bg],
  ['en', en],
];

/* -------------------------------------------------------------------------- */
/* What the glossary says, path by path                                        */
/* -------------------------------------------------------------------------- */

/**
 * The §2 claim the Unverified explainer must carry, in each language.
 *
 * The glossary spells the constraint out in English only ("Unverified copy always includes
 * 'may still be a real fire'"), so the EN assertion below checks the catalog *and* the
 * glossary, and the BG one checks only the catalog: no normative row states the Bulgarian
 * sentence, and asserting it against the glossary would assert a string the glossary never
 * wrote. That asymmetry is recorded here rather than smoothed over.
 */
const UNVERIFIED_CLAIM: Readonly<Record<Locale, string>> = {
  bg: 'може все пак да е истински пожар',
  en: 'may still be a real fire',
};

/** What one glossary-governed path has to satisfy, in one locale. */
type GlossaryAssertion = (messages: Messages, locale: Locale) => void;

/**
 * One assertion per glossary-governed path — total over the subset `catalog-governance.ts`
 * classifies as `frozen` or `mandated-claim`, and nothing else.
 *
 * Totality is the compiler's job in both directions: classifying a new path `frozen`
 * without writing its assertion is a missing key here, and an assertion left behind after a
 * path stops being governed is an excess property on the same object. The hand-written list
 * that used to be the gate is now a list the gate cannot be written without.
 */
const GLOSSARY_ASSERTIONS: Record<GlossaryGovernedPath, GlossaryAssertion> = {
  // §2 — the tier explainer. Our wording, the glossary's claim.
  unverifiedNote: (messages, locale) => {
    expect(messages.unverifiedNote).toContain(UNVERIFIED_CLAIM[locale]);
    if (locale === 'en') {
      expect(glossary).toContain(UNVERIFIED_CLAIM.en);
    }
  },

  // §3 — the lifecycle wording ladder.
  'lifecycle.active': (messages) => {
    expectFragments(messages.lifecycle.active(T1), [T1]);
  },
  'lifecycle.signalWeakening': (messages) => {
    expectFragments(messages.lifecycle.signalWeakening(N), [N_STR]);
  },
  'lifecycle.noLongerDetected': (messages) => {
    expectFragments(messages.lifecycle.noLongerDetected(T1), [T1]);
  },
  'lifecycle.officiallyContained': (messages) => {
    const rendered = messages.lifecycle.officiallyContained(T1, T2);
    expectFragments(rendered, [T1, T2]);
    // Em dash between date and source, not a hyphen.
    expect(rendered).toContain(`${T1} — ${T2}`);
  },
  'lifecycle.officiallyExtinguished': (messages) => {
    const rendered = messages.lifecycle.officiallyExtinguished(T1, T2);
    expectFragments(rendered, [T1, T2]);
    expect(rendered).toContain(`${T1} — ${T2}`);
  },
  'lifecycle.archived': (messages) => {
    expectFragments(messages.lifecycle.archived(N), [N_STR]);
  },

  // §3b — degraded-state and empty-state copy.
  'status.staleSources': (messages) => {
    expectFragments(messages.status.staleSources(T1), [T1]);
  },
  'status.lifecycleFrozen': (messages) => {
    expect(glossary).toContain(messages.status.lifecycleFrozen);
  },
  'status.emptyState': (messages) => {
    expect(glossary).toContain(messages.status.emptyState);
  },
  'status.freshnessChip': (messages) => {
    const rendered = messages.status.freshnessChip(T1, T2, T3, T4);
    expectFragments(rendered, [T1, T2, T3, T4]);
    // En dash inside the window range, not an em dash and not a hyphen.
    expect(rendered).toContain(`~${T3}–${T4}`);
  },
  'status.freshnessChipUnknown': (messages) => {
    expectFragments(messages.status.freshnessChipUnknown(T1, T2), [T1, T2]);
  },
  'status.cloudBlindClose': (messages) => {
    expectFragments(messages.status.cloudBlindClose(N), [N_STR]);
  },
  'status.officialThenRedetected': (messages) => {
    expectFragments(messages.status.officialThenRedetected(T1, T2, T3, T4), [T1, T2, T3, T4]);
  },

  // §5.2 — the positive copy contracts the web renders.
  safetyNoTravel: (messages) => {
    expect(glossary).toContain(messages.safetyNoTravel);
  },
  areaBothUnits: (messages, locale) => {
    const rendered = messages.areaBothUnits(320);
    // Numbers are parameters (locale Intl grouping), so only the literal shape is frozen.
    expectFragments(rendered, [formatNumber(3_200, locale), formatNumber(320, locale)]);
    expect(rendered.startsWith('~')).toBe(true);
    // дка first for BG readers, hectares first for EN.
    if (locale === 'bg') {
      expect(rendered.indexOf('дка')).toBeLessThan(rendered.indexOf('ha'));
    } else {
      expect(rendered.indexOf('ha')).toBeLessThan(rendered.indexOf('дка'));
    }
  },
};

/** The governed paths, in classification order, with where the glossary says they come from. */
const GOVERNED_CASES = (Object.keys(GLOSSARY_ASSERTIONS) as GlossaryGovernedPath[]).map((path) => {
  const governance = CATALOG_GOVERNANCE[path];
  return {
    path,
    source:
      governance.governance === 'frozen'
        ? `§${governance.section} ${governance.templateId}`
        : `§${governance.section} mandated claim`,
  };
});

describe.each(catalogs)('glossary-governed copy (%s)', (locale, messages) => {
  it.each(GOVERNED_CASES)('$path matches $source', ({ path }) => {
    GLOSSARY_ASSERTIONS[path](messages, locale);
  });
});

describe('the rows the classification claims to transcribe', () => {
  it('all exist in the glossary', () => {
    // A frozen path names a template id so a failure points at a row a human can open.
    // A row that was renamed or removed would leave the classification pointing at
    // nothing, which reads authoritative and is not.
    const missing = Object.values(CATALOG_GOVERNANCE)
      .filter((governance) => governance.governance === 'frozen')
      .map((governance) => governance.templateId)
      .filter((templateId) => !glossary.includes(`\`${templateId}\``));
    expect(missing).toStrictEqual([]);
  });

  /**
   * Rows the glossary specifies that no catalog path carries.
   *
   * Recorded the way `never-send-catalog.test.ts` records its findings — as an exact set
   * rather than an allowlist — so the gap is a named standing defect instead of an absence
   * nobody can see. A third unclaimed row is red, and so is claiming one of these without
   * striking it off here.
   *
   * Both entries are one founder decision: either the web owes these strings, which is new
   * copy, or they are alert-channel-only and §5.2 should say which of its rows the web is
   * expected to render. Not resolvable from the code, so it is written down instead.
   */
  const UNCLAIMED_ROWS: readonly string[] = ['agri_burn_tag', 'defer_road_closures'];

  it('cover every row of the sections they transcribe, but for the ones on record', () => {
    // The other direction, and the one that hid the gap above: the totality guarantee in
    // `catalog-governance.ts` is total over *the catalog's* paths, so a glossary row the
    // catalog never implemented is invisible to it — nothing is missing from the record
    // because nothing asked for it. The sections swept are read off the classification
    // itself rather than listed here, so freezing a path against a new section brings that
    // section's rows under this check in the same change.
    // Both widened to `Set<string>` deliberately: the classification's literal types are
    // the wrong side of this test. What is tested against them is text parsed out of the
    // glossary at runtime, and a membership test that only accepts the ids already on
    // record could never report an id that is not — which is the entire question here.
    const sections = new Set<string>(
      Object.values(CATALOG_GOVERNANCE)
        .filter((governance) => governance.governance === 'frozen')
        .map((governance) => governance.section),
    );
    const claimed = new Set<string>(
      Object.values(CATALOG_GOVERNANCE)
        .filter((governance) => governance.governance === 'frozen')
        .map((governance) => governance.templateId),
    );

    const unclaimed: string[] = [];
    let current: string | null = null;
    for (const line of glossary.split('\n')) {
      // The id must not swallow the heading's own full stop: `## 3b. …` is section
      // `3b`, not `3b.`, and a classification naming `3b` has to match it.
      const heading = /^#{2,3} (\d[\da-z]*(?:\.\d+)*)\.? /.exec(line);
      if (heading !== null) current = heading[1] ?? null;
      if (current === null || !sections.has(current)) continue;
      const row = /^\|\s*`([a-z0-9_]+)`/.exec(line);
      const templateId = row?.[1];
      if (templateId !== undefined && !claimed.has(templateId)) unclaimed.push(templateId);
    }

    expect(unclaimed.sort()).toStrictEqual([...UNCLAIMED_ROWS].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* §4/§5 vocabulary bans in own-voice copy                                     */
/* -------------------------------------------------------------------------- */

describe('§4/§5 vocabulary bans in own-voice copy', () => {
  it('EN short status labels never say "out"', () => {
    for (const label of Object.values(en.statusShort)) {
      expect(label).not.toMatch(/\bout\b/i);
    }
  });

  it('BG short status labels never say "изгасен" in our own voice', () => {
    for (const label of Object.values(bg.statusShort)) {
      expect(label).not.toContain('изгасен');
    }
  });

  it('the offline banner never says "out" in its own voice', () => {
    expect(en.bannerOffline).not.toMatch(/\bout\b/i);
  });
});

/* -------------------------------------------------------------------------- */
/* The classification is total                                                 */
/* -------------------------------------------------------------------------- */

describe('every path is classified', () => {
  it.each(catalogs)('%s renders nothing the classification has no posture for', (_l, messages) => {
    // The compile-time `Record<CatalogPath, Governance>` covers what `Messages` declares;
    // this covers what the catalog object actually holds. They agree only for as long as
    // the leaf detection in `catalog-governance.ts` keeps up with the shapes the catalog
    // uses, and that is worth checking rather than assuming.
    expect(() => classifyCatalog(messages)).not.toThrow();
  });

  it('classifies nothing the catalog no longer holds', () => {
    // A stale entry reads as coverage and is not: it makes the record look more complete
    // than the catalog it describes. Array elements collapse onto their array, which is
    // why the comparison is over classification keys rather than rendered paths.
    const reached = new Set(classifyCatalog(bg).map((message) => message.key));
    expect(Object.keys(CATALOG_GOVERNANCE).filter((path) => !reached.has(path))).toStrictEqual([]);
  });

  it('asserts exactly the paths the classification calls glossary-governed', () => {
    const governed = Object.entries(CATALOG_GOVERNANCE)
      .filter(([, governance]) => governance.governance !== 'own-voice')
      .map(([path]) => path)
      .sort();
    expect(GOVERNED_CASES.map((testCase) => String(testCase.path)).sort()).toStrictEqual(governed);
  });

  it('refuses a message nobody classified', () => {
    // The guarantee in one assertion, at the position a real author would add copy: inside
    // the frozen §3b neighbourhood. Unclassified is a failure, never a gap.
    const catalogWithNewMessage = {
      ...bg,
      status: { ...bg.status, addedTomorrow: 'XT1X' },
    } as unknown as Messages;
    expect(() => classifyCatalog(catalogWithNewMessage)).toThrow(CatalogGovernanceError);
    expect(() => classifyCatalog(catalogWithNewMessage)).toThrow('status.addedTomorrow');
  });

  it('classifies an array element by its array', () => {
    expect(classificationKey('about.paragraphs[2]')).toBe('about.paragraphs');
  });
});
