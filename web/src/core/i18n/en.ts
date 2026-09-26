/**
 * English message catalog.
 *
 * Keys marked FROZEN are transcribed byte-exact from docs/GLOSSARY.md (§2, §3, §3b, §5.2);
 * CI-10/CI-11 diff the rendered strings against the glossary and the allowlist matches
 * whole strings, so one character of drift fails the build. In template functions every
 * literal fragment is frozen and only the parameters vary (`glossary-sync.test.ts` guards
 * the transcription). Everything else is own voice: calm, honest about limits, no
 * alarmism, no promises of completeness, and never the banned vocabulary of §4/§5 —
 * "out" and its equivalents never appear; "no longer detected" is the strongest machine
 * claim.
 */

import { formatNumber, roundToTwoSignificantFigures } from './format.js';
import type { Messages } from './messages.js';

const messages: Messages = {
  appTitle: 'Fire Watch',

  nav: {
    map: 'Map',
    list: 'List',
    settings: 'Settings',
    about: 'About',
    credits: 'Credits',
  },

  satelliteDetected: 'SATELLITE-DETECTED',
  tierLabel: {
    confirmed: 'Confirmed',
    likely: 'Likely',
    unverified: 'Unverified',
  },
  // FROZEN §2 constraint: the explainer always includes "may still be a real fire".
  unverifiedNote:
    'A single low-confidence detection — it may still be a real fire, and it may be a false positive. Further satellite passes will clarify.',

  // Own voice, §4/§5 bans apply ("out" never appears). The curated pair may use the
  // contained/extinguished vocabulary because those states exist only via an attributed
  // official statement — the full lifecycle line below the badge carries date and source.
  statusShort: {
    active: 'Actively detected',
    signal_weakening: 'Signal weakening',
    no_longer_detected: 'No longer detected',
    officially_contained: 'Officially contained',
    officially_extinguished: 'Officially extinguished',
    archived: 'Archived',
  },

  // FROZEN §3 — the wording ladder, EN column, placeholders only.
  lifecycle: {
    active: (lastDetectionTime) =>
      `Actively detected — last satellite detection ${lastDetectionTime}`,
    signalWeakening: (passes) =>
      `Weakening satellite signal over the last ${String(passes)} passes — fires often re-intensify in the afternoon`,
    noLongerDetected: (sinceDateTime) =>
      `No longer detected by satellites since ${sinceDateTime}. This does not mean the fire is out — satellites cannot see smoldering, burning under trees or through cloud.`,
    officiallyContained: (date, source) =>
      `Declared contained (локализиран) by authorities on ${date} — ${source}. Containment means spread is stopped; the fire may still burn inside the perimeter.`,
    officiallyExtinguished: (date, source) =>
      `Declared extinguished (ликвидиран) by authorities on ${date} — ${source}.`,
    archived: (days) =>
      `Event archived: no satellite detections for ${String(days)} days. New nearby detections may reopen it as a possible reignition.`,
  },

  // FROZEN §3b — degraded-state and empty-state templates, EN column.
  status: {
    staleSources: (sinceTime) =>
      `Satellite data delayed since ${sinceTime} — showing the last data we have. The absence of new detections is not evidence that the fire is out.`,
    lifecycleFrozen:
      'Status not current — status tracking is paused while satellite data is delayed.',
    emptyState:
      'No satellite detections in this area. This is not a statement that there are no fires.',
    freshnessChip: (observedTime, age, windowStart, windowEnd) =>
      `Observed ${observedTime} (${age}) · next update expected ~${windowStart}–${windowEnd}`,
    freshnessChipUnknown: (observedTime, age) =>
      `Observed ${observedTime} (${age}) · next update time unknown`,
    cloudBlindClose: (days) =>
      `No observation has been possible for ${String(days)} days — continuous cloud cover. We do not know whether this fire is still burning: the event is closed because we cannot see it, not because it is out.`,
    officialThenRedetected: (detectionTime, declaredState, declaredDate, source) =>
      `New satellite detections on ${detectionTime}, after the fire was declared ${declaredState} by authorities on ${declaredDate} — ${source}. Both facts are shown as they stand.`,
  },

  bannerOffline:
    'No connection — showing the last saved data. New detections cannot arrive while offline.',

  // FROZEN §5.2 safety_no_travel.
  safetyNoTravel: 'Do not travel toward the fire area — keep roads clear for responders.',
  emergencyLine: 'In danger? Call 112',
  // 07-product-ux P10/P13 — the compact capability statement on every event panel.
  panelFooterDisclaimer:
    'Satellite data may be 15 min–3 h old and can miss fires. Not an official warning system.',

  // FROZEN §5.2 area_both_units — hectares first for EN readers; 1 ha = 10 дка; two
  // significant figures, `~` prefix, locale Intl grouping.
  areaBothUnits: (ha) => {
    const roundedHa = roundToTwoSignificantFigures(ha);
    const roundedDka = roundToTwoSignificantFigures(ha * 10);
    return `~${formatNumber(roundedHa, 'en')} ha (${formatNumber(roundedDka, 'en')} дка)`;
  },

  eventNearPlace: (place) => `Fire near ${place}`,
  detectionCount: (count) =>
    count === 1 ? '1 detection' : `${formatNumber(count, 'en')} detections`,
  relativeAge: (age) => {
    switch (age.unit) {
      case 'now':
        return 'just now';
      case 'minutes':
        return `${String(age.minutes)} min ago`;
      case 'hours':
        return age.minutes === 0
          ? `${String(age.hours)} h ago`
          : `${String(age.hours)} h ${String(age.minutes)} min ago`;
      // Past a day the minutes are noise — nobody acts on the difference between
      // "13 days 6 h" and "13 days 6 h 23 min", so they are dropped, not rounded into.
      case 'days': {
        const days = age.days === 1 ? '1 day' : `${formatNumber(age.days, 'en')} days`;
        return age.hours === 0 ? `${days} ago` : `${days} ${String(age.hours)} h ago`;
      }
    }
  },
  observedShort: (time, age) => `Observed: ${time} (${age})`,
  firstObserved: (dateTime) => `First observed: ${dateTime}`,
  eventNotFound: 'This event could not be found. Check the link, or go back to the map.',
  backToMap: 'Back to map',
  copyLink: 'Copy link',
  loading: 'Loading…',

  // PENDING FOUNDER REVIEW — see PENDING_FOUNDER_REVIEW in catalog-governance.ts.
  shareCard: {
    share: 'Share',
    observedAt: (dateTime) => `Last satellite observation: ${dateTime} (Bulgarian time)`,
    madeAt: (dateTime) => `Image created ${dateTime}`,
  },

  ageWindow: {
    label: 'Time window',
    // Short on purpose: four of these sit side by side in the panel, and the group label
    // above them is what says these are hours of look-back.
    option: { '6h': '6 h', '24h': '24 h', '48h': '48 h', all: 'All' },
    olderHidden: (count) =>
      count === 1 ? '1 older fire hidden' : `${formatNumber(count, 'en')} older fires hidden`,
    showOlder: 'Show older',
    emptyInWindow: 'No satellite detections in this time window. Widen it to see older ones.',
  },

  listInView: {
    outsideView: (count) =>
      count === 1
        ? '1 more fire outside the current view'
        : `${formatNumber(count, 'en')} more fires outside the current view`,
    showAll: 'Show all',
    showInViewOnly: 'Only in view',
    emptyInView:
      'No satellite detections in the current view. Zoom out to see the rest of the covered area.',
  },

  mapControls: {
    home: 'Balkans',
    locate: 'My location',
    locating: 'Finding your location…',
    locationDenied: 'Location permission denied — the map stays where it is.',
    locationUnavailable: 'Your location could not be determined.',
    locationOutsideCoverage:
      'You are outside the covered area (Bulgaria plus a 100 km cross-border band); showing the Balkans instead.',
    coverageNote:
      'Coverage: Bulgaria plus a 100 km cross-border band. Neighbouring fires are shown because fires cross borders.',
    imagery: 'Satellite imagery',
  },

  // Capability → limitation → action (07-product-ux P7/P13).
  onboarding: {
    card1Title: 'Satellite fire detections',
    card1Body:
      'Fire Watch shows heat detected by satellites over Bulgaria — each point is an observation, with the time it was made.',
    card2Title: 'What it cannot do',
    card2Body:
      'Satellite data may be 15 min–3 h old, and clouds or small fires can go undetected. This is not an official warning system.',
    card3Title: 'In an emergency',
    card3Body: 'Call 112. Do not travel toward the fire area — keep roads clear for responders.',
    showTheMap: 'Show the map',
  },

  settings: {
    language: 'Language',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeAuto: 'Auto',
  },

  about: {
    title: 'About Fire Watch',
    paragraphs: [
      'Fire Watch maps satellite heat detections over Bulgaria. Every timestamp you see is the moment a satellite observed heat — never the moment we processed it.',
      'Satellites detect many fires, but not all of them: small or short-lived fires, fire under dense canopy, and anything below cloud can go undetected. Detection data typically arrives 15 minutes to 3 hours after the observation.',
      'Fire Watch is best-effort informational monitoring, not an official warning system. For official information follow the responsible authorities; in an emergency call 112.',
    ],
    freshnessExplainerTitle: 'How fresh is this data?',
    freshnessExplainerParagraphs: [
      'Every event shows the time of its last satellite observation and how long ago that was. The time is always the observation itself, in Bulgarian time (Europe/Sofia).',
      'New data arrives when a satellite passes over and its data is processed — typically 15 minutes to 3 hours after the observation. Between passes the picture does not change, even if a fire does.',
      'When we cannot estimate the next update, the chip says so — an unknown update time is never replaced with a guess.',
    ],
  },

  creditsTitle: 'Data sources & credits',

  // PENDING FOUNDER REVIEW and pending legal review (TASKS I5) — see PENDING_FOUNDER_REVIEW
  // in catalog-governance.ts. Drafted from reviews 05 §5.3, 07 §5.6.3 and 09 §2.2.A, §3.4,
  // §5; nothing here is final wording, which is what `draftNotice` tells the reader.
  privacy: {
    title: 'Privacy and limits of the service',
    draftNotice:
      'Draft: this text has not yet been reviewed by a lawyer and is not final. It describes how Fire Watch works today and will be completed before accounts or alerts launch.',
    summaryTitle: 'In short',
    summary: [
      'You can use the map without an account. We use no cookies, no advertising and no tracking. Your language, theme and first-launch choices are stored only in your browser.',
      'To deliver the site, our servers and our content delivery network see your IP address and the requests your browser makes. We use this only to run and protect the service.',
      'The base map and, if you switch it on, the satellite imagery layer are loaded by your browser directly from their providers, who then see your IP address and the map area you view.',
      'The fire data comes from NASA, EUMETSAT and the EU Copernicus programme. We send them no information about you.',
      'Fire Watch is best-effort informational monitoring. It is not an official warning system and it does not replace 112.',
    ],
    fullNoticeTitle: 'Full privacy notice',
    controller: {
      title: 'Who is responsible',
      paragraphs: [
        'The controller of your personal data will be the company that operates Fire Watch. That company has not been registered yet; its name, registered address and a contact address for privacy requests will be stated here before public launch.',
      ],
    },
    data: {
      title: 'What we process',
      paragraphs: [
        'Using the map needs no account, and we do not ask for your name, email address or phone number.',
        'Technical data: when your browser loads Fire Watch, our hosting and our content delivery network receive your IP address, the time, the address requested and your browser type. This is kept in server logs used to deliver the site, limit abusive traffic and keep it secure.',
        'Map viewing: map data is requested for the area you look at, so the services that deliver it can see which area you view.',
        'Stored only in your browser: your language, your theme and whether you have seen the first-launch cards. These are not sent to us. If you use "My location", your position is used in your browser to move the map and is not sent to us.',
        'Accounts, watch zones and alerts are not available yet. This notice will describe the data they need before they launch.',
      ],
    },
    legalBases: {
      title: 'Why we may process it',
      paragraphs: [
        'Delivering the site, server logs, limiting abusive traffic and security: our legitimate interest in running a public information service reliably and securely (GDPR Article 6(1)(f)).',
        'Accounts, watch zones and alerts, once they launch: providing the service you ask for (GDPR Article 6(1)(b)).',
      ],
    },
    recipients: {
      title: 'Who else receives data',
      paragraphs: [
        'Cloudflare: our content delivery network and the R2 storage that serves map data and data snapshots. It receives IP addresses and requests.',
        'Our hosting provider in the EU, which runs our servers and database.',
        'OpenFreeMap: the base map is loaded from it today, so it receives your IP address and the map area you view.',
        'Esri: only if you switch on the satellite imagery layer. Your browser then loads imagery directly from Esri, a company based in the United States, which receives your IP address and the map area you view.',
        'Amazon Web Services (AWS): the planned provider for alert email, in an EU region. It is not used yet.',
        'Email provider: not decided yet. It will be named here before Fire Watch sends any email.',
        'Telegram and the push services of Google, Mozilla and Apple: only after alerts launch, and only if you choose that channel.',
      ],
    },
    sources: {
      title: 'Where the fire data comes from',
      paragraphs: [
        'NASA (FIRMS and LANCE), EUMETSAT and the EU Copernicus programme publish the satellite data Fire Watch shows. We download their data; we send them nothing about you, so they are sources, not recipients of your data.',
      ],
    },
    transfers: {
      title: 'Transfers outside the EU',
      paragraphs: [
        'Our servers and database are in the EU. Cloudflare, OpenFreeMap and Esri may process data outside the EU, including in the United States. The safeguard each of them relies on, such as the EU–US Data Privacy Framework or standard contractual clauses, will be confirmed and stated here before public launch.',
      ],
    },
    retention: {
      title: 'How long we keep it',
      paragraphs: [
        'The retention period for server logs has not been set yet. It will be stated here before public launch.',
      ],
    },
    rights: {
      title: 'Your rights',
      paragraphs: [
        'You have the right to access, correct and erase your personal data, to restrict its processing and to object to processing based on our legitimate interest.',
        'You may lodge a complaint with the Commission for Personal Data Protection (КЗЛД, cpdp.bg). The address for privacy requests will be published together with the controller.',
      ],
    },
  },

  disclaimer: {
    title: 'Limits of the service',
    paragraphs: [
      'What Fire Watch is: best-effort informational monitoring based on public satellite data. Satellite data arrives with a delay, usually 15 minutes to 3 hours, and it can miss fires: small or short-lived fires, fire under dense canopy and anything below cloud.',
      'What it is not: an official warning system, an emergency-notification service or a replacement for 112 or BG-ALERT. It complements official channels. It never announces that a fire has ended; only the authorities can say that.',
      'In an emergency, call 112 and follow the instructions of the authorities.',
      'The satellite data is published by NASA, EUMETSAT and Copernicus "as is", and we pass it on on the same terms. Delays and gaps in their data are outside our control.',
      'Nothing here limits the rights you have as a consumer under Bulgarian and EU law, or any liability that the law does not allow to be limited.',
    ],
    lanceIntro: 'NASA, which publishes the fire detection data, attaches this notice to it:',
    linkLabel: 'Limits of the service and privacy',
    alertsTitle: 'Alerts',
    alertsNote:
      'Alerts are not available yet. When they are, delivery will be best effort: it depends on your device and its settings and can be delayed or fail. Do not rely on alerts as your only warning; in an emergency, call 112.',
  },

  signIn: {
    title: 'Sign in',
    accountTitle: 'Account',
    accountNote: 'Sign in with a link sent to your email address. There is no password.',
    emailLabel: 'Email address',
    send: 'Send sign-in link',
    sending: 'Sending…',
    sent: 'If this address can sign in, we have sent it a link. Open it in this browser. The link works once and expires soon.',
    rateLimited: 'Too many sign-in links were requested. Try again later.',
    invalidEmail: 'Enter a valid email address.',
    failed: 'That did not work. Check your connection and try again.',
    unavailable: 'Sign-in is not available on this site yet.',
    continueTitle: 'Finish signing in',
    continueIntro: 'Press Continue to sign in on this device.',
    continue: 'Continue',
    working: 'Signing in…',
    noLink: 'This page opens from a sign-in link. Request a new link to sign in.',
    expired: 'This sign-in link has expired.',
    used: 'This sign-in link has already been used.',
    invalid: 'This sign-in link is not valid.',
    superseded: 'A newer sign-in link was sent. Only the latest link works.',
    otherBrowser: 'This sign-in link must be opened in the browser it was requested from.',
    requestNew: 'Request a new link',
    signedInTitle: 'Signed in',
    accountCreated: 'Your account is ready, and you are signed in on this device.',
    signedIn: 'You are signed in on this device.',
    signOut: 'Sign out',
    signedOut: 'You are signed out on this device.',
  },
};

export default messages;
