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
    /**
     * The empty 1 h / 3 h window. Polar orbiters pass a few times a day, so an empty short
     * window is the normal case between passes and must not read as "nothing is burning".
     */
    readonly emptyShortWindow: string;
  };

  /**
   * The source and region filters (own voice). Sensor-family names are instrument names,
   * not translated. Oblast names are a fixed geographic table in `core/filter/oblasts.ts`.
   */
  readonly filters: {
    readonly label: string;
    readonly sourceLabel: string;
    readonly sourceAll: (count: number) => string;
    readonly sourceOption: (name: string, count: number) => string;
    readonly family: Readonly<Record<'v' | 'm' | 's' | 'g', string>>;
    /** Events whose feed did not say which sensors saw them; shown under every source. */
    readonly sourceUnreported: (count: number) => string;
    readonly regionLabel: string;
    readonly regionAll: string;
    readonly regionLoading: string;
    readonly regionFailed: string;
    readonly hiddenByFilters: (count: number) => string;
    readonly clear: string;
    readonly emptyFiltered: string;
  };

  /** Place search: settlements (GeoNames) and coordinates. */
  readonly search: {
    readonly label: string;
    readonly placeholder: string;
    readonly loading: string;
    readonly failed: string;
    readonly noResults: string;
    /** `coordinates` is already formatted, e.g. "42.6977, 23.3219". */
    readonly goToCoordinates: (coordinates: string) => string;
    readonly resultCount: (count: number) => string;
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

  /**
   * The Layers panel (TASKS G4): the basemap choice and the EFFIS context overlays. Own
   * voice; every key is implementer copy held in `PENDING_FOUNDER_REVIEW`.
   */
  readonly layers: {
    /** The disclosure button over the map; doubles as its accessible name. */
    readonly toggle: string;
    readonly panelLabel: string;
    readonly basemapTitle: string;
    /** The plain basemap option; the imagery option reuses `mapControls.imagery`. */
    readonly basemapMap: string;
    readonly overlaysTitle: string;
    readonly fwi: string;
    /** What FWI is — and is not (GLOSSARY §7: a weather index, never "fire expected here"). */
    readonly fwiNote: string;
    readonly fwiLegendTitle: string;
    /** EFFIS's six danger classes, lowest first — the order of `FWI_CLASSES` in `ui/layers.ts`. */
    readonly fwiClasses: readonly string[];
    /** The UTC date the index is for, already formatted. */
    readonly fwiValidFor: (date: string) => string;
    /** Shown when the newest copy is for another day than today in Sofia. */
    readonly fwiNotToday: string;
    readonly ba: string;
    readonly baNote: string;
    /** When EFFIS made the shown copy available, already formatted. */
    readonly copyDated: (time: string) => string;
    /** The A2.2 pass-through: a copy our sanity check flagged, shown anyway. */
    readonly suspect: string;
    readonly loading: string;
    readonly unavailable: string;
    /** F14: ECMWF forecast wind, drawn as arrows. */
    readonly wind: string;
    /** What the wind layer is — and is not (context, never a fire-spread prediction). */
    readonly windNote: string;
    /** The speed legend's title, with its unit. */
    readonly windLegendTitle: string;
    /** The five speed classes, lowest first — the order of `WIND_SPEED_CLASSES` in `core/wind.ts`. */
    readonly windClasses: readonly string[];
    /** The hour the arrows are for and the model run, both already formatted. */
    readonly windValidFor: (time: string, run: string) => string;
    /** The F16 static hot-source mask toggle (solar parks, power plants, flares, industry). */
    readonly staticSources: string;
    /** What the mask is — and why a hotspot on it may not be a fire. */
    readonly staticSourcesNote: string;
    /** F15: the predicted satellite swath overlay toggle. */
    readonly swaths: string;
    /** What the swaths are — a prediction of where sensors look, never a detection promise. */
    readonly swathsNote: string;
    /** Legend row for the outlined swaths: passes still ahead (next ~12 h). */
    readonly swathsNext: string;
    /** Legend row for the faintly filled swaths: passes already flown (last 6 h). */
    readonly swathsRecent: string;
    /** One listed pass: the platform name and its local mid-pass time, both already formatted. */
    readonly swathsPassAt: (platform: string, time: string) => string;
    /** F18: the lightning context layer toggle (EUMETSAT MTG Lightning Imager flashes). */
    readonly lightning: string;
    /** What the flashes are — and are not (context, never a claim that lightning lit a fire). */
    readonly lightningNote: string;
    /** The age legend's title. */
    readonly lightningLegendTitle: string;
    /** The three age classes, newest first — the order of `LIGHTNING_AGE_CLASSES` in `core/lightning.ts`. */
    readonly lightningClasses: readonly string[];
    /** The honest "as of": the end of the newest product merged, already formatted. */
    readonly lightningAsOf: (time: string) => string;
    /** A current copy with no flash young enough to draw. */
    readonly lightningNone: string;
  };

  /**
   * Satellite passes (TASKS F15), a section of the Layers panel: when the fire-detecting
   * polar orbiters last passed over the area and when they are next predicted to. Own voice;
   * every key is implementer copy held in `PENDING_FOUNDER_REVIEW`. Every time is a
   * prediction and the copy says so — it never promises a pass will happen or that one
   * will detect anything.
   */
  readonly passes: {
    readonly title: string;
    /** What a pass is — and is not (a chance to detect, never a promise). */
    readonly note: string;
    /** Which area the times are for: the map centre, or the selected event. */
    readonly forMapCentre: string;
    readonly forEvent: string;
    /** The map centre is outside the polled box, where no times are served. */
    readonly outsideArea: string;
    /** The label next to every predicted time. */
    readonly predicted: string;
    /** The instant the prediction was computed for, already formatted. */
    readonly computedFor: (time: string) => string;
    /** The prediction's forward window has run past now. */
    readonly expired: string;
    readonly lastPass: string;
    readonly nextPass: string;
    /** No in-swath pass in the window on that side of now. */
    readonly none: string;
    /** How far ahead a predicted pass is — the future counterpart of `relativeAge`. */
    readonly inTime: (age: RelativeAge) => string;
    /** Whether the Sun is up at the area at the pass. */
    readonly day: string;
    readonly night: string;
    /** The satellite's orbital elements are older than three days. */
    readonly elementsStale: string;
    /** No orbital elements are held for the satellite. */
    readonly elementsMissing: string;
    /** F17: the three levels of forecast cloud at a pass (okta boundaries, `pass-cloud.ts`). */
    readonly cloudClear: string;
    readonly cloudPartly: string;
    readonly cloudCloudy: string;
    /** F17: one pass's forecast cloud — a level word from above and a whole percent. */
    readonly cloudForecast: (level: string, pct: number) => string;
    /** F17: the value is a forecast, and a fire under cloud may go undetected. */
    readonly cloudCaveat: string;
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
   * The accessibility statement (TASKS L16; GATES.md §3 L-16; review 19 §5.10.1, review 09
   * §4.3): the target, the three scope classes, the alternative to the map, the known gaps,
   * how it is tested, the legal position and how to report a barrier. Every string here is
   * PENDING FOUNDER REVIEW and awaits legal review; the page renders
   * {@link Messages.accessibility.draftNotice} above all of it, like the privacy page.
   */
  readonly accessibility: {
    readonly title: string;
    /** Says, above everything else, that this statement is a draft awaiting sign-off. */
    readonly draftNotice: string;
    /** The date line: when the statement was prepared and when it was last reviewed. */
    readonly dated: string;
    readonly target: PrivacySection;
    /** The three scope classes of review 19 §5.2, one per paragraph. */
    readonly scope: PrivacySection;
    /** The equivalent alternative to the map canvas: the list and the event page. */
    readonly alternative: PrivacySection;
    /** What is known not to meet the target yet, one gap per paragraph. */
    readonly knownGaps: PrivacySection;
    readonly testing: PrivacySection;
    /** The legal position (09 §4.3): the microenterprise exemption and the voluntary commitment. */
    readonly legal: PrivacySection;
    readonly contact: PrivacySection;
    /** The link to the statement, placed on the About page. */
    readonly linkLabel: string;
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
  /**
   * "New since you last looked" (TASKS F): the header counter and its Settings sound
   * option. A situational-awareness cue about data that has arrived, never an alarm and
   * never a claim about how current the data is.
   */
  readonly newSignals: {
    /** Accessible name of the counter group. */
    readonly regionLabel: string;
    /** Count of fires that are new or have new detections since the viewer last looked. */
    readonly count: (count: number) => string;
    /** Age of the newest observation among them; the argument is `relativeAge` output. */
    readonly latest: (age: string) => string;
    readonly showNewest: string;
    readonly markAllSeen: string;
    readonly soundTitle: string;
    readonly soundLabel: string;
    readonly soundNote: string;
  };
  /**
   * The event page's detail sections (TASKS B-wave, rich event panel): the satellite
   * timeline, fire radiative power, contributing sensors, and where the event is relative
   * to the reader. Instrument names are proper nouns and never pass through here. All
   * PENDING FOUNDER REVIEW. Nothing here may read as directions (GLOSSARY §5.2 "No routing,
   * ever"): distance and bearing are orientation, and the only map link is an area view.
   */
  readonly eventDetail: {
    readonly eventIdLabel: string;
    /** Polite live-region text after a successful copy. */
    readonly copied: string;
    readonly copyFailed: string;
    readonly timelineTitle: string;
    readonly firstDetected: string;
    readonly lastDetected: string;
    readonly detectionsLabel: string;
    readonly lastSensorLabel: string;
    readonly frpTitle: string;
    /** `mw` is a locale-formatted number, `sensor` an instrument name, `time` a Sofia stamp. */
    readonly frpLatest: (mw: string, sensor: string, time: string) => string;
    readonly frpPeak: (mw: string, sensor: string, time: string) => string;
    /** The sparkline's text alternative; `min`/`max` are locale-formatted MW values. */
    readonly frpChartLabel: (passes: number, min: string, max: string) => string;
    /** FRP is not comparable across sensors — mandatory next to any FRP figure. */
    readonly frpNote: string;
    readonly frpUnavailable: string;
    readonly sensorsTitle: string;
    readonly orbit: { readonly polar: string; readonly geostationary: string };
    /** `size` is a pre-worded length ({@link Messages.eventDetail.metres} / `kilometres`). */
    readonly sensorPixel: (size: string) => string;
    readonly metres: (value: string) => string;
    readonly kilometres: (value: string) => string;
    readonly detailUnavailable: string;
    readonly whereTitle: string;
    readonly approxCentreLabel: string;
    readonly copyCoordinates: string;
    readonly openStreetMap: string;
    readonly showDistance: string;
    readonly locating: string;
    readonly locationDenied: string;
    readonly locationUnavailable: string;
    /** `km` is locale-formatted; `direction` is one of {@link Messages.eventDetail.compass}. */
    readonly distance: (km: string, direction: string) => string;
    readonly nearby: string;
    /** The direction *from the reader to the event*, worded to follow a distance. */
    readonly compass: {
      readonly N: string;
      readonly NE: string;
      readonly E: string;
      readonly SE: string;
      readonly S: string;
      readonly SW: string;
      readonly W: string;
      readonly NW: string;
    };
    readonly orientationNote: string;
    /** F16: the event's centre is near a mapped solar park; the event is still shown. */
    readonly staticSourceSolar: string;
    /** F16: the same, for a power plant, gas flare or heavy industry. */
    readonly staticSourceIndustrial: string;
    /**
     * F16, per detection: `near` of the event's `total` detections lie near a mapped solar
     * park (and none near another kind of source). Replaces the centre caveat once the
     * detections file has loaded.
     */
    readonly staticSourceDetectionsSolar: (near: number, total: number) => string;
    /** F16, per detection: the same, when any of them is near a non-solar source. */
    readonly staticSourceDetectionsIndustrial: (near: number, total: number) => string;
    /**
     * F16, kind-neutral: the server's verdict says the event sits on a mapped hot source but
     * the bundled mask finds none nearby (a newer server mask), so the kind is unknown.
     */
    readonly staticSourceServer: string;
    /**
     * F18 context, never cause: `count` (≥ 1) MTG-LI flashes within `radiusKm` in the
     * `hours` before the first detection, the nearest `nearestKm` away.
     */
    readonly lightningContextFlashes: (
      count: number,
      radiusKm: number,
      hours: number,
      nearestKm: number,
    ) => string;
    /** F18: the window was fully covered and no flash was recorded — LI misses some. */
    readonly lightningContextNone: (radiusKm: number, hours: number) => string;
    /** F18: the window was not covered (or not yet answered) — no data, not no lightning. */
    readonly lightningContextNoData: string;
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
