/**
 * The CI-10 fixture corpus for alert copy: good-must-pass / bad-must-fail (GLOSSARY §5.1
 * item 7; TASKS H6).
 *
 * Product-authored data, not generated. The fail side carries at minimum the eight
 * sentences §5.1 names and one paraphrase of every §3 string in each language; the pass
 * side carries the honest negations from §3/§3b/§5.2, rendered with their placeholders
 * filled, because those are the strings a naive word list would reject.
 *
 * Every fail entry pins the rule ids it must trip, in order of appearance, so a rule that
 * starts catching a sentence for the wrong reason is as visible as one that stops
 * catching it. A pass entry pins the empty list.
 *
 * The corpus is linted by `lint-corpus.test.ts` with the same function the gateway calls
 * before every send (`lintAlertText` from `@fire-watch/contracts`).
 */

import type { AlertLintRuleId, NeverSendContext } from '@fire-watch/contracts';

import type { AlertLocale } from './alert-copy.js';

export interface LintCorpusEntry {
  /** What the sentence is and why it is on this side. */
  readonly note: string;
  readonly locale: AlertLocale;
  readonly text: string;
  /** Own voice unless stated: the automatic templates never speak in any other. */
  readonly context?: NeverSendContext;
  /** The rule ids the lint must report, in order; empty for a must-pass entry. */
  readonly expect: readonly AlertLintRuleId[];
}

const QUOTED: NeverSendContext = {
  voice: 'quoted-official',
  quotedSource: {
    authority: 'ГДПБЗН',
    sourceUrl: 'https://www.gdpbzn.bg/',
    statementAt: '2026-08-12T09:00:00+03:00',
  },
};

const QUOTED_WITHOUT_LINK: NeverSendContext = {
  voice: 'quoted-official',
  quotedSource: { authority: 'ГДПБЗН', sourceUrl: null, statementAt: '2026-08-12T09:00:00+03:00' },
};

/** Must pass: the honest strings a word list would wrongly reject. */
export const LINT_CORPUS_PASS: readonly LintCorpusEntry[] = [
  // §3, rendered with placeholders filled.
  {
    note: '§3 active',
    locale: 'en',
    text: 'Actively detected — last satellite detection 14:05',
    expect: [],
  },
  {
    note: '§3 active',
    locale: 'bg',
    text: 'Активно засичане — последно сателитно засичане 14:05',
    expect: [],
  },
  {
    note: '§3 signal_weakening',
    locale: 'en',
    text: 'Weakening satellite signal over the last 3 passes — fires often re-intensify in the afternoon',
    expect: [],
  },
  {
    note: '§3 signal_weakening',
    locale: 'bg',
    text: 'Отслабващ сателитен сигнал през последните 3 наблюдения — пожарите често се разгарят отново следобед',
    expect: [],
  },
  {
    note: '§3 no_longer_detected — negates "out" on purpose',
    locale: 'en',
    text: 'No longer detected by satellites since 12/08/2026, 14:05. This does not mean the fire is out — satellites cannot see smoldering, burning under trees or through cloud.',
    expect: [],
  },
  {
    note: '§3 no_longer_detected — negates "изгасен" on purpose',
    locale: 'bg',
    text: 'Не се засича от сателити от 12.08.2026 г., 14:05. Това не означава, че пожарът е изгасен — сателитите не виждат тлеене, горене под короните или през облаци.',
    expect: [],
  },
  {
    note: '§3 archived',
    locale: 'en',
    text: 'Event archived: no satellite detections for 7 days. New nearby detections may reopen it as a possible reignition.',
    expect: [],
  },
  {
    note: '§3 archived',
    locale: 'bg',
    text: 'Събитието е архивирано: без сателитни засичания от 7 дни. Нови засичания наблизо могат да го отворят отново като възможно повторно разгаряне.',
    expect: [],
  },
  {
    note: '§3 officially_contained — quoted with link and timestamp',
    locale: 'en',
    context: QUOTED,
    text: 'Declared contained (локализиран) by authorities on 12/08/2026 — ГДПБЗН (https://www.gdpbzn.bg/). Containment means spread is stopped; the fire may still burn inside the perimeter.',
    expect: [],
  },
  {
    note: '§3 officially_extinguished — quoted with link and timestamp',
    locale: 'bg',
    context: QUOTED,
    text: 'Обявен за ликвидиран от властите на 12.08.2026 г. — ГДПБЗН (https://www.gdpbzn.bg/).',
    expect: [],
  },
  // §3b.
  {
    note: '§3b stale_sources',
    locale: 'en',
    text: 'Satellite data delayed since 14:05 — showing the last data we have. The absence of new detections is not evidence that the fire is out.',
    expect: [],
  },
  {
    note: '§3b stale_sources',
    locale: 'bg',
    text: 'Сателитните данни са забавени от 14:05 — показваме последните налични данни. Липсата на нови засичания не е доказателство, че пожарът е изгасен.',
    expect: [],
  },
  {
    note: '§3b empty_state — rule 4’s honest counterpart',
    locale: 'en',
    text: 'No satellite detections in this area. This is not a statement that there are no fires.',
    expect: [],
  },
  {
    note: '§3b empty_state',
    locale: 'bg',
    text: 'Няма сателитни засичания в тази зона. Това не означава, че няма пожари.',
    expect: [],
  },
  {
    note: '§3b cloud_blind_close',
    locale: 'en',
    text: 'No observation has been possible for 14 days — continuous cloud cover. We do not know whether this fire is still burning: the event is closed because we cannot see it, not because it is out.',
    expect: [],
  },
  {
    note: '§3b official_then_redetected — quoted with link and timestamp',
    locale: 'en',
    context: QUOTED,
    text: 'New satellite detections on 14/08/2026, 14:05, after the fire was declared extinguished by authorities on 12/08/2026 — ГДПБЗН (https://www.gdpbzn.bg/). Both facts are shown as they stand.',
    expect: [],
  },
  {
    note: '§3b official_then_redetected — quoted with link and timestamp',
    locale: 'bg',
    context: QUOTED,
    text: 'Нови сателитни засичания на 14.08.2026 г., 14:05, след като пожарът беше обявен за локализиран от властите на 12.08.2026 г. — ГДПБЗН (https://www.gdpbzn.bg/). Показваме и двата факта; не преценяваме кой от тях е меродавен.',
    expect: [],
  },
  // §5.2.
  {
    note: '§5.2 safety_no_travel — rule 7’s vocabulary, negated',
    locale: 'en',
    text: 'Do not travel toward the fire area — keep roads clear for responders.',
    expect: [],
  },
  {
    note: '§5.2 safety_no_travel',
    locale: 'bg',
    text: 'Не пътувайте към района на пожара — пазете пътищата свободни за спасителните екипи.',
    expect: [],
  },
  {
    note: '§5.2 agri_burn_tag',
    locale: 'bg',
    text: 'Земеделска земя — възможно селскостопанско палене.',
    expect: [],
  },
  {
    note: '§5.3 word boundaries — "out" inside other words, "safe" inside "safety"',
    locale: 'en',
    text: 'About the layout: a timeout in the outbox is logged; safety information is in the footer.',
    expect: [],
  },
];

/** Must fail: the §5.1 minimum set, one paraphrase of each §3 string per language, and more. */
export const LINT_CORPUS_FAIL: readonly LintCorpusEntry[] = [
  // §5.1 item 7, verbatim.
  {
    note: '§5.1 minimum',
    locale: 'en',
    text: 'the fire is out',
    expect: ['own-voice-extinguished'],
  },
  {
    note: '§5.1 minimum',
    locale: 'bg',
    text: 'пожарът е изгасен',
    expect: ['own-voice-extinguished'],
  },
  {
    note: '§5.1 minimum',
    locale: 'en',
    text: 'no fires in your area',
    expect: ['no-fires-reassurance'],
  },
  {
    note: '§5.1 minimum',
    locale: 'bg',
    text: 'няма пожари във вашия район',
    expect: ['no-fires-reassurance'],
  },
  { note: '§5.1 minimum', locale: 'en', text: 'safe to return', expect: ['all-clear'] },
  { note: '§5.1 minimum', locale: 'bg', text: 'можете да се върнете', expect: ['all-clear'] },
  {
    note: '§5.1 minimum',
    locale: 'en',
    text: 'heading for Ivaylovgrad',
    expect: ['directional-prediction'],
  },
  { note: '§5.1 minimum', locale: 'bg', text: 'евакуирайте се', expect: ['own-voice-evacuation'] },

  // One paraphrase of each §3 string, per language.
  {
    note: '§3 active paraphrased into control language',
    locale: 'en',
    text: 'Fire under control — last satellite detection 14:05',
    expect: ['own-voice-extinguished'],
  },
  {
    note: '§3 active paraphrased into control language',
    locale: 'bg',
    text: 'Пожарът е овладян — последно сателитно засичане 14:05',
    expect: ['own-voice-extinguished'],
  },
  {
    note: '§3 signal_weakening paraphrased into an all-clear',
    locale: 'en',
    text: 'Weakening satellite signal — the danger has passed',
    expect: ['all-clear'],
  },
  {
    note: '§3 signal_weakening paraphrased into an all-clear',
    locale: 'bg',
    text: 'Отслабващ сателитен сигнал — опасността премина',
    expect: ['all-clear'],
  },
  {
    note: '§3 no_longer_detected with its negation dropped',
    locale: 'en',
    text: 'No longer detected by satellites since 14:05. The fire is out.',
    expect: ['own-voice-extinguished'],
  },
  {
    note: '§3 no_longer_detected with its negation dropped',
    locale: 'bg',
    text: 'Не се засича от сателити от 14:05. Пожарът е изгасен.',
    expect: ['own-voice-extinguished'],
  },
  {
    note: '§3 officially_contained in own voice, no source',
    locale: 'en',
    text: 'The fire has been contained.',
    expect: ['own-voice-extinguished'],
  },
  {
    note: '§3 officially_contained in own voice, no source',
    locale: 'bg',
    text: 'Пожарът е локализиран.',
    expect: ['own-voice-extinguished'],
  },
  {
    note: '§3 officially_extinguished in own voice, no source',
    locale: 'en',
    text: 'The fire has been extinguished.',
    expect: ['own-voice-extinguished'],
  },
  {
    note: '§3 officially_extinguished in own voice, no source',
    locale: 'bg',
    text: 'Пожарът е ликвидиран.',
    expect: ['own-voice-extinguished'],
  },
  {
    note: '§3 archived paraphrased into an all-clear',
    locale: 'en',
    text: 'Event archived — the area is safe again.',
    expect: ['all-clear'],
  },
  {
    note: '§3 archived paraphrased into an all-clear',
    locale: 'bg',
    text: 'Събитието е архивирано — няма опасност.',
    expect: ['all-clear'],
  },

  // The failure modes the templates themselves could produce.
  {
    note: 'safety_no_travel cut mid-sentence by a character-count truncation',
    locale: 'en',
    text: 'Do not travel toward the fire',
    expect: ['approach-the-fire'],
  },
  {
    note: 'a quote missing its link loses the rule-2 exemption',
    locale: 'bg',
    context: QUOTED_WITHOUT_LINK,
    text: 'Пожарът е ликвидиран, съобщи ГДПБЗН.',
    expect: ['own-voice-extinguished'],
  },
  {
    note: 'rule 1 has no quote exemption: a quoted all-clear is still an all-clear',
    locale: 'en',
    context: QUOTED,
    text: 'ГДПБЗН: residents are safe to return.',
    // Two spans of one rule: "safe to return" and the bare "safe" inside it.
    expect: ['all-clear', 'all-clear'],
  },
  {
    note: 'responder presence in own voice',
    locale: 'bg',
    text: 'Пожарникарите са на място.',
    expect: ['responder-presence'],
  },
  {
    note: 'health advice',
    locale: 'en',
    text: 'Wear an N95 mask if you go outside.',
    expect: ['health-advice'],
  },
  {
    note: 'cause attribution',
    locale: 'bg',
    text: 'Вероятно палеж.',
    expect: ['cause-attribution'],
  },
];
