/**
 * The never-send list, as code (ADR-004 D7; 12 §3.4's 8 hard rules; GLOSSARY §5 and the
 * CI-10 specification in §5.1).
 *
 * The domain review's verdict is that false reassurance is the single largest harm this
 * product can cause, and that the harm is delivered by *words*, not by logic: a decision
 * function that correctly refuses to emit a "resolved" alert still ships the harm if the
 * template it selects says "the fire is out". So the list of forbidden sentences is not
 * documentation to be honoured by whoever writes the next template — it is a function,
 * and ADR-004 D7 requires that a template tripping it **fails CI, not runtime**.
 *
 * Three design commitments follow from that, and each is load-bearing:
 *
 *   - **It reports, it does not decide.** {@link lintAlertText} returns *every* violation
 *     it finds and throws on none of them. CI wants the whole list in one run so a
 *     template author fixes one string once; the gateway wants the rule ids to log; a
 *     future copy-review tool wants the spans. {@link assertSendable} is the hard form
 *     for the call site that genuinely cannot proceed — the pre-send guard of D7's "same
 *     code path at runtime" (CI-10 §5.8) — and it is three lines on top of the same scan.
 *   - **The quoted-official exemption is modelled, not wished away.** Hard rules 2, 3 and
 *     6 exist to stop us *asserting* containment, an evacuation order, or who is on
 *     scene; they were never meant to stop us *relaying* an authority that did. CI-10
 *     §5.5 makes that exemption conditional on the rendered span carrying both a source
 *     link and a statement timestamp, and rule 3 adds that the copy must lead with the
 *     authority's name rather than ours. A lint that could not express "quoted,
 *     attributed, authority-led" would push every `officially_*` template into an
 *     allowlist, which is how a policy quietly stops being enforced. Rules 1, 4, 5, 7 and
 *     8 have **no** exemption at any voice: a quoted all-clear is still an all-clear on
 *     our surface.
 *   - **The banned list alone would reject our most honest copy.** GLOSSARY §3/§3b's
 *     fixed strings say "This does not mean the fire is out" and "This is not a statement
 *     that there are no fires" — sentences whose entire purpose is to negate a banned
 *     word. CI-10 §5.6 answers that with whole-frozen-string allowlisting, never
 *     per-word, so that one character of paraphrase loses the exemption. {@link
 *     FROZEN_HONEST_COPY} is that allowlist for the strings the product owns; callers add
 *     their own template-scoped spans through {@link NeverSendContext.allowlist}.
 *
 * On matching: the product's copy is Bulgarian first, and Bulgarian is inflected, so a
 * literal word list would catch `изгасен` and miss `изгасената`. Full morphology is not
 * the honest tool at this size — a documented stem plus a bounded Cyrillic tail is, and
 * it is written down here rather than generated so that a reviewer can see exactly which
 * words each rule claims. Matching is on Unicode word boundaries (CI-10 §5.3), because
 * JavaScript's `\b` is ASCII-only: it fires inside Cyrillic words and refuses to fire at
 * their edges, and substring matching is what makes `out` reject `outbox`.
 *
 * What this module deliberately does not do is render, choose templates, or read a
 * clock. It takes rendered text and returns findings; CI-10 renders the corpus, the
 * gateway renders the alert, and both call the same function.
 *
 * It lives in the shared contracts package rather than under `server/` because CI-10 is
 * one gate over one list: the alert templates the gateway sends and the UI copy the web
 * renders are checked by the *same* function, and neither side may import the other. Two
 * copies of this list would drift, and the copy that drifted would be the one nobody was
 * watching.
 */

/* -------------------------------------------------------------------------- */
/* Matching primitives                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Unicode word boundaries (CI-10 §5.3). `\b` is defined over `[A-Za-z0-9_]`, so `\bизгасен\b`
 * matches inside `неизгасен` and fails at the start of a Cyrillic sentence. These
 * lookarounds are the boundary the spec actually asks for, and they are what keeps `out`
 * off *outbox*, *about*, *layout*, *timeout* and *burnout*.
 */
const LEFT = '(?<![\\p{L}\\p{N}_])';
const RIGHT = '(?![\\p{L}\\p{N}_])';

/**
 * The separator inside a multi-word entry: "a single run of whitespace, ignoring
 * intervening punctuation" (CI-10 §5.3), so `safe, to return` and `safe — to return`
 * both count. Sentence terminators (`.!?;:`) are excluded on purpose — with them in the
 * class, "there are no. Fires spread fast" would read as "no fires".
 */
const GAP = '(?:\\s|[-–—/,"\'«»„“”’()\\[\\]])+';

/**
 * Bulgarian inflection, handled as a stem plus a bounded Cyrillic tail rather than as a
 * morphology engine (CI-10 §5.4 wants lemma + inflection set; this is the honest small
 * version of it). Six letters covers the gender/number/definite ladder that matters —
 * изгасен / изгасена / изгасени / изгасеният / изгасените, локализиран / локализираният —
 * and the bound plus {@link RIGHT} means a longer unrelated word is *not* matched at all
 * rather than matched halfway.
 */
const BG_TAIL = '\\p{Script=Cyrillic}{0,6}';

/** The same idea for English: `extinguish` + ed/ing/ment, `evacuat` + e/ed/ing/ion(s). */
const EN_TAIL = '[a-z]{0,6}';

/** A stem entry: the lemma prefix plus every inflection within the tail bound. */
const bgStem = (stem: string): string => `${stem}${BG_TAIL}`;

/** As {@link bgStem}, for Latin-script vocabulary. */
const enStem = (stem: string): string => `${stem}${EN_TAIL}`;

/** Join words of a multi-word entry with the punctuation-tolerant {@link GAP}. */
const phrase = (...words: readonly string[]): string => words.join(GAP);

/**
 * Compile one vocabulary entry. Global because {@link String.prototype.matchAll} requires
 * it; safe to share across calls because `matchAll` iterates a copy and never advances
 * `lastIndex` on the original.
 */
const rx = (source: string): RegExp => new RegExp(`${LEFT}(?:${source})${RIGHT}`, 'gu');

/**
 * Fold text for matching: NFC first (CI-10 §5.3), then Bulgarian-aware lowercasing, so
 * every pattern below can be written in lower case exactly once.
 */
const fold = (text: string): string => text.normalize('NFC').toLocaleLowerCase('bg');

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

export const NEVER_SEND_RULE_IDS = [
  'all-clear',
  'own-voice-extinguished',
  'own-voice-evacuation',
  'no-fires-reassurance',
  'directional-prediction',
  'responder-presence',
  'approach-the-fire',
  'health-advice',
  'cause-attribution',
] as const;

export type NeverSendRuleId = (typeof NEVER_SEND_RULE_IDS)[number];

export const FOOTER_RULE_IDS = [
  'footer-attribution',
  'footer-lance-disclaimer',
  'footer-scope-of-service',
] as const;

export type FooterRuleId = (typeof FOOTER_RULE_IDS)[number];

/** Every id the lint can report. The gateway logs these; H6's wording lints assert them. */
export type AlertLintRuleId = NeverSendRuleId | FooterRuleId;

/**
 * How far an attributed official quote can lift a rule (CI-10 §5.5).
 *
 * `none` is the majority and the important one: five of the eight hard rules are banned
 * in every voice, because relaying them does not make them less false on our surface.
 */
export const RULE_EXEMPTIONS = ['none', 'attributed-quote', 'authority-led-quote'] as const;

export type RuleExemption = (typeof RULE_EXEMPTIONS)[number];

export interface NeverSendRule {
  readonly id: NeverSendRuleId;
  /** The numbered hard rule in 12 §3.4, or `null` for a §3.3 standing deferral. */
  readonly hardRule: number | null;
  readonly summary: string;
  readonly exemption: RuleExemption;
  /** The vocabulary this rule matches, compiled. Exported so CI can report on coverage. */
  readonly patterns: readonly RegExp[];
}

export const NEVER_SEND_RULES: readonly NeverSendRule[] = [
  {
    id: 'all-clear',
    hardRule: 1,
    summary: 'No "all clear", "safe", "safe to return" or "the danger has passed", in any voice.',
    // No exemption, ever (CI-10 §5.5). We have no way to know an area is safe — the
    // satellite that would tell us cannot see smouldering (12 §4.2) — and an all-clear
    // relayed from someone else still arrives as ours.
    exemption: 'none',
    patterns: [
      // "all clear" is the canonical phrasing of the harm; the hyphenated form is one
      // character away and GAP treats the hyphen as a separator.
      rx(phrase('all', 'clear')),
      // Bare `safe` is *not* banned: "keep a safe distance" is legitimate and CI-10 §5.3
      // warns explicitly that `safe` must not fire on `safety` in the footer. The harm is
      // the predicate — telling a reader that they, or a place, are safe.
      rx(phrase('(?:is|are|was|were|now|feels|remains)', 'safe')),
      rx(phrase('safe', 'to', '(?:return|go|come)')),
      rx(phrase('you', '(?:can|may|are able to)', '(?:return|go back|come back|come home)')),
      rx(phrase('(?:no longer|not)', 'in', 'danger')),
      rx(phrase('(?:no|without)', 'danger')),
      rx(phrase('danger', '(?:has passed|passed|is over|is gone)')),
      rx(phrase('threat', '(?:has passed|passed|is over)')),
      // BG: the exact strings the review names. "няма опасност" and "опасността премина"
      // are how a Bulgarian all-clear is actually worded on municipal channels.
      rx(phrase('няма', bgStem('опасн'))),
      rx(phrase(bgStem('опасност'), bgStem('премин'))),
      rx(phrase(bgStem('опасност'), 'е', bgStem('премин'))),
      rx(phrase(bgStem('безопасн'), 'е')),
      rx(phrase('в', bgStem('безопасност'))),
      rx(phrase('можете', 'да', 'се', '(?:върнете|приберете)')),
    ],
  },
  {
    id: 'own-voice-extinguished',
    hardRule: 2,
    summary:
      'No "extinguished"/"contained"/"out"/"under control" from our own data — quoted, attributed official statements only.',
    // Rule 2 is the exemptible one: the curated officially_* tier exists precisely so an
    // authority's ликвидиран can be relayed with a link and a timestamp (GLOSSARY §3).
    exemption: 'attributed-quote',
    patterns: [
      // "out" is the whole reason ADR-002's internal state was renamed away from it. It is
      // matched only as a predicate about the fire, because bare `out` in English is far
      // too common to ban outright ("spreads out", "burned-out vehicles").
      rx(phrase('(?:fire|fires|blaze|wildfire|it|they)', '(?:is|are|was|were)', 'out')),
      rx(`(?:put|putting)${GAP}(?:(?:it|the${GAP}fires?)${GAP})?out`),
      rx(phrase('(?:went|gone)', 'out')),
      rx(enStem('extinguish')),
      rx(phrase('under', 'control')),
      // "contained" is starred quote-only in GLOSSARY §5: локализиран means spread has
      // stopped, NOT that the fire is out (12 §4.1), and Sakar 2025 re-flared repeatedly
      // inside "contained" perimeters. Used as reassurance in our voice it is rule 1.
      rx(enStem('contain')),
      rx(phrase('no', 'longer', 'burning')),
      rx(phrase('(?:burned|burnt)', 'out')),
      // BG. изгас* / потуш* are the plain-language "extinguished" the review bans outright;
      // ликвидир* and локализир* are the two official milestones (12 §4.1) that are only
      // ever ours to quote. овладя*/обезопас* are the same claim in operational dress.
      rx(bgStem('изгас')),
      rx(bgStem('потуш')),
      rx(bgStem('ликвидир')),
      rx(bgStem('локализир')),
      rx(bgStem('овладя')),
      rx(bgStem('обезопас')),
      rx(phrase('под', 'контрол')),
    ],
  },
  {
    id: 'own-voice-evacuation',
    hardRule: 3,
    summary:
      'No "evacuate" / "prepare to evacuate" in our own voice — only an official order, attributed, with the authority named first.',
    // Not merely attributed: 12 §3.4 rule 3 says "the push copy must lead with the
    // authority's name, not ours". A notification that opens with our brand and then says
    // "evacuate" reads as our order no matter what the second sentence attributes.
    exemption: 'authority-led-quote',
    patterns: [
      rx(enStem('evacuat')),
      rx(phrase('leave', '(?:now|immediately|at once|the area)')),
      rx(phrase('get', 'out', '(?:now|immediately)')),
      rx(phrase('prepare', 'to', '(?:leave|go)')),
      // BG: евакуа* covers евакуация/евакуационен, евакуир* covers евакуирайте/евакуиран.
      rx(bgStem('евакуа')),
      rx(bgStem('евакуир')),
      rx(phrase('подгответе', 'се', 'за')),
      rx(phrase(bgStem('напусн'), '(?:незабавно|веднага|района|зоната)')),
    ],
  },
  {
    id: 'no-fires-reassurance',
    hardRule: 4,
    summary: 'An empty state says "no satellite detections", never "no fires in your area".',
    // No exemption. The two sentences differ by one word and by everything else: we know
    // what our satellites saw, and we never know what is burning (12 §4.2).
    exemption: 'none',
    patterns: [
      rx(
        `no${GAP}(?:active${GAP}|current${GAP}|known${GAP}|nearby${GAP}|new${GAP})?(?:wild)?fires`,
      ),
      rx(
        `no${GAP}(?:wild)?fire${GAP}(?:in${GAP}your${GAP}area|near${GAP}you|nearby|around${GAP}you)`,
      ),
      rx(phrase('nothing', '(?:is )?burning')),
      rx(phrase('there', 'is', 'no', 'fire')),
      // BG. "няма пожари" is the exact sentence the empty state must not say; the honest
      // form is "няма сателитни засичания" (GLOSSARY §3b `empty_state`).
      rx(`няма${GAP}(?:активни${GAP}|нови${GAP}|известни${GAP})?пожари`),
      rx(`няма${GAP}пожар${GAP}(?:във|в|близо|наблизо|около)`),
      rx(phrase('нищо', 'не', 'гори')),
    ],
  },
  {
    id: 'directional-prediction',
    hardRule: 5,
    summary: 'Wind context yes, trajectory claims no — never "the fire is heading for X".',
    // No exemption. A 3 h-late detection cannot support a claim about where a fire will
    // be, and a wrong one moves people into its path (12 §5).
    exemption: 'none',
    patterns: [
      rx(phrase('heading', '(?:for|to|toward|towards)')),
      rx(phrase('(?:moving|spreading|advancing)', '(?:toward|towards|on)')),
      rx(phrase('(?:will|expected to|about to|on track to)', '(?:reach|hit|arrive)')),
      rx(phrase('in', 'the', 'path', 'of')),
      // BG: "пожарът се насочва към" is the exact banned string in GLOSSARY §5.
      rx(phrase('се', bgStem('насочв'), 'към')),
      rx(phrase('(?:ще|може да)', bgStem('достигн'))),
      rx(phrase(bgStem('движ'), 'се', 'към')),
      rx(phrase('очаква', 'се', 'да', bgStem('достигн'))),
    ],
  },
  {
    id: 'responder-presence',
    hardRule: 6,
    summary:
      'No claim that firefighters are — or are not — on scene, unless quoting an attributed source.',
    // Exemptible: relaying "ГДПБЗН reports four crews on scene — source" is the point of
    // the curated tier. Asserting it ourselves is a claim about an operation we cannot
    // see; asserting the negative is worse, because it reads as abandonment.
    exemption: 'attributed-quote',
    patterns: [
      rx(
        `(?:firefighters|responders|crews|fire${GAP}crews|teams)${GAP}(?:are|were|aren[\u2019']t|weren[\u2019']t|(?:are|were)${GAP}not)${GAP}(?:on${GAP}(?:the${GAP})?scene|on${GAP}site|at${GAP}the${GAP}scene|present|there|fighting|working)`,
      ),
      rx(
        `no${GAP}(?:firefighters|crews|responders|teams)${GAP}(?:on|at)${GAP}(?:the${GAP})?(?:scene|site)`,
      ),
      // BG: "пожарникарите са на място" is the banned string named in GLOSSARY §5.
      rx(
        `(?:пожарникарите|огнеборците|екипите|пожарната)${GAP}(?:са|не${GAP}са)${GAP}(?:на${GAP}място|на${GAP}терен|там)`,
      ),
      rx(`няма${GAP}(?:екипи|пожарникари|огнеборци)${GAP}на${GAP}(?:място|терен)`),
    ],
  },
  {
    id: 'approach-the-fire',
    hardRule: 7,
    summary: 'Never send anyone toward a fire — including "go and verify, then report back".',
    // No exemption, and the one rule where a well-meant crowdsourcing feature is the
    // likely author of the violation. The counterpart positive obligation is the
    // `safety_no_travel` line (12 H2), which is allowlisted in FROZEN_HONEST_COPY because
    // it contains the very words this rule bans, negated.
    exemption: 'none',
    patterns: [
      rx(
        `(?:go|head|drive|travel|walk|move)${GAP}(?:to|toward|towards|out${GAP}to|up${GAP}to|into)${GAP}(?:the${GAP})?(?:fire|site|scene|area|smoke)`,
      ),
      rx(phrase('verify', 'and', '(?:report|tell)')),
      rx(phrase('report', 'back')),
      rx(phrase('check', '(?:it|the fire|the area)', '(?:yourself|in person|on site)')),
      rx(phrase('come', '(?:and )?(?:see|look|take a look)')),
      // BG
      rx(
        `(?:отидете|идете|пътувайте|тръгнете|приближете)${GAP}(?:до|към|на|в)${GAP}(?:пожара|мястото|района|огъня)`,
      ),
      rx(phrase('проверете', '(?:на място|лично|сами)')),
      rx(phrase('проверете', 'и', '(?:ни )?(?:съобщете|докладвайте|пишете)')),
      rx(phrase('елате', '(?:да )?(?:видите|погледнете)')),
    ],
  },
  {
    id: 'health-advice',
    hardRule: 8,
    summary:
      'Smoke guidance is generic and sourced ("close windows; official guidance: link") — nothing prescriptive, and no reassurance about air.',
    // No exemption. This rule has two halves and the second is the dangerous one: telling
    // a reader the air is fine is rule 1 wearing a lab coat, and we have no air-quality
    // measurement at all.
    exemption: 'none',
    patterns: [
      rx(`(?:wear|put${GAP}on|use)${GAP}(?:(?:an?|your)${GAP})?(?:n95|ffp2|ffp3|mask|respirator)`),
      rx(`(?:take|use)${GAP}(?:your${GAP})?(?:medication|inhaler|antihistamine)`),
      rx(phrase('(?:see|consult|call)', 'a', '(?:doctor|physician)')),
      rx(phrase('seek', 'medical')),
      rx(phrase('(?:air|smoke)', '(?:is|are)', '(?:safe|harmless|clean|fine|not harmful)')),
      rx(phrase('safe', 'to', 'breathe')),
      rx(phrase('no', 'health', '(?:risk|risks|effects|impact)')),
      rx(phrase('(?:not|no longer)', 'harmful')),
      // BG
      rx(phrase('(?:носете|сложете|поставете)', '(?:си )?маска')),
      rx(phrase('(?:потърсете|посетете|извикайте)', bgStem('лекар'))),
      rx(phrase('(?:приемете|вземете)', bgStem('лекарств'))),
      rx(phrase('няма', 'опасност', 'за', bgStem('здраве'))),
      rx(phrase('(?:въздухът|димът)', 'е', '(?:безопасен|чист|безвреден)')),
      rx(phrase('не', 'е', bgStem('вред'))),
    ],
  },
  {
    id: 'cause-attribution',
    // Not one of the eight numbered rules: 12 §3.3 lists cause attribution among the
    // things we defer *always* ("never; it is criminal-investigation territory"), and
    // GLOSSARY §5's banned vocabulary carries `arson` / `палеж` for the lint. It gets its
    // own id rather than being folded into another rule because the gateway logs ids and
    // "we called a fire arson" is not a variant of any of the eight.
    hardRule: null,
    summary: 'Cause is never ours to state — no "arson", no "deliberately set" (12 §3.3).',
    exemption: 'none',
    patterns: [
      rx(enStem('arson')),
      rx(phrase('(?:deliberately|intentionally|maliciously)', '(?:set|started|lit)')),
      rx(phrase('(?:set|started|lit)', '(?:deliberately|intentionally|on purpose)')),
      // BG: `палеж` only — never the stem `пал`, because the `agri_burn_tag` copy says
      // "възможно селскостопанско палене" (a burn, not an act of arson) and must pass.
      rx(bgStem('палеж')),
      rx(bgStem('подпалвач')),
      rx(phrase(bgStem('умишлен'), bgStem('запал'))),
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Footer obligations (ADR-004 D7)                                            */
/* -------------------------------------------------------------------------- */

interface FooterEvidence {
  /** What this group of alternatives proves is present, phrased for the CI report. */
  readonly label: string;
  /** Any one of these is enough. */
  readonly anyOf: readonly RegExp[];
}

export interface FooterRequirement {
  readonly id: FooterRuleId;
  readonly summary: string;
  /** Every group must be satisfied; within a group, one match is enough. */
  readonly evidence: readonly FooterEvidence[];
}

/**
 * D7's three positive obligations on every alert footer.
 *
 * These are marker checks, not exact-string comparisons, and that is deliberate: a
 * rendered footer carries a live link and a timestamp its template does not, so a frozen
 * compare would fail on every real alert while catching nothing. The failure mode worth
 * catching is a whole clause dropped from a template, and a marker catches exactly that.
 * CI-11 owns the stricter "did the wording drift" question.
 */
export const FOOTER_REQUIREMENTS: readonly FooterRequirement[] = [
  {
    id: 'footer-attribution',
    summary: 'The footer names the data source the alert is derived from (09 §2.2.A).',
    evidence: [
      {
        label: 'a named data source (FIRMS/NASA/LANCE/EFFIS/EUMETSAT)',
        anyOf: [rx('firms'), rx('nasa'), rx('lance'), rx('effis'), rx('eumetsat')],
      },
    ],
  },
  {
    id: 'footer-lance-disclaimer',
    summary:
      'The footer mirrors LANCE\'s "not advised for tactical decision-making" disclaimer (09 §2.2.A).',
    evidence: [
      {
        label: 'the "tactical decision-making" disclaimer',
        anyOf: [
          rx(phrase('tactical', '(?:decision|decisions|decision-making)')),
          rx(phrase(bgStem('тактическ'), bgStem('решени'))),
        ],
      },
    ],
  },
  {
    id: 'footer-scope-of-service',
    summary:
      'The footer states the scope of service — best-effort informational monitoring — and points at 112.',
    // Two groups, because half of this sentence is the dangerous half to lose. "Call 112"
    // without the scope claim reads as an emergency service; the scope claim without 112
    // leaves a reader with nowhere to go.
    evidence: [
      {
        label: 'the scope-of-service claim',
        anyOf: [
          rx(phrase('best', 'effort')),
          rx(phrase('informational', 'monitoring')),
          rx(phrase(bgStem('информационн'), bgStem('наблюдение'))),
          rx(phrase(bgStem('информационн'), bgStem('услуг'))),
        ],
      },
      {
        label: 'the emergency-number instruction (112)',
        anyOf: [rx('112')],
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Allowlist                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The product's own frozen sentences that contain a banned word in order to negate it
 * (GLOSSARY §3, §3b and §5.2; CI-10 §5.6).
 *
 * Whole strings, never per-word: one character of drift loses the exemption and the
 * paraphrase fails this lint and CI-11 at once, which is the coupling the spec wants.
 * Only placeholder-free sentences can live here — a string with a `<date>` in it cannot be
 * compared against rendered output, so those templates carry their spans through
 * {@link NeverSendContext.allowlist} instead.
 */
export const FROZEN_HONEST_COPY: readonly string[] = [
  // `no_longer_detected` — the sentence that exists to stop a reader inferring "out".
  'This does not mean the fire is out — satellites cannot see smoldering, burning under trees or through cloud.',
  'Това не означава, че пожарът е изгасен — сателитите не виждат тлеене, горене под короните или през облаци.',
  // `stale_sources`
  'The absence of new detections is not evidence that the fire is out.',
  'Липсата на нови засичания не е доказателство, че пожарът е изгасен.',
  // `cloud_blind_close`
  'We do not know whether this fire is still burning: the event is closed because we cannot see it, not because it is out.',
  'Не знаем дали пожарът още гори: събитието е затворено, защото не можем да наблюдаваме, а не защото пожарът е изгасен.',
  // `empty_state` — rule 4's honest counterpart.
  'No satellite detections in this area. This is not a statement that there are no fires.',
  'Няма сателитни засичания в тази зона. Това не означава, че няма пожари.',
  // `officially_contained` — the gloss that stops "contained" being read as "out".
  'Containment means spread is stopped; the fire may still burn inside the perimeter.',
  'Локализиран означава спряно разпространение; пожарът може още да гори в периметъра.',
  // `safety_no_travel` (12 H2) — mandatory copy built from rule 7's own vocabulary.
  'Do not travel toward the fire area — keep roads clear for responders.',
  'Не пътувайте към района на пожара — пазете пътищата свободни за спасителните екипи.',
];

/* -------------------------------------------------------------------------- */
/* Context and findings                                                       */
/* -------------------------------------------------------------------------- */

export const ALERT_VOICES = ['own', 'quoted-official'] as const;

export type AlertVoice = (typeof ALERT_VOICES)[number];

/**
 * The official statement a span relays.
 *
 * `sourceUrl` and `statementAt` are nullable rather than required because CI-10 §5.5
 * turns on exactly this: the exemption applies "only when the rendered span carries both
 * a `source_url` and a `statement_ts`". A quote missing either is not an attributed quote,
 * and the resulting violation says which half was missing rather than failing silently.
 */
export interface QuotedSource {
  /** The authority as the copy names it — 'ГДПБЗН', 'Областният управител на Ямбол'. */
  readonly authority: string;
  /** CI-10 §5.5's `source_url`; `null` when the template does not carry one. */
  readonly sourceUrl: string | null;
  /** CI-10 §5.5's `statement_ts`, ISO-8601; `null` when the template does not carry one. */
  readonly statementAt: string | null;
}

export interface NeverSendContext {
  /**
   * Whose voice the text is in. `own` is the default posture and the only one the
   * automatic templates ever use; `quoted-official` belongs to the curated `officially_*`
   * tier and to relayed orders.
   */
  readonly voice: AlertVoice;
  /** The statement being relayed. Required for any exemption to apply. */
  readonly quotedSource?: QuotedSource | null;
  /**
   * Extra frozen strings allowlisted for this template (CI-10 §5.6), added to
   * {@link FROZEN_HONEST_COPY}. Whole strings only — a per-word allowlist is how a policy
   * dies.
   */
  readonly allowlist?: readonly string[];
}

export interface NeverSendViolation {
  readonly ruleId: AlertLintRuleId;
  /** The numbered hard rule in 12 §3.4, or `null` where the obligation has another home. */
  readonly hardRule: number | null;
  readonly summary: string;
  /** The offending span as it appeared, or `null` for a missing positive obligation. */
  readonly match: string | null;
  /** Index of `match` in the linted text; `null` for a missing positive obligation. */
  readonly index: number | null;
  /** Why this fired here — including why a quoted-source exemption did not save it. */
  readonly reason: string;
}

/**
 * The text surface D7 lints: everything an alert says, and nothing about how it is sent.
 *
 * This is deliberately *not* the server's `RenderedAlert`, and the two are not one type
 * wearing two names. `RenderedAlert` (`server/src/core/ports/alert-channel.ts`) is a
 * delivery payload: it carries a deep link and a mandatory title because a channel
 * adapter needs both, and nothing outside the server ever holds one. This package is
 * imported verbatim by the browser bundle, so declaring the delivery payload here would
 * put a type the web can never render into the shared vocabulary — while declaring the
 * lint's input over there would leave the web unable to lint its own copy against the
 * same list, which is the whole reason this module moved into contracts.
 *
 * So the port's `RenderedAlert` `extends` this interface. That is the only direction the
 * dependency rules allow (server may import contracts, never the reverse), and it turns
 * "every alert we can deliver is an alert we can lint" into a compiler check rather than
 * a comment asking two files to stay in step.
 *
 * `title` is optional because a channel may not have one — but where it exists it is
 * linted like any other prose. A push title is the only text most recipients read, and it
 * is exactly the place a forbidden all-clear would do the most damage.
 */
export interface LintableAlert {
  readonly title?: string;
  readonly body: string;
  readonly footer: string;
}

export class NeverSendError extends Error {
  readonly violations: readonly NeverSendViolation[];

  constructor(violations: readonly NeverSendViolation[]) {
    super(
      `alert text violates the never-send list (${String(violations.length)} finding(s)): ` +
        violations.map((violation) => `${violation.ruleId} — ${violation.reason}`).join('; '),
    );
    this.name = 'NeverSendError';
    this.violations = violations;
  }
}

/* -------------------------------------------------------------------------- */
/* The lint                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every never-send violation in `text`, in the order they appear.
 *
 * Throws only on programmer error — a non-string subject, an unknown voice, a quoted
 * source with no authority — never on a violation, because CI wants the full list and the
 * gateway wants to log before it refuses.
 */
export function lintAlertText(
  text: string,
  context: NeverSendContext,
): readonly NeverSendViolation[] {
  if (typeof text !== 'string') {
    throw new TypeError(`alert text must be a string, got ${typeof text}`);
  }
  assertContext(context);

  const normalized = text.normalize('NFC');
  const folded = normalized.toLocaleLowerCase('bg');
  // Folding is length-preserving for every character the product ships, but not for every
  // character in Unicode. Reporting spans from the folded string when the lengths diverge
  // costs a lower-cased report and keeps the offsets honest.
  const spanSource = folded.length === normalized.length ? normalized : folded;
  const allowed = allowlistedRanges(folded, context);

  const violations: NeverSendViolation[] = [];
  const seen = new Set<string>();
  for (const rule of NEVER_SEND_RULES) {
    // Resolved once per rule, not once per match: the exemption is a property of the rule
    // and the context, and computing it per hit would make a 40-pattern scan quadratic in
    // nothing useful.
    const exemption = exemptionFor(rule, context, folded);
    if (exemption.exempt) {
      continue;
    }
    for (const pattern of rule.patterns) {
      for (const found of matchesOf(pattern, folded)) {
        if (isInsideAllowlisted(found.start, found.end, allowed)) {
          continue;
        }
        // Two patterns of one rule can cover the same span; that is one finding, not two.
        const key = `${rule.id}:${String(found.start)}:${String(found.end)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        violations.push({
          ruleId: rule.id,
          hardRule: rule.hardRule,
          summary: rule.summary,
          match: spanSource.slice(found.start, found.end),
          index: found.start,
          reason: exemption.reason,
        });
      }
    }
  }
  return violations.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

/**
 * Every footer obligation `footer` fails to meet (ADR-004 D7).
 *
 * Positive checks only — the banned vocabulary is {@link lintAlertText}'s job, and
 * {@link lintAlert} runs both over the footer because a banned word does not become legal
 * by being printed in small type.
 */
export function lintAlertFooter(footer: string): readonly NeverSendViolation[] {
  if (typeof footer !== 'string') {
    throw new TypeError(`alert footer must be a string, got ${typeof footer}`);
  }
  const folded = fold(footer);

  const violations: NeverSendViolation[] = [];
  for (const requirement of FOOTER_REQUIREMENTS) {
    for (const group of requirement.evidence) {
      if (group.anyOf.some((pattern) => matchesOf(pattern, folded).length > 0)) {
        continue;
      }
      violations.push({
        ruleId: requirement.id,
        hardRule: null,
        summary: requirement.summary,
        match: null,
        index: null,
        reason: `footer is missing ${group.label}`,
      });
    }
  }
  return violations;
}

/** Body and footer in one pass — the shape a template actually renders. */
export function lintAlert(
  alert: LintableAlert,
  context: NeverSendContext,
): readonly NeverSendViolation[] {
  return [
    ...(alert.title === undefined ? [] : lintAlertText(alert.title, context)),
    ...lintAlertText(alert.body, context),
    ...lintAlertText(alert.footer, context),
    ...lintAlertFooter(alert.footer),
  ];
}

/**
 * The hard form of {@link lintAlert}, for the call site that cannot proceed — D7's
 * pre-send guard, and the assertion CI-10 runs over the rendered corpus.
 */
export function assertSendable(alert: LintableAlert, context: NeverSendContext): void {
  const violations = lintAlert(alert, context);
  if (violations.length > 0) {
    throw new NeverSendError(violations);
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Every span `pattern` matches in `folded`.
 *
 * Goes through `matchAll` rather than `RegExp.test`/`exec` because the patterns are
 * module-level and global: `test` advances `lastIndex` on the shared object, so the second
 * call on the same regex starts halfway through the text and the lint silently stops
 * finding things. `matchAll` iterates a copy.
 */
function matchesOf(pattern: RegExp, folded: string): readonly Span[] {
  return Array.from(folded.matchAll(pattern), (found) => ({
    start: found.index,
    end: found.index + found[0].length,
  }));
}

function assertContext(context: NeverSendContext): void {
  if (!(ALERT_VOICES as readonly string[]).includes(context.voice)) {
    throw new RangeError(
      `unknown alert voice ${JSON.stringify(context.voice)}; expected one of ${ALERT_VOICES.join(', ')}`,
    );
  }
  const source = context.quotedSource;
  // An attribution with no authority in it cannot be checked against the copy, and a
  // template that produced one has a binding bug rather than a wording problem.
  if (source != null && source.authority.trim() === '') {
    throw new TypeError('a quoted source must name the authority it attributes the statement to');
  }
}

/** Exempt, or not exempt with the reason that becomes the violation's. */
type ExemptionOutcome =
  { readonly exempt: true } | { readonly exempt: false; readonly reason: string };

/**
 * Whether an attributed official quote lifts this rule here (CI-10 §5.5).
 *
 * The reason string is the useful half: "banned in every voice" and "quoted, but the
 * template carries no source link" send a template author to two different fixes.
 */
function exemptionFor(
  rule: NeverSendRule,
  context: NeverSendContext,
  folded: string,
): ExemptionOutcome {
  if (rule.exemption === 'none') {
    const provenance = rule.hardRule === null ? '12 §3.3' : `12 §3.4 rule ${String(rule.hardRule)}`;
    return {
      exempt: false,
      reason: `banned in every voice (${provenance}); there is no quoted-source exemption`,
    };
  }
  if (context.voice !== 'quoted-official') {
    return { exempt: false, reason: 'stated in our own voice, not as an attributed quote' };
  }
  const source = context.quotedSource;
  if (source == null) {
    return { exempt: false, reason: 'declared a quote but carries no attributed source' };
  }
  // Bare noun phrases, no articles: the sentence below supplies the determiner once per
  // fragment as `no …`, so a fragment carrying its own would read "no a source link".
  const missing: string[] = [];
  if (source.sourceUrl === null) {
    missing.push('source link');
  }
  if (source.statementAt === null) {
    missing.push('statement timestamp');
  }
  if (missing.length > 0) {
    return {
      exempt: false,
      reason: `quoted, but the span carries no ${missing.join(' and no ')} (CI-10 §5.5)`,
    };
  }
  if (rule.exemption === 'authority-led-quote' && !leadsWithAuthority(folded, source.authority)) {
    return {
      exempt: false,
      reason: `quoted and attributed, but the copy does not lead with ${source.authority} (12 §3.4 rule 3)`,
    };
  }
  return { exempt: true };
}

/**
 * Whether the copy opens with the authority's name (12 §3.4 rule 3).
 *
 * Strict on purpose: "leads with" means first, not "mentions somewhere". Only opening
 * quotation marks and brackets may precede the name, because those are typography, not
 * voice — anything else in front of it, our brand above all, makes the order read as ours.
 */
function leadsWithAuthority(folded: string, authority: string): boolean {
  const opening = folded.replace(/^[\s"'«„“‘([]+/u, '');
  return opening.startsWith(fold(authority));
}

/** Where the frozen allowlisted strings sit in this text, so matches inside them are dropped. */
function allowlistedRanges(folded: string, context: NeverSendContext): readonly Span[] {
  const spans: Span[] = [];
  for (const entry of [...FROZEN_HONEST_COPY, ...(context.allowlist ?? [])]) {
    const needle = fold(entry);
    if (needle === '') {
      continue;
    }
    let from = folded.indexOf(needle);
    while (from !== -1) {
      spans.push({ start: from, end: from + needle.length });
      from = folded.indexOf(needle, from + needle.length);
    }
  }
  return spans;
}

function isInsideAllowlisted(start: number, end: number, spans: readonly Span[]): boolean {
  return spans.some((span) => start >= span.start && end <= span.end);
}
