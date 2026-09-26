/**
 * What the glossary says about each message — declared, per path, for the whole catalog.
 *
 * CI-11 (`glossary-sync.test.ts`) freezes about sixteen of the catalog's eighty paths
 * against docs/GLOSSARY.md. That is correct: the glossary deliberately freezes §2, §3, §3b
 * and §5.2 and leaves the rest of the product's voice to the product. The defect this file
 * fixes is not the sixteen — it is that nothing anywhere distinguished *"deliberately not
 * frozen"* from *"nobody got round to it"*. A message added under `lifecycle.` or `status.`
 * tomorrow, in the middle of the frozen ladder, would join the catalog, render, ship, and
 * leave CI-11 green while covering strictly less than the day before. That is exactly the
 * failure `catalog-render.ts` exists to prevent for the never-send lint, one module over:
 * *"a hand-written list of message keys is a gate that silently stops covering whatever was
 * added last."*
 *
 * So the classification is **total and derived**. {@link CatalogPath} is read off the
 * `Messages` interface itself — the same move `ui/logic/routes.ts` makes when it derives
 * `RouteId` from the route table — and {@link CATALOG_GOVERNANCE} is a `Record` over it.
 * Adding a message to `messages.ts` therefore widens the union, and this record stops
 * compiling at its own `file:line` until somebody says, in a reviewable diff, which of the
 * glossary's postures the new copy is under. An unclassified path is a red build; it is
 * never an untested string.
 *
 * Three postures, and only three:
 *
 * - **frozen** — the glossary owns the wording. The entry names the section and the
 *   template id it transcribes, so a failure points at a row a human can open, and
 *   `glossary-sync.test.ts` carries one assertion per frozen path (also a total `Record`,
 *   so classifying a path frozen without asserting it does not compile either).
 * - **mandated-claim** — the glossary does not own the wording but requires a specific
 *   claim inside it (§2's "may still be a real fire"). Freezing the whole string would
 *   claim more than the glossary says; asserting nothing would claim less.
 * - **own-voice** — the glossary governs this copy only through the never-send list, which
 *   `never-send-catalog.test.ts` already applies to *every* path in both languages. The
 *   entry carries a {@link OwnVoiceReason}, which is the point: "free" is a claim somebody
 *   made, not a gap somebody left.
 *
 * The reason is a code from a closed union rather than free text. Free text admits "misc",
 * cannot be reviewed and cannot be counted; a closed set makes an author pick which
 * existing argument covers their new copy, and if none does, extending the union is a
 * visible diff whose comment has to carry the new argument. The arguments are written once,
 * properly, at {@link OwnVoiceReason} — not restated sixty-four times.
 *
 * Two deliberate limits, stated rather than hidden:
 *
 * - **Arrays are classified whole.** `about.paragraphs` is one entry, not one per element:
 *   `messages.ts` declares it `readonly string[]`, so its length is not in the type and a
 *   fourth paragraph inherits the third's posture. That is the one place a new string can
 *   arrive without a new decision. It is bounded — an array is a block of copy of one kind
 *   by declaration — and closing it would mean turning the declarations into tuples.
 * - **The type is not trusted alone.** {@link CatalogPath} is only as right as the leaf
 *   detection below, so `classifyCatalog` walks the real object through `renderCatalog` and
 *   throws {@link CatalogGovernanceError} on a path it has no entry for. If the type ever
 *   stops seeing part of the catalog, the walk still does.
 *
 * Test support, like `catalog-render.ts`: never imported by the UI, so no vitest and no
 * node builtins.
 */

import type { RenderedMessage } from './catalog-render.js';
import { renderCatalog } from './catalog-render.js';
import type { Messages } from './messages.js';

/* -------------------------------------------------------------------------- */
/* The paths, read off the catalog's own type                                 */
/* -------------------------------------------------------------------------- */

/**
 * What ends a path: a string, a template function, or an array of strings.
 *
 * A leaf shape not listed here is not silently swallowed — {@link PathsOf} descends into
 * it, which produces paths through whatever keys it has (an array of objects would yield
 * `length`, `at`, …) and so a compile error in {@link CATALOG_GOVERNANCE} that a reviewer
 * cannot miss. Loud and wrong beats quiet and uncovered.
 */
type CatalogLeaf = string | readonly string[] | ((...args: never[]) => string);

/** Every dotted path in `T`, stopping at {@link CatalogLeaf}. */
type PathsOf<T> = {
  [K in keyof T & string]: T[K] extends CatalogLeaf ? K : `${K}.${PathsOf<T[K]>}`;
}[keyof T & string];

/**
 * Every classifiable path in the catalog.
 *
 * Derived from `Messages`, which is what makes {@link CATALOG_GOVERNANCE} a list that
 * cannot fall behind the copy it classifies. Array elements collapse onto their array
 * (`about.paragraphs`, never `about.paragraphs[1]`); {@link classificationKey} performs the
 * same collapse on a rendered path so the two sides meet.
 */
export type CatalogPath = PathsOf<Messages>;

/* -------------------------------------------------------------------------- */
/* The postures                                                                */
/* -------------------------------------------------------------------------- */

/** The glossary sections that own copy. §1a/§1b freeze identity inputs, not wording. */
export type GlossarySection = '3' | '3b' | '5.2';

/**
 * Why a path is not glossary copy.
 *
 * Every code below is an argument, and choosing one is asserting that the argument covers
 * this string. None of them exempts anything from the never-send list: CI-10 lints all
 * eighty paths in both languages whatever their posture here, and §4's vocabulary ban is
 * asserted directly over `statusShort` and `bannerOffline` in `glossary-sync.test.ts`.
 */
export type OwnVoiceReason =
  /**
   * Names a surface, a control, an action or the product. Asserts nothing about a fire, so
   * there is nothing for a wording ladder to be wrong about — "Settings" is not a claim.
   */
  | 'chrome'
  /**
   * The short own-voice word for what the data is or what state it is in: a badge, a tier,
   * the satellite-detected prefix. §2 and §3 freeze the *explainer* that sits with these,
   * never the label itself; what governs the label is §4's ban on the official vocabulary
   * in our own voice, which CI-10 enforces and which CI-11 spot-checks over `statusShort`.
   */
  | 'state-label'
  /**
   * A frame around a number, a time or a place: the value is the content and the words are
   * the grammar around it. §5.2 freezes exactly one of these — `area_both_units` — and the
   * rest carry no obligation the glossary states.
   */
  | 'composed-value'
  /**
   * Our own statement of what the product can and cannot do, and what to do instead. The
   * glossary constrains what this prose may not say (§4, §5) and, for the web, does not
   * dictate what it does say; §5's mandatory alert footer binds the alert channel, not
   * these surfaces.
   */
  | 'capability-prose'
  /**
   * Describes the reader's own situation rather than a fire or a source: offline, a denied
   * geolocation, a filtered view that came back empty, an id that resolved to nothing.
   * §3b's degraded rows are about lost *observation capability* and are frozen as such;
   * none of them is about the client, so none of them covers these.
   */
  | 'client-condition'
  /**
   * What the law makes us say: the privacy notice (GDPR Art. 13) and the consumer-law and
   * upstream-licence disclaimers (review 09 §2.2.A, §3.4, §5). The glossary does not own
   * this wording; the law and the upstream terms own its *substance*, and a lawyer owns
   * its wording. That is a different authority from `capability-prose`, where the product
   * owner has the last word, so it is a different reason: an implementer may draft it, but
   * only legal review may call it final, which is why every such path is also held in
   * {@link PENDING_FOUNDER_REVIEW} until that review happens.
   */
  | 'legal-notice';

/** How the glossary governs one path. Exactly one of these applies to each. */
export type Governance =
  | {
      /** The glossary owns this wording; `glossary-sync.test.ts` diffs it byte for byte. */
      readonly governance: 'frozen';
      readonly section: GlossarySection;
      /** The template id of the glossary row, e.g. `freshness_chip`. Asserted to exist. */
      readonly templateId: string;
    }
  | {
      /**
       * The wording is ours, but the glossary requires a specific claim inside it — §2's
       * Unverified explainer, which "always includes 'may still be a real fire'".
       */
      readonly governance: 'mandated-claim';
      readonly section: '2';
    }
  | {
      /** Not glossary copy. See {@link OwnVoiceReason}. */
      readonly governance: 'own-voice';
      readonly reason: OwnVoiceReason;
    };

/* -------------------------------------------------------------------------- */
/* The classification                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every path, classified. Total over {@link CatalogPath} by `satisfies`, in both
 * directions: a missing key is a compile error here, and a key for copy that no longer
 * exists is an excess-property error on the same object.
 */
export const CATALOG_GOVERNANCE = {
  appTitle: { governance: 'own-voice', reason: 'chrome' },

  'nav.map': { governance: 'own-voice', reason: 'chrome' },
  'nav.list': { governance: 'own-voice', reason: 'chrome' },
  'nav.settings': { governance: 'own-voice', reason: 'chrome' },
  'nav.about': { governance: 'own-voice', reason: 'chrome' },
  'nav.credits': { governance: 'own-voice', reason: 'chrome' },

  // The tier vocabulary (§1 Score buckets) is a name for a score band, not a claim about
  // the fire; the claim §2 does make lives in `unverifiedNote` directly below.
  satelliteDetected: { governance: 'own-voice', reason: 'state-label' },
  'tierLabel.confirmed': { governance: 'own-voice', reason: 'state-label' },
  'tierLabel.likely': { governance: 'own-voice', reason: 'state-label' },
  'tierLabel.unverified': { governance: 'own-voice', reason: 'state-label' },
  unverifiedNote: { governance: 'mandated-claim', section: '2' },

  // §3 freezes the explainer line under the badge, and §4 bans the official vocabulary in
  // our own voice. The badge wording itself is ours — and `never-send-catalog.test.ts`
  // records two of these as standing defects for exactly that reason.
  'statusShort.active': { governance: 'own-voice', reason: 'state-label' },
  'statusShort.signal_weakening': { governance: 'own-voice', reason: 'state-label' },
  'statusShort.no_longer_detected': { governance: 'own-voice', reason: 'state-label' },
  'statusShort.officially_contained': { governance: 'own-voice', reason: 'state-label' },
  'statusShort.officially_extinguished': { governance: 'own-voice', reason: 'state-label' },
  'statusShort.archived': { governance: 'own-voice', reason: 'state-label' },

  // §3 — the wording ladder. Every row of the table is here; the table is closed by
  // `LifecycleState`, so a seventh state is a compile error in three places before it is a
  // copy question.
  'lifecycle.active': { governance: 'frozen', section: '3', templateId: 'active' },
  'lifecycle.signalWeakening': {
    governance: 'frozen',
    section: '3',
    templateId: 'signal_weakening',
  },
  'lifecycle.noLongerDetected': {
    governance: 'frozen',
    section: '3',
    templateId: 'no_longer_detected',
  },
  'lifecycle.officiallyContained': {
    governance: 'frozen',
    section: '3',
    templateId: 'officially_contained',
  },
  'lifecycle.officiallyExtinguished': {
    governance: 'frozen',
    section: '3',
    templateId: 'officially_extinguished',
  },
  'lifecycle.archived': { governance: 'frozen', section: '3', templateId: 'archived' },

  // §3b — degraded and empty states, where false reassurance is cheapest to produce. All
  // seven rows of the table, none missing.
  'status.staleSources': { governance: 'frozen', section: '3b', templateId: 'stale_sources' },
  'status.lifecycleFrozen': {
    governance: 'frozen',
    section: '3b',
    templateId: 'lifecycle_frozen',
  },
  'status.emptyState': { governance: 'frozen', section: '3b', templateId: 'empty_state' },
  'status.freshnessChip': { governance: 'frozen', section: '3b', templateId: 'freshness_chip' },
  'status.freshnessChipUnknown': {
    governance: 'frozen',
    section: '3b',
    templateId: 'freshness_chip_unknown',
  },
  'status.cloudBlindClose': {
    governance: 'frozen',
    section: '3b',
    templateId: 'cloud_blind_close',
  },
  'status.officialThenRedetected': {
    governance: 'frozen',
    section: '3b',
    templateId: 'official_then_redetected',
  },

  // Losing the network is the client's problem, not the constellation's: §3b's one degraded
  // slot is `stale_sources`, which is about observation capability, and 08 §5.6 keeps the
  // two distinct on purpose.
  bannerOffline: { governance: 'own-voice', reason: 'client-condition' },

  // §5.2 — the two positive obligations the web renders.
  safetyNoTravel: { governance: 'frozen', section: '5.2', templateId: 'safety_no_travel' },
  emergencyLine: { governance: 'own-voice', reason: 'capability-prose' },
  panelFooterDisclaimer: { governance: 'own-voice', reason: 'capability-prose' },
  areaBothUnits: { governance: 'frozen', section: '5.2', templateId: 'area_both_units' },

  eventNearPlace: { governance: 'own-voice', reason: 'composed-value' },
  detectionCount: { governance: 'own-voice', reason: 'composed-value' },
  relativeAge: { governance: 'own-voice', reason: 'composed-value' },
  observedShort: { governance: 'own-voice', reason: 'composed-value' },
  firstObserved: { governance: 'own-voice', reason: 'composed-value' },
  eventNotFound: { governance: 'own-voice', reason: 'client-condition' },
  backToMap: { governance: 'own-voice', reason: 'chrome' },
  copyLink: { governance: 'own-voice', reason: 'chrome' },
  loading: { governance: 'own-voice', reason: 'chrome' },

  // The share card (TASKS F6). Own voice, and also PENDING FOUNDER REVIEW — see below.
  'shareCard.share': { governance: 'own-voice', reason: 'chrome' },
  'shareCard.observedAt': { governance: 'own-voice', reason: 'composed-value' },
  'shareCard.madeAt': { governance: 'own-voice', reason: 'composed-value' },

  'ageWindow.label': { governance: 'own-voice', reason: 'chrome' },
  'ageWindow.option.6h': { governance: 'own-voice', reason: 'chrome' },
  'ageWindow.option.24h': { governance: 'own-voice', reason: 'chrome' },
  'ageWindow.option.48h': { governance: 'own-voice', reason: 'chrome' },
  'ageWindow.option.all': { governance: 'own-voice', reason: 'chrome' },
  'ageWindow.olderHidden': { governance: 'own-voice', reason: 'composed-value' },
  'ageWindow.showOlder': { governance: 'own-voice', reason: 'chrome' },
  // An empty *filter*, not an empty area: §3b's `empty_state` is frozen for the map and the
  // zone. Whether these two owe the reader its second sentence is a founder question, not
  // one this file may answer.
  'ageWindow.emptyInWindow': { governance: 'own-voice', reason: 'client-condition' },

  'listInView.outsideView': { governance: 'own-voice', reason: 'composed-value' },
  'listInView.showAll': { governance: 'own-voice', reason: 'chrome' },
  'listInView.showInViewOnly': { governance: 'own-voice', reason: 'chrome' },
  'listInView.emptyInView': { governance: 'own-voice', reason: 'client-condition' },

  'mapControls.home': { governance: 'own-voice', reason: 'chrome' },
  'mapControls.locate': { governance: 'own-voice', reason: 'chrome' },
  'mapControls.locating': { governance: 'own-voice', reason: 'client-condition' },
  'mapControls.locationDenied': { governance: 'own-voice', reason: 'client-condition' },
  'mapControls.locationUnavailable': { governance: 'own-voice', reason: 'client-condition' },
  'mapControls.locationOutsideCoverage': { governance: 'own-voice', reason: 'client-condition' },
  'mapControls.coverageNote': { governance: 'own-voice', reason: 'capability-prose' },
  // The imagery toggle (TASKS G6). Own voice, and also PENDING FOUNDER REVIEW — see below.
  'mapControls.imagery': { governance: 'own-voice', reason: 'chrome' },

  // 07-product-ux P7 fixes the shape — capability, then limitation, then action — so the
  // three titles carry the structure and are classified with the bodies they head.
  'onboarding.card1Title': { governance: 'own-voice', reason: 'capability-prose' },
  'onboarding.card1Body': { governance: 'own-voice', reason: 'capability-prose' },
  'onboarding.card2Title': { governance: 'own-voice', reason: 'capability-prose' },
  'onboarding.card2Body': { governance: 'own-voice', reason: 'capability-prose' },
  'onboarding.card3Title': { governance: 'own-voice', reason: 'capability-prose' },
  'onboarding.card3Body': { governance: 'own-voice', reason: 'capability-prose' },
  'onboarding.showTheMap': { governance: 'own-voice', reason: 'chrome' },

  'settings.language': { governance: 'own-voice', reason: 'chrome' },
  'settings.theme': { governance: 'own-voice', reason: 'chrome' },
  'settings.themeLight': { governance: 'own-voice', reason: 'chrome' },
  'settings.themeDark': { governance: 'own-voice', reason: 'chrome' },
  'settings.themeAuto': { governance: 'own-voice', reason: 'chrome' },

  'about.title': { governance: 'own-voice', reason: 'chrome' },
  'about.paragraphs': { governance: 'own-voice', reason: 'capability-prose' },
  'about.freshnessExplainerTitle': { governance: 'own-voice', reason: 'chrome' },
  'about.freshnessExplainerParagraphs': { governance: 'own-voice', reason: 'capability-prose' },

  creditsTitle: { governance: 'own-voice', reason: 'chrome' },

  // TASKS I5 — the privacy page and the layered disclaimers. Headings are chrome; every
  // statement is legal-notice. All of it is also PENDING FOUNDER REVIEW — see below.
  'privacy.title': { governance: 'own-voice', reason: 'chrome' },
  'privacy.draftNotice': { governance: 'own-voice', reason: 'legal-notice' },
  'privacy.summaryTitle': { governance: 'own-voice', reason: 'chrome' },
  'privacy.summary': { governance: 'own-voice', reason: 'legal-notice' },
  'privacy.fullNoticeTitle': { governance: 'own-voice', reason: 'chrome' },
  'privacy.controller.title': { governance: 'own-voice', reason: 'chrome' },
  'privacy.controller.paragraphs': { governance: 'own-voice', reason: 'legal-notice' },
  'privacy.data.title': { governance: 'own-voice', reason: 'chrome' },
  'privacy.data.paragraphs': { governance: 'own-voice', reason: 'legal-notice' },
  'privacy.legalBases.title': { governance: 'own-voice', reason: 'chrome' },
  'privacy.legalBases.paragraphs': { governance: 'own-voice', reason: 'legal-notice' },
  'privacy.recipients.title': { governance: 'own-voice', reason: 'chrome' },
  'privacy.recipients.paragraphs': { governance: 'own-voice', reason: 'legal-notice' },
  'privacy.sources.title': { governance: 'own-voice', reason: 'chrome' },
  'privacy.sources.paragraphs': { governance: 'own-voice', reason: 'legal-notice' },
  'privacy.transfers.title': { governance: 'own-voice', reason: 'chrome' },
  'privacy.transfers.paragraphs': { governance: 'own-voice', reason: 'legal-notice' },
  'privacy.retention.title': { governance: 'own-voice', reason: 'chrome' },
  'privacy.retention.paragraphs': { governance: 'own-voice', reason: 'legal-notice' },
  'privacy.rights.title': { governance: 'own-voice', reason: 'chrome' },
  'privacy.rights.paragraphs': { governance: 'own-voice', reason: 'legal-notice' },

  'disclaimer.title': { governance: 'own-voice', reason: 'chrome' },
  'disclaimer.paragraphs': { governance: 'own-voice', reason: 'legal-notice' },
  'disclaimer.lanceIntro': { governance: 'own-voice', reason: 'legal-notice' },
  'disclaimer.linkLabel': { governance: 'own-voice', reason: 'chrome' },
  'disclaimer.alertsTitle': { governance: 'own-voice', reason: 'chrome' },
  'disclaimer.alertsNote': { governance: 'own-voice', reason: 'legal-notice' },
  // TASKS I1 — sign-in by email link. Labels and headings are chrome; what the flow can and
  // cannot do is capability prose; every outcome line is a client condition.
  'signIn.title': { governance: 'own-voice', reason: 'chrome' },
  'signIn.accountTitle': { governance: 'own-voice', reason: 'chrome' },
  'signIn.accountNote': { governance: 'own-voice', reason: 'capability-prose' },
  'signIn.emailLabel': { governance: 'own-voice', reason: 'chrome' },
  'signIn.send': { governance: 'own-voice', reason: 'chrome' },
  'signIn.sending': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.sent': { governance: 'own-voice', reason: 'capability-prose' },
  'signIn.rateLimited': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.invalidEmail': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.failed': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.unavailable': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.continueTitle': { governance: 'own-voice', reason: 'chrome' },
  'signIn.continueIntro': { governance: 'own-voice', reason: 'capability-prose' },
  'signIn.continue': { governance: 'own-voice', reason: 'chrome' },
  'signIn.working': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.noLink': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.expired': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.used': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.invalid': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.superseded': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.otherBrowser': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.requestNew': { governance: 'own-voice', reason: 'chrome' },
  'signIn.signedInTitle': { governance: 'own-voice', reason: 'chrome' },
  'signIn.accountCreated': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.signedIn': { governance: 'own-voice', reason: 'client-condition' },
  'signIn.signOut': { governance: 'own-voice', reason: 'chrome' },
  'signIn.signedOut': { governance: 'own-voice', reason: 'client-condition' },
} as const satisfies Record<CatalogPath, Governance>;

/**
 * Copy that shipped without the founder having read it, named so that it cannot be
 * forgotten.
 *
 * A posture above says *which rules* govern a string; it says nothing about whether the
 * person who owns the product's voice has approved the wording. New copy written by an
 * implementer to unblock a task lands here, and a founder decision removes it — in a
 * reviewable diff, like every other change to this file. `pending-founder-review.test.ts`
 * asserts the register exactly, so adding to it or clearing it is always a visible edit.
 *
 * - `shareCard.*` — TASKS F6, the share card. The card must say *when* the satellite saw
 *   the fire in words that survive a screenshot, and no existing string says that without
 *   a relative age (`observedShort`, `status.freshnessChip*`), which is false by the time
 *   a shared image is read.
 * - `privacy.*`, `disclaimer.*` — TASKS I5, the privacy page and the layered ЗЗП/LANCE
 *   disclaimers. Drafted by an implementer from reviews 05, 07 and 09 and needing **legal**
 *   review as well as the founder's: the controller does not exist yet, retention periods
 *   and the email provider are undecided, and the Bulgarian text is an implementer's draft
 *   that no Bulgarian lawyer has read. The page shows `privacy.draftNotice` above all of
 *   it; `privacy-page.test.tsx` holds the notice on the page for as long as any of these
 *   paths is still listed here.
 * - `mapControls.imagery` — TASKS G6, the satellite-imagery toggle label. Written by an
 *   implementer so the toggle can render; the word the product uses for the basemap
 *   alternative (and its placement among the map controls) is the founder's call.
 * - `signIn.*` — TASKS I1, sign-in by email link. Written by an implementer so the pages can
 *   render; the product's word for an account, the tone of the neutral "sent" answer (it
 *   must not reveal whether an address has an account) and the Bulgarian drafts are the
 *   founder's call.
 */
export const PENDING_FOUNDER_REVIEW = [
  'shareCard.share',
  'shareCard.observedAt',
  'shareCard.madeAt',
  'privacy.title',
  'privacy.draftNotice',
  'privacy.summaryTitle',
  'privacy.summary',
  'privacy.fullNoticeTitle',
  'privacy.controller.title',
  'privacy.controller.paragraphs',
  'privacy.data.title',
  'privacy.data.paragraphs',
  'privacy.legalBases.title',
  'privacy.legalBases.paragraphs',
  'privacy.recipients.title',
  'privacy.recipients.paragraphs',
  'privacy.sources.title',
  'privacy.sources.paragraphs',
  'privacy.transfers.title',
  'privacy.transfers.paragraphs',
  'privacy.retention.title',
  'privacy.retention.paragraphs',
  'privacy.rights.title',
  'privacy.rights.paragraphs',
  'disclaimer.title',
  'disclaimer.paragraphs',
  'disclaimer.lanceIntro',
  'disclaimer.linkLabel',
  'disclaimer.alertsTitle',
  'disclaimer.alertsNote',
  'mapControls.imagery',
  'signIn.title',
  'signIn.accountTitle',
  'signIn.accountNote',
  'signIn.emailLabel',
  'signIn.send',
  'signIn.sending',
  'signIn.sent',
  'signIn.rateLimited',
  'signIn.invalidEmail',
  'signIn.failed',
  'signIn.unavailable',
  'signIn.continueTitle',
  'signIn.continueIntro',
  'signIn.continue',
  'signIn.working',
  'signIn.noLink',
  'signIn.expired',
  'signIn.used',
  'signIn.invalid',
  'signIn.superseded',
  'signIn.otherBrowser',
  'signIn.requestNew',
  'signIn.signedInTitle',
  'signIn.accountCreated',
  'signIn.signedIn',
  'signIn.signOut',
  'signIn.signedOut',
] as const satisfies readonly CatalogPath[];

/* -------------------------------------------------------------------------- */
/* Subsets, derived                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The paths classified with one of `G`'s postures, read back off the record.
 *
 * The domain is intersected with the record's own keys rather than being `CatalogPath`
 * outright. In the healthy state the two are the same set — that is what `satisfies`
 * proves. In the broken state, the intersection is what keeps an unclassified path from
 * reporting a second time here (and a third in {@link governanceOf}) as an indexing
 * failure: the diagnostic a reader needs is the missing property on the record, once.
 */
type GovernedKey = CatalogPath & keyof typeof CATALOG_GOVERNANCE;

type PathsGoverned<G extends Governance['governance']> = {
  [K in GovernedKey]: (typeof CATALOG_GOVERNANCE)[K]['governance'] extends G ? K : never;
}[GovernedKey];

/**
 * Every path the glossary has something to say about.
 *
 * `glossary-sync.test.ts` holds a `Record<GlossaryGovernedPath, …>` of assertions, so
 * classifying a path `frozen` or `mandated-claim` without writing the assertion that backs
 * the claim does not compile — the second half of the same guarantee.
 */
export type GlossaryGovernedPath = PathsGoverned<'frozen' | 'mandated-claim'>;

/* -------------------------------------------------------------------------- */
/* The walk                                                                    */
/* -------------------------------------------------------------------------- */

/** Raised when a rendered message has no entry in {@link CATALOG_GOVERNANCE}. */
export class CatalogGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogGovernanceError';
  }
}

/**
 * The classification key for a rendered path: the path with its array indices removed, so
 * `about.paragraphs[1]` is classified by `about.paragraphs`.
 */
export function classificationKey(renderedPath: string): string {
  return renderedPath.replaceAll(/\[\d+\]/gu, '');
}

/** One rendered message with the posture that governs it. */
export interface ClassifiedMessage extends RenderedMessage {
  /** {@link classificationKey} of {@link RenderedMessage.path}. */
  readonly key: string;
  readonly governance: Governance;
}

/**
 * The posture governing `renderedPath`.
 *
 * @throws CatalogGovernanceError when nothing classifies it. This is the runtime half of
 * the guarantee: the compile-time `Record` covers what `Messages` declares, and this covers
 * what the catalog object actually holds, which is the same thing only for as long as the
 * leaf detection in {@link CatalogLeaf} keeps up.
 */
export function governanceOf(renderedPath: string): Governance {
  const key = classificationKey(renderedPath);
  if (!Object.hasOwn(CATALOG_GOVERNANCE, key)) {
    throw new CatalogGovernanceError(
      `catalog path "${key}" has no entry in CATALOG_GOVERNANCE (catalog-governance.ts), ` +
        `so no gate knows whether its copy is frozen against docs/GLOSSARY.md or ` +
        `deliberately our own. Classify it: 'frozen' with its glossary section and ` +
        `template id, 'mandated-claim', or 'own-voice' with the reason that covers it.`,
    );
  }
  return CATALOG_GOVERNANCE[key as keyof typeof CATALOG_GOVERNANCE];
}

/**
 * Every message in `messages`, rendered and classified.
 *
 * @throws CatalogGovernanceError on the first path nothing classifies, and
 * `CatalogCoverageError` on copy `renderCatalog` cannot render.
 */
export function classifyCatalog(messages: Messages): readonly ClassifiedMessage[] {
  return renderCatalog(messages).map((message) => ({
    ...message,
    key: classificationKey(message.path),
    governance: governanceOf(message.path),
  }));
}
