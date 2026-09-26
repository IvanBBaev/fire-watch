/**
 * CI-10 over the UI copy: every message the web can render, linted by the never-send
 * rules (`@fire-watch/contracts`), in both languages.
 *
 * The lint was written for the alert templates the gateway sends, but the rules are about
 * what the product is allowed to claim, not about which transport carries the claim. A
 * reader who opens the map is told the same things by the same organisation, so the UI
 * catalogs are linted by the same function over the same rule list — which is why that
 * function now lives in the shared contracts package and not under `server/`.
 *
 * Coverage is exhaustive by construction, not by diligence: {@link renderCatalog} walks
 * the catalog object rather than a written-down list of keys, and throws on a template it
 * has no arguments for. A message added to `messages.ts` tomorrow is linted on the next
 * run, or this file goes red. Nothing gets added quietly.
 */

import { lintAlertText, type AlertLintRuleId, type NeverSendContext } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import type { Locale } from '../types.js';
import bg from './bg.js';
import en from './en.js';
import {
  CatalogCoverageError,
  MESSAGE_ARGUMENTS,
  SENTINELS,
  renderCatalog,
} from './catalog-render.js';
import type { Messages } from './messages.js';

const catalogs: readonly (readonly [Locale, Messages])[] = [
  ['bg', bg],
  ['en', en],
];

/* -------------------------------------------------------------------------- */
/* What voice each message speaks in                                          */
/* -------------------------------------------------------------------------- */

/**
 * The only catalog copy that relays someone else's statement rather than making our own:
 * the curated `officially_*` tier (GLOSSARY §3) and the §3b conflict template.
 *
 * Everything not listed here is linted as `own` — the strictest posture — so a message
 * added tomorrow is judged by the strictest rules until somebody argues otherwise in
 * writing. An exemption should have to be claimed; it should never be the default.
 */
const QUOTED_OFFICIAL_PATHS: readonly string[] = [
  'lifecycle.officiallyContained',
  'lifecycle.officiallyExtinguished',
  'status.officialThenRedetected',
];

/**
 * The provenance the web actually renders next to those quotes today: none.
 *
 * `FireEvent` carries no declared-by and no declared-at field, so `event.tsx` passes
 * `UNKNOWN_SOURCE_PLACEHOLDER` ('—') as the source and the *satellite observation* date
 * as the date. `sourceUrl` and `statementAt` are therefore `null` here, and they must
 * stay `null` until the contract carries the real values: modelling provenance the
 * product does not have would make this file assert a page nobody can open.
 */
const RENDERED_QUOTE_TODAY = {
  authority: 'властите / authorities',
  sourceUrl: null,
  statementAt: null,
} as const;

/** The same quote once the contract gap is closed — used to prove what is missing. */
const RENDERED_QUOTE_WITH_PROVENANCE = {
  authority: 'ГДПБЗН',
  sourceUrl: 'https://www.mvr.bg/gdpbzn/statement',
  statementAt: '2026-09-21T14:30:00+03:00',
} as const;

function contextFor(path: string): NeverSendContext {
  return QUOTED_OFFICIAL_PATHS.includes(path)
    ? { voice: 'quoted-official', quotedSource: RENDERED_QUOTE_TODAY }
    : { voice: 'own' };
}

/* -------------------------------------------------------------------------- */
/* The findings on record                                                     */
/* -------------------------------------------------------------------------- */

interface Finding {
  readonly locale: Locale;
  readonly path: string;
  readonly variant: number;
  readonly ruleId: AlertLintRuleId;
  readonly match: string | null;
}

/**
 * Every never-send violation the shipped catalogs currently produce.
 *
 * This is a defect register, not an allowlist. Nothing here is forgiven: each entry is a
 * place where the UI states an official containment or extinction without the provenance
 * that GLOSSARY §5 and CI-10 §5.5 make the condition of saying it at all. They are listed
 * so the gate can be exact rather than approximate — the assertion below is equality, so
 * it fails when new copy trips a rule *and* fails when one of these is resolved without
 * the register being updated. Softening copy or narrowing a rule does not make it green;
 * only changing the register does, and that is a visible diff.
 *
 * Two distinct defects are recorded:
 *
 * 1. `statusShort.officially_*` — a bare badge rendered by `event-list.tsx` in our own
 *    voice, with no attribution anywhere near it. `messages.ts` documents `statusShort`
 *    as own voice, so there is no quote to exempt: the product says "Officially
 *    contained" itself.
 * 2. `lifecycle.officially*` and `status.officialThenRedetected` — genuinely quoted copy
 *    whose rendered span carries neither a source link nor a statement timestamp, because
 *    `FireEvent` has no field for either. See the test below, which shows these clear the
 *    lint the moment the span carries both.
 */
const KNOWN_FINDINGS: readonly Finding[] = [
  // 1. Own-voice badges.
  {
    locale: 'bg',
    path: 'statusShort.officially_contained',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'локализиран',
  },
  {
    locale: 'bg',
    path: 'statusShort.officially_extinguished',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'ликвидиран',
  },
  {
    locale: 'en',
    path: 'statusShort.officially_contained',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'contained',
  },
  {
    locale: 'en',
    path: 'statusShort.officially_extinguished',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'extinguished',
  },
  // 2. Quoted copy with no rendered provenance. The EN catalog relays the Bulgarian term
  //    alongside the English one, so each EN line trips twice — once per spelling.
  {
    locale: 'bg',
    path: 'lifecycle.officiallyContained',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'локализиран',
  },
  {
    locale: 'bg',
    path: 'lifecycle.officiallyExtinguished',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'ликвидиран',
  },
  {
    locale: 'bg',
    path: 'status.officialThenRedetected',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'локализиран',
  },
  {
    locale: 'bg',
    path: 'status.officialThenRedetected',
    variant: 1,
    ruleId: 'own-voice-extinguished',
    match: 'ликвидиран',
  },
  {
    locale: 'en',
    path: 'lifecycle.officiallyContained',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'contained',
  },
  {
    locale: 'en',
    path: 'lifecycle.officiallyContained',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'локализиран',
  },
  {
    locale: 'en',
    path: 'lifecycle.officiallyExtinguished',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'extinguished',
  },
  {
    locale: 'en',
    path: 'lifecycle.officiallyExtinguished',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'ликвидиран',
  },
  {
    locale: 'en',
    path: 'status.officialThenRedetected',
    variant: 0,
    ruleId: 'own-voice-extinguished',
    match: 'локализиран',
  },
  {
    locale: 'en',
    path: 'status.officialThenRedetected',
    variant: 1,
    ruleId: 'own-voice-extinguished',
    match: 'ликвидиран',
  },
];

function lintCatalog(locale: Locale, messages: Messages): readonly Finding[] {
  const findings: Finding[] = [];
  for (const message of renderCatalog(messages)) {
    for (const violation of lintAlertText(message.text, contextFor(message.path))) {
      findings.push({
        locale,
        path: message.path,
        variant: message.variant,
        ruleId: violation.ruleId,
        match: violation.match,
      });
    }
  }
  return findings;
}

/** Stable, readable form for diffing two sets of findings. */
function describeFinding(finding: Finding): string {
  return `${finding.locale} ${finding.path}#${String(finding.variant)} ${finding.ruleId} <${finding.match ?? 'missing'}>`;
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

describe('never-send lint over the UI catalogs', () => {
  it('produces exactly the findings on record, in both languages', () => {
    const actual = catalogs.flatMap(([locale, messages]) => lintCatalog(locale, messages));
    expect(actual.map(describeFinding).sort()).toStrictEqual(
      KNOWN_FINDINGS.map(describeFinding).sort(),
    );
  });

  it('reached every top-level key of the catalog', () => {
    // A gate over an empty or truncated list is the failure mode that looks greenest, so
    // the walk's reach is asserted rather than trusted: every key the catalog declares
    // must head at least one rendered path, and nothing may render to an empty string.
    for (const [, messages] of catalogs) {
      const rendered = renderCatalog(messages);
      const reached = new Set(rendered.map((message) => message.path.split(/[.[]/u)[0]));
      expect([...reached].sort()).toStrictEqual(Object.keys(messages).sort());
      expect(rendered.every((message) => message.text.length > 0)).toBe(true);
    }
  });
});

describe('what the findings are, and are not', () => {
  it.each(QUOTED_OFFICIAL_PATHS)(
    '%s clears the lint once its span carries a source and a statement time',
    (path) => {
      // The verdict on these eight findings, pinned: the vocabulary is permitted inside
      // an attributed official quote (GLOSSARY §5), and what fails is only CI-10 §5.5's
      // condition — the rendered span must carry both `source_url` and `statement_ts`.
      // Give the same copy real provenance and it is clean. That makes them a contract
      // gap in `FireEvent`, not banned wording, and it is why the fix is a field, never a
      // paraphrase.
      const context: NeverSendContext = {
        voice: 'quoted-official',
        quotedSource: RENDERED_QUOTE_WITH_PROVENANCE,
      };
      for (const [, messages] of catalogs) {
        for (const message of renderCatalog(messages).filter((m) => m.path === path)) {
          expect(lintAlertText(message.text, context)).toStrictEqual([]);
        }
      }
    },
  );

  it('the statusShort badges do not clear, because they are not a quote', () => {
    // The counterpart to the test above. `messages.ts` documents `statusShort` as own
    // voice and `event-list.tsx` renders it as a bare badge with nothing attributing it,
    // so no provenance field can rescue it: the exemption is for relayed statements, and
    // this is the product speaking. Resolving it means changing what the badge says,
    // which is a founder decision about frozen copy, not a test fixture.
    for (const [, messages] of catalogs) {
      for (const label of Object.values(messages.statusShort)) {
        const asQuote = lintAlertText(label, {
          voice: 'quoted-official',
          quotedSource: RENDERED_QUOTE_WITH_PROVENANCE,
        });
        const asOwnVoice = lintAlertText(label, { voice: 'own' });
        expect(asQuote.length).toBeLessThanOrEqual(asOwnVoice.length);
      }
    }
    const ownVoiceBadges = catalogs.flatMap(([, messages]) =>
      Object.values(messages.statusShort).flatMap((label) =>
        lintAlertText(label, { voice: 'own' }),
      ),
    );
    expect(ownVoiceBadges).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------- */
/* The coverage guarantee itself                                              */
/* -------------------------------------------------------------------------- */

describe('coverage is exhaustive by construction', () => {
  it('refuses to skip a template it has no arguments for', () => {
    // The whole guarantee in one assertion: unregistered copy is a failure, not a gap.
    const catalogWithNewMessage = {
      ...bg,
      somethingAddedTomorrow: (place: string) => `Пожар край ${place}`,
    } as unknown as Messages;
    expect(() => renderCatalog(catalogWithNewMessage)).toThrow(CatalogCoverageError);
  });

  it('refuses a leaf shape it cannot render', () => {
    const catalogWithOddLeaf = { ...bg, detectionCount: 7 } as unknown as Messages;
    expect(() => renderCatalog(catalogWithOddLeaf)).toThrow(CatalogCoverageError);
  });

  it('has no stale argument registrations', () => {
    // A renamed or deleted message must not leave an entry behind: a registry with a key
    // for copy that no longer exists reads as more complete than it is.
    const rendered = new Set(renderCatalog(bg).map((message) => message.path));
    for (const path of Object.keys(MESSAGE_ARGUMENTS)) {
      expect(rendered.has(path)).toBe(true);
    }
  });

  it('renders both catalogs to the same set of paths', () => {
    // If `en.ts` were missing a key the walk would simply not reach it, and this file
    // would be linting less than it claims to.
    const paths = (messages: Messages): readonly string[] =>
      [...new Set(renderCatalog(messages).map((message) => message.path))].sort();
    expect(paths(en)).toStrictEqual(paths(bg));
  });
});

describe('the sentinels cannot change what matches', () => {
  it.each(catalogs)('stands as its own word everywhere it appears (%s)', (_locale, messages) => {
    // A sentinel fused to neighbouring letters would move a Unicode word boundary, and a
    // rule that should have fired might not. Checked rather than assumed: every sentinel
    // occurrence must be bounded by a non-word character (or the string edge) on each
    // side, which is exactly the boundary the never-send patterns match on.
    const wordCharacter = /[\p{L}\p{N}_]/u;
    for (const message of renderCatalog(messages)) {
      for (const sentinel of SENTINELS) {
        let index = message.text.indexOf(sentinel);
        while (index !== -1) {
          // The string edge counts as a boundary, so an absent neighbour reads as ''.
          const before = message.text[index - 1] ?? '';
          const after = message.text[index + sentinel.length] ?? '';
          expect(
            !wordCharacter.test(before) && !wordCharacter.test(after),
            `${message.path} fuses ${sentinel} into surrounding copy`,
          ).toBe(true);
          index = message.text.indexOf(sentinel, index + sentinel.length);
        }
      }
    }
  });

  it('is a word no rule knows, in either voice', () => {
    // The other half of the argument: the sentinels are not themselves lintable copy, so
    // their presence can never manufacture a finding.
    const sentence = `${SENTINELS.join(' ')} ${String(285_714)}`;
    expect(lintAlertText(sentence, { voice: 'own' })).toStrictEqual([]);
  });
});
