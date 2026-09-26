/**
 * The message catalog contract. One interface, one file per locale (`bg.ts`, `en.ts`),
 * loaded code-split (review 08 §5.2.7); Bulgarian is the default locale.
 *
 * Copy rules that bind every implementation of this interface:
 * - Strings marked FROZEN carry byte-exact copy from docs/GLOSSARY.md §3 / §3b / §5.2 —
 *   CI-10/CI-11 diff them against the glossary, so transcribe, never paraphrase.
 * - The word "out" (and its Bulgarian equivalents implying the fire is over) is banned
 *   for machine-derived states (GLOSSARY §4); "no longer detected" is the strongest
 *   machine claim allowed.
 * - Every visible timestamp is satellite observation time, pre-formatted Europe/Sofia by
 *   the caller; templates receive already-formatted strings, never Date objects.
 */

import type { LifecycleState, ScoreBucket } from '@fire-watch/contracts';

import type { AgeWindowId } from '../time/age-filter.js';
import type { RelativeAge } from './format.js';

export interface Messages {
  /** Product name stays untranslated: "Fire Watch". */
  readonly appTitle: string;

  readonly nav: {
    readonly map: string;
    readonly list: string;
    readonly settings: string;
    readonly about: string;
    readonly credits: string;
  };

  /** "SATELLITE-DETECTED" prefix shown with the tier label on event surfaces. */
  readonly satelliteDetected: string;
  /** Tier labels (GLOSSARY §2): confirmed / likely / unverified. */
  readonly tierLabel: Readonly<Record<ScoreBucket, string>>;
  /** FROZEN §2 — the Unverified explainer; must include "may still be a real fire". */
  readonly unverifiedNote: string;

  /** Short state words for list rows and badges (own voice; "out" ban applies). */
  readonly statusShort: Readonly<Record<LifecycleState, string>>;

  /** FROZEN §3 — full lifecycle explainer lines shown on the event page. */
  readonly lifecycle: {
    readonly active: (lastDetectionTime: string) => string;
    readonly signalWeakening: (passes: number) => string;
    readonly noLongerDetected: (sinceDateTime: string) => string;
    readonly officiallyContained: (date: string, source: string) => string;
    readonly officiallyExtinguished: (date: string, source: string) => string;
    readonly archived: (days: number) => string;
  };

  /** FROZEN §3b — staleness & trust-boundary templates. */
  readonly status: {
    readonly staleSources: (sinceTime: string) => string;
    readonly lifecycleFrozen: string;
    readonly emptyState: string;
    /**
     * `age` is pre-worded by {@link Messages.relativeAge}, not a minute count: the chip
     * outlives the first hour (a fixture or a quiet night puts it days behind) and
     * "(преди 19 103 мин)" is unreadable exactly when freshness matters most.
     */
    readonly freshnessChip: (
      observedTime: string,
      age: string,
      windowStart: string,
      windowEnd: string,
    ) => string;
    readonly freshnessChipUnknown: (observedTime: string, age: string) => string;
    readonly cloudBlindClose: (days: number) => string;
    readonly officialThenRedetected: (
      detectionTime: string,
      declaredState: string,
      declaredDate: string,
      source: string,
    ) => string;
  };

  /** Own-voice banner for the offline case (priority above stale_sources). */
  readonly bannerOffline: string;

  /** FROZEN §5.2 safety_no_travel — mandatory on every event page. */
  readonly safetyNoTravel: string;
  /** "In danger? Call 112" affordance next to the safety line. */
  readonly emergencyLine: string;
  /** Panel footer disclaimer (07-product-ux P10) — on every event panel. */
  readonly panelFooterDisclaimer: string;

  /** FROZEN §5.2 area_both_units — дка first for BG, ha first for EN. */
  readonly areaBothUnits: (ha: number) => string;

  /** "Fire near <place>" — the event's display name (ADR-002 D5). */
  readonly eventNearPlace: (place: string) => string;
  readonly detectionCount: (count: number) => string;
  /**
   * Elapsed time in words — the single place age becomes readable. Every surface that
   * shows "how long ago" routes through here, including the §3b chip, so no reader ever
   * meets a raw count like "19 103 мин". Catalogs drop the zero components themselves.
   */
  readonly relativeAge: (age: RelativeAge) => string;
  /** `time` is a pre-formatted stamp (bare time today, date+time older); `age` is worded. */
  readonly observedShort: (time: string, age: string) => string;
  readonly firstObserved: (dateTime: string) => string;
  readonly eventNotFound: string;
  readonly backToMap: string;
  readonly copyLink: string;
  readonly loading: string;

  /**
   * The share card (TASKS F6, 07-product-ux §5.4.2): an image of the event that leaves the
   * app, so every stamp it carries is an absolute Europe/Sofia date and time — never a
   * relative age, which is false by the time the image is read. All three strings are
   * PENDING FOUNDER REVIEW (`PENDING_FOUNDER_REVIEW` in catalog-governance.ts).
   */
  readonly shareCard: {
    /** The event-page action that produces the card. */
    readonly share: string;
    /** `dateTime` is the full Sofia date and time of the last satellite observation. */
    readonly observedAt: (dateTime: string) => string;
    /** `dateTime` is when the image was made, in server time — the anchor for any age. */
    readonly madeAt: (dateTime: string) => string;
  };

  /**
   * The time window the list is scoped to. Options are short enough to sit in a segmented
   * control; the group label is what carries the meaning for a screen reader. Like the
   * viewport scope, the window must state what it hides rather than just hiding it.
   */
  readonly ageWindow: {
    readonly label: string;
    readonly option: Readonly<Record<AgeWindowId, string>>;
    readonly olderHidden: (count: number) => string;
    readonly showOlder: string;
    /** Shown when the window is empty — "no satellite detections", never "no fires" (§4). */
    readonly emptyInWindow: string;
  };

  /** The list is scoped to what the map shows, so it must say what it is leaving out. */
  readonly listInView: {
    readonly outsideView: (count: number) => string;
    readonly showAll: string;
    readonly showInViewOnly: string;
    readonly emptyInView: string;
  };

  /** Map camera controls (own voice; labels double as accessible names). */
  readonly mapControls: {
    readonly home: string;
    readonly locate: string;
    readonly locating: string;
    readonly locationDenied: string;
    readonly locationUnavailable: string;
    readonly locationOutsideCoverage: string;
    readonly coverageNote: string;
    /** The satellite-imagery toggle (TASKS G6); shown only while the server offers imagery. */
    readonly imagery: string;
  };

  /** Onboarding — exactly three cards, then the button (07-product-ux P7). */
  readonly onboarding: {
    readonly card1Title: string;
    readonly card1Body: string;
    readonly card2Title: string;
    readonly card2Body: string;
    readonly card3Title: string;
    readonly card3Body: string;
    readonly showTheMap: string;
  };

  readonly settings: {
    readonly language: string;
    readonly theme: string;
    readonly themeLight: string;
    readonly themeDark: string;
    readonly themeAuto: string;
  };

  /** About page: capability → limitation → action, layered disclosure (P10). */
  readonly about: {
    readonly title: string;
    readonly paragraphs: readonly string[];
    /** Anchor target of the freshness-chip [?] affordance (#data-freshness). */
    readonly freshnessExplainerTitle: string;
    readonly freshnessExplainerParagraphs: readonly string[];
  };

  readonly creditsTitle: string;

  /**
   * The privacy page (TASKS I5; review 09 §5, review 05 §5.3): a short summary first, then
   * the full notice. Every string here is PENDING FOUNDER REVIEW and awaits legal review
   * (`PENDING_FOUNDER_REVIEW` in catalog-governance.ts); the page renders
   * {@link Messages.privacy.draftNotice} above all of it so unreviewed text is never
   * presented as final.
   */
  readonly privacy: {
    readonly title: string;
    /** Says, above everything else, that this text is a draft awaiting legal review. */
    readonly draftNotice: string;
    readonly summaryTitle: string;
    /** Layer one: the whole notice in a few sentences. */
    readonly summary: readonly string[];
    readonly fullNoticeTitle: string;
    readonly controller: PrivacySection;
    readonly data: PrivacySection;
    readonly legalBases: PrivacySection;
    /** Every recipient and processor a reader's data reaches, one per paragraph. */
    readonly recipients: PrivacySection;
    /** The satellite-data publishers — sources, not recipients; nothing is sent to them. */
    readonly sources: PrivacySection;
    readonly transfers: PrivacySection;
    readonly retention: PrivacySection;
    readonly rights: PrivacySection;
  };

  /**
   * The layered disclaimers (TASKS I5; review 09 §2.2.A, §3.2–3.4; review 07 §5.6.3). The
   * full layer sits on the privacy page under #disclaimer; the short layers are the links
   * and notes at the moment of reliance (first launch, the event panel footer, the list,
   * About, Settings). All PENDING FOUNDER REVIEW, like {@link Messages.privacy}.
   */
  readonly disclaimer: {
    readonly title: string;
    /**
     * The consumer-protection layer (ЗЗП/ЗЗД, 09 §3.4): the scope of the service, the
     * "as is" pass-through of the upstream terms, and the statutory rights it cannot limit.
     */
    readonly paragraphs: readonly string[];
    /** Introduces NASA LANCE's own disclaimer, which the page quotes from the registry. */
    readonly lanceIntro: string;
    /** The short link to the full layer, placed wherever the short layers are. */
    readonly linkLabel: string;
    /** The alert-settings layer (07 §5.5.4), shown in Settings until alerts ship. */
    readonly alertsTitle: string;
    readonly alertsNote: string;
  };
  /**
   * Sign-in by email link (TASKS I1; review 05 §5.4.1 C1–C2): the request form, the
   * landing page that finishes signing in, and the Settings account section. Plain strings
   * only. All PENDING FOUNDER REVIEW. Shown only where the server serves sign-in.
   */
  readonly signIn: {
    readonly title: string;
    readonly accountTitle: string;
    /** Settings: how signing in works, above the sign-in link. */
    readonly accountNote: string;
    readonly emailLabel: string;
    readonly send: string;
    readonly sending: string;
    /** The neutral answer to a link request: it must read the same whether or not the address has an account. */
    readonly sent: string;
    readonly rateLimited: string;
    readonly invalidEmail: string;
    readonly failed: string;
    /** Shown only on the sign-in pages themselves when this deployment has auth switched off. */
    readonly unavailable: string;
    readonly continueTitle: string;
    /** The landing page: the explicit step that exchanges the link (C2 — mail scanners prefetch links). */
    readonly continueIntro: string;
    readonly continue: string;
    readonly working: string;
    /** The landing page opened without a usable token (reloaded, or a malformed link). */
    readonly noLink: string;
    readonly expired: string;
    readonly used: string;
    readonly invalid: string;
    readonly superseded: string;
    readonly otherBrowser: string;
    readonly requestNew: string;
    readonly signedInTitle: string;
    readonly accountCreated: string;
    readonly signedIn: string;
    readonly signOut: string;
    readonly signedOut: string;
  };
}

/** One section of the full privacy notice: a heading and its paragraphs. */
export interface PrivacySection {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

// The code-split catalog loader lives in `locale.ts` (its only consumer): the catalogs
// import the `Messages` type from here, so hosting the dynamic imports in this file
// would close an import cycle (CI `no-circular`).
