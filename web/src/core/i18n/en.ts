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
  // V2-D1 — export. PENDING FOUNDER REVIEW — see PENDING_FOUNDER_REVIEW in catalog-governance.ts.
  dataExport: {
    downloadList: 'Download list',
    downloadDetections: 'Download detections',
    formatsLabel: 'File format',
    preparing: 'Preparing the file…',
    failed: 'The file could not be prepared. Try again.',
    eventsTitle: 'Fire Watch: satellite-detected fire events',
    detectionsTitle: (place) => `Fire Watch: satellite detections of the fire near ${place}`,
    notice:
      'Satellite detections, not confirmed fires: a satellite can miss a fire or detect heat that is not one. ' +
      'score_bucket is a satellite score band, not a confirmation on the ground. All times are UTC.',
  },
  // V2-D4 — og:image. PENDING FOUNDER REVIEW — see PENDING_FOUNDER_REVIEW in catalog-governance.ts.
  ogImage: {
    alt: (place) => `Fire Watch card for the satellite-detected fire near ${place}`,
  },

  ageWindow: {
    label: 'Time window',
    // Short on purpose: four of these sit side by side in the panel, and the group label
    // above them is what says these are hours of look-back.
    option: {
      '1h': '1 h',
      '3h': '3 h',
      '6h': '6 h',
      '12h': '12 h',
      '24h': '24 h',
      '48h': '48 h',
      all: 'All',
    },
    olderHidden: (count) =>
      count === 1 ? '1 older fire hidden' : `${formatNumber(count, 'en')} older fires hidden`,
    showOlder: 'Show older',
    emptyInWindow: 'No satellite detections in this time window. Widen it to see older ones.',
    emptyShortWindow:
      'No new satellite detections in this time window. Satellites pass only a few times a day, so a short window is often empty.',
  },

  filters: {
    label: 'Filters',
    sourceLabel: 'Sensor',
    sourceAll: (count) => `All sensors (${formatNumber(count, 'en')})`,
    sourceOption: (name, count) => `${name} (${formatNumber(count, 'en')})`,
    family: { v: 'VIIRS', m: 'MODIS', s: 'Sentinel-3 SLSTR', g: 'Meteosat SEVIRI/FCI' },
    sourceUnreported: (count) =>
      count === 1
        ? 'For 1 fire the feed does not say which sensor saw it; it is shown under every sensor.'
        : `For ${formatNumber(count, 'en')} fires the feed does not say which sensor saw them; they are shown under every sensor.`,
    regionLabel: 'Region',
    regionAll: 'All regions',
    regionLoading: 'Loading region borders…',
    regionFailed: 'Region borders could not be loaded, so fires from all regions are shown.',
    hiddenByFilters: (count) =>
      count === 1
        ? '1 fire hidden by filters'
        : `${formatNumber(count, 'en')} fires hidden by filters`,
    clear: 'Clear filters',
    emptyFiltered: 'No satellite detections match these filters.',
    sensitivityLabel: 'Signals',
    sensitivityPreset: {
      all: 'All signals',
      balanced: 'Balanced',
      multi: 'Seen several times',
    },
    sensitivityCustom: 'Custom',
    sensitivityOption: (name, count) => `${name} (${formatNumber(count, 'en')})`,
    sensitivityAdvanced: 'Signal criteria',
    sensitivityMinBand: 'Lowest tier',
    sensitivityMinDetections: 'Detections',
    sensitivityMinSensors: 'Satellites',
    sensitivityAtLeast: (count) =>
      count === 1 ? 'Any number' : `At least ${formatNumber(count, 'en')}`,
    sensitivityHint: 'Weaker signals are hidden. A hidden signal may still be a real fire.',
    sensitivityUnreported: (count) =>
      count === 1
        ? 'For 1 fire the feed does not say how many satellites saw it; it is shown anyway.'
        : `For ${formatNumber(count, 'en')} fires the feed does not say how many satellites saw them; they are shown anyway.`,
  },

  search: {
    label: 'Find a place',
    placeholder: 'Town, village or coordinates',
    loading: 'Loading places…',
    failed: 'Places could not be loaded. Coordinates still work.',
    noResults: 'No matching place',
    goToCoordinates: (coordinates) => `Go to ${coordinates}`,
    resultCount: (count) => (count === 1 ? '1 result' : `${formatNumber(count, 'en')} results`),
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

  measure: {
    toggle: 'Measure',
    panelLabel: 'Measure on the map',
    modeLabel: 'What to measure',
    mode: {
      distance: 'Distance along a line',
      area: 'Area of an outline',
      nearest: 'Distance to the nearest active fire',
    },
    hint: {
      distance: 'Tap the map or add the map centre: two points or more.',
      area: 'Tap the map or add the map centre: three points or more around the outline.',
      nearest: 'Tap the map or add the map centre to pick a place.',
    },
    addCentre: 'Add the map centre',
    undo: 'Undo last point',
    clear: 'Clear',
    distanceResult: (length) => `Distance: ${length}`,
    areaResult: (area, perimeter) => `Area: ${area}; perimeter ${perimeter}`,
    nearestResult: (length, place) => `Nearest active fire: ${length}, near ${place}`,
    nearestNone: 'No active satellite detection is on the map under the current filters.',
    approxNote: 'Straight lines on the globe, approximate. Not a route and not a travel time.',
  },

  layers: {
    toggle: 'Layers',
    panelLabel: 'Map layers',
    basemapTitle: 'Base map',
    basemapMap: 'Map',
    overlaysTitle: 'Context layers',
    fwi: 'Fire danger (weather index)',
    fwiNote:
      "EFFIS Fire Weather Index, ~8 km grid: how favourable today's weather is for fire. Not a forecast of where fires will start.",
    fwiLegendTitle: 'Danger level',
    fwiClasses: ['Low', 'Moderate', 'High', 'Very high', 'Extreme', 'Very extreme'],
    fwiValidFor: (date) => `For ${date}`,
    fwiNotToday: "Not today's index.",
    fwiDayLabel: 'Forecast day',
    fwiDayOption: (leadDays) =>
      leadDays === 0 ? 'Today' : leadDays === 1 ? '+1 day' : `+${String(leadDays)} days`,
    fwiForecastNote:
      'Days ahead are the GWIS fire-weather forecast (ECMWF model), relayed as EFFIS publishes it, in the same danger levels. It forecasts the weather, not fires.',
    fwiForecastFor: (date) => `EFFIS/GWIS forecast for ${date}, relayed as published`,
    fwiForecastBehind: 'Not the day you picked: the newer forecast copy has not arrived yet.',
    ba: 'Burnt areas (last 7 days)',
    baNote:
      'EFFIS burnt-area polygons mapped from satellite imagery. A new burnt area appears days after the fire.',
    copyDated: (time) => `Copy dated ${time}`,
    suspect: 'This copy failed our quality check and may be blank or incomplete.',
    loading: 'Loading…',
    unavailable: 'Not available right now.',
    wind: 'Wind (10 m above ground)',
    windNote:
      'ECMWF forecast wind, ~50 km grid. Arrows point where the wind blows. Context only: not a prediction of how any fire will behave.',
    windLegendTitle: 'Wind speed (m/s)',
    windClasses: ['Under 2', '2 to 5', '5 to 8', '8 to 11', '11 and above'],
    windValidFor: (time, run) => `For ${time} (ECMWF run ${run})`,
    staticSources: 'Known heat sources',
    staticSourcesNote:
      'Solar parks, power plants, gas flares and heavy industry mapped in OpenStreetMap. Satellites can see their heat as a hotspot.',
    protectedSites: 'Protected sites (Natura 2000)',
    protectedSitesNote:
      'Special Protection Areas for birds and Sites of Community Importance for habitats, from the European Environment Agency. Bulgaria, Greece and Romania only: North Macedonia, Serbia and Turkey are outside Natura 2000.',
    swaths: 'Satellite swaths (predicted)',
    swathsNote:
      'Where each fire-detecting satellite looked in the last 6 hours and should look in the next 12, predicted from its orbit. A swath is a chance to detect a fire, not a promise.',
    swathsNext: 'Next passes (outline)',
    swathsRecent: 'Recent passes (shaded)',
    swathsPassAt: (platform, time) => `${platform} at ${time}`,
    lightning: 'Lightning (last 6 hours)',
    lightningNote:
      'Flashes seen from space by the Meteosat Lightning Imager, placed to within about 5 km. Context only: a flash near a fire does not mean lightning started it.',
    lightningLegendTitle: 'Flash age',
    lightningClasses: ['Under 15 minutes', '15 minutes to 1 hour', '1 to 6 hours'],
    lightningAsOf: (time) => `Flashes recorded up to ${time}`,
    lightningNone: 'No flashes recorded over the area in the last 6 hours.',
    outlines: 'Estimated fire outlines',
    outlinesNote:
      'Estimated outline from satellite detections: the pixels that saw heat. Not an official perimeter or a forecast.',
    outlinesLegend: 'Estimated outline',
    outlinesAsOf: (time) => `Outlines redrawn as of ${time}`,
    outlinesTruncated: 'Only the largest outlines.',
    outlinesNone: 'No estimated outline on the map right now.',
  },

  // PENDING FOUNDER REVIEW — see PENDING_FOUNDER_REVIEW in catalog-governance.ts.
  passes: {
    title: 'Satellite passes',
    note: 'Predicted times when the fire-detecting satellites pass over this area, computed from their orbits. A pass is a chance to detect a fire, not a promise: cloud, smoke or a small fire can hide it.',
    forMapCentre: 'Area: the map centre',
    forEvent: 'Area: the selected event',
    outsideArea: 'Pass times cover only the area we poll. Move the map inside it to see them.',
    predicted: 'Predicted',
    computedFor: (time) => `Predicted from orbital elements, computed for ${time}.`,
    expired: 'This prediction is older than its window. Later passes are not loaded yet.',
    lastPass: 'Last pass',
    nextPass: 'Next predicted pass',
    none: 'None in the window',
    inTime: (age) => {
      switch (age.unit) {
        case 'now':
          return 'about now';
        case 'minutes':
          return `in ${String(age.minutes)} min`;
        case 'hours':
          return age.minutes === 0
            ? `in ${String(age.hours)} h`
            : `in ${String(age.hours)} h ${String(age.minutes)} min`;
        case 'days':
          return age.days === 1 ? 'in 1 day' : `in ${formatNumber(age.days, 'en')} days`;
      }
    },
    day: 'daytime',
    night: 'night-time',
    elementsStale: 'Orbital elements are more than three days old; these times are less certain.',
    elementsMissing: 'No current orbital elements for this satellite, so no prediction.',
    cloudClear: 'mostly clear',
    cloudPartly: 'partly cloudy',
    cloudCloudy: 'cloudy',
    cloudForecast: (level, pct) => `cloud forecast: ${level}, ${pct}%`,
    cloudCaveat:
      'Cloud is an ECMWF forecast for each pass time, not an observation. A fire under cloud may be missed.',
  },

  // PENDING FOUNDER REVIEW — see PENDING_FOUNDER_REVIEW in catalog-governance.ts.
  playback: {
    toggle: 'Replay',
    title: 'Replay past detections',
    note: 'Replays the hotspots satellites detected over the chosen window. A dot is a satellite detection, not a confirmed fire, and the replay shows only what was seen — it does not predict where anything goes next.',
    rangeLabel: 'Window',
    ranges: ['Last 24 hours', 'Last 3 days', 'Last 7 days'],
    scrubberLabel: 'Replay time',
    play: 'Play',
    pause: 'Pause',
    stepBack: 'Step back',
    stepForward: 'Step forward',
    speed: (factor) => `Speed ${formatNumber(factor, 'en')}×`,
    backToLive: 'Back to live',
    cursorAt: (time) => `Detections up to ${time}`,
    shownCount: (count) =>
      count === 1 ? '1 detection shown' : `${formatNumber(count, 'en')} detections shown`,
    loading: 'Loading the window…',
    unavailable: 'This window could not be loaded. The map still shows the live detections.',
    empty:
      'No satellite detections in this window. Satellites can miss a fire under cloud or smoke.',
    truncated: 'This window holds more detections than can be shown; the oldest are left out.',
    legendTitle: 'Age at the shown time',
    ageClasses: ['Under 1 hour', '1 to 6 hours', '6 to 24 hours', 'Over 24 hours'],
    sizeNote: 'A larger dot is a detection with higher fire radiative power (FRP).',
  },

  // PENDING FOUNDER REVIEW — see PENDING_FOUNDER_REVIEW in catalog-governance.ts.
  meteoalarm: {
    title: 'Official weather warnings',
    note: 'Forest-fire and heat warnings in force from the national weather services of Bulgaria and its neighbours, relayed as they publish them through MeteoAlarm. Fire Watch does not issue warnings: follow the issuing service.',
    checkedAt: (time) => `Warning feeds read at ${time}.`,
    forestFire: 'Forest-fire danger',
    highTemperature: 'High temperature',
    level2: 'Yellow warning',
    level3: 'Orange warning',
    level4: 'Red warning',
    validFromTo: (from, to) => `In force from ${from} to ${to}`,
    validUntil: (to) => `In force until ${to}`,
    officialLink: 'Official warning',
    noneInForce: 'None of the services read has a forest-fire or heat warning in force.',
    notChecked: (countries) => `Not read on the last check: ${countries}.`,
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

  accessibility: {
    title: 'Accessibility statement',
    draftNotice:
      'Draft: this statement has not yet been approved by the operator or reviewed by a lawyer, and the manual test with assistive technology described below has not been carried out yet. It describes Fire Watch as it works today.',
    dated:
      'Prepared on 22 October 2026. It will be reviewed after every manual accessibility test and at least once a year.',
    target: {
      title: 'Our target',
      paragraphs: [
        'We aim for Fire Watch to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA, as set out in the European standard EN 301 549.',
        'Fire Watch does not meet that target in full yet. The gaps we know about are listed below.',
      ],
    },
    scope: {
      title: 'What this statement covers',
      paragraphs: [
        'Covered: the list of satellite detections, the event pages, the filters, the settings (including alert settings once alerts are available), alert email, this page and the other information pages, and every error and degraded-service message.',
        'Covered through an alternative: the interactive map. A map drawn on a canvas cannot be read by a screen reader, so everything it shows is also available as text in the list and on each event page.',
        'Not covered for now: the internal tools used by the people who operate the service. They will be brought into scope before anyone outside the operating team uses them.',
      ],
    },
    alternative: {
      title: 'Using Fire Watch without the map',
      paragraphs: [
        'The list next to the map shows the same detections as the map, with the place, the sensor, the time the satellite passed and how long ago that was. Each item opens an event page with the same facts as text.',
        'Fire Watch works with the map turned off and in browsers that cannot draw it: you are shown the list instead. Everything can be reached with a keyboard alone.',
      ],
    },
    knownGaps: {
      title: 'Known limitations',
      paragraphs: [
        'The map itself cannot be used with a screen reader or a keyboard beyond its buttons. Use the list and the event pages instead.',
        'There is no "skip to content" link yet: with a keyboard, the first item in the list is about fifteen steps from the top of the page.',
        'Some colours used for map layers do not yet reach the contrast we aim for, or are hard to tell apart for people with some forms of colour vision deficiency. The facts they show are also given as text.',
        'The manual test with screen readers, keyboard-only use and enlarged text has not been carried out yet. Its results will be added to this page.',
      ],
    },
    testing: {
      title: 'How we test',
      paragraphs: [
        'Every change to Fire Watch is checked automatically: on four screen sizes for text size, reflow, target size and clipped content, and with an automated accessibility checker on every page.',
        'Once per fire season a person tests the service by hand with TalkBack on Android, VoiceOver on iPhone and NVDA with Firefox on Windows, with keyboard alone, and with the largest text and display size the phone allows. Each test is dated and its findings are fixed or listed here.',
      ],
    },
    legal: {
      title: 'Legal position',
      paragraphs: [
        'Fire Watch is operated by a microenterprise. Under Directive (EU) 2019/882 (the European Accessibility Act) and the Bulgarian Act on the Accessibility Requirements for Products and Services, microenterprises that provide services are exempt from the accessibility requirements.',
        'We do not rely on that exemption. We commit to the target above voluntarily, because people who cannot use the map need to know about fires near them as much as anyone.',
      ],
    },
    contact: {
      title: 'Reporting a barrier',
      paragraphs: [
        'If something in Fire Watch is hard or impossible for you to use, tell us what you were trying to do and on which device. The address for these reports will be published here before public launch.',
        'Fire Watch is not an emergency service. In an emergency, call 112.',
      ],
    },
    linkLabel: 'Accessibility statement',
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

  // PENDING FOUNDER REVIEW — see PENDING_FOUNDER_REVIEW in catalog-governance.ts.
  staffCuration: {
    title: 'Curated statements',
    draftNotice:
      "Staff only. This form is a draft: the editorial standard behind it awaits the founder's sign-off.",
    intro:
      'A statement records what an official source said about one event. It is published only after a second staff member, who did not write it, approves it.',
    unavailable: 'The staff tools are not served on this site.',
    openTitle: 'Open a statement',
    openLabel: 'Statement id',
    open: 'Open',
    formTitle: 'Statement',
    fields: {
      eventId: 'Event id',
      statementType: 'What the source states',
      sourceLegend: 'Source',
      secondSourceLegend: 'Second, independent source',
      useSecondSource: 'Cite a second source',
      tier: 'Tier',
      url: 'Link',
      capture: 'Capture reference',
      statedAt: "Stated at (the source's own time, ISO 8601)",
      exception: 'Exception to the two-source rule',
      justification: 'Justification (one line)',
      correctionText: 'What is now known',
    },
    type: {
      officially_contained: 'Official milestone 1 — spread stopped',
      officially_extinguished: 'Official milestone 2 — final',
      curated_correction: 'Correction of a published statement',
    },
    tier: {
      T1: 'T1 — official, durable',
      T2: 'T2 — official, short-lived',
      T3: 'T3 — journalistic',
      T4: 'T4 — unverified (never accepted)',
    },
    exception: {
      none: 'None: two sources',
      t1_de_escalation: 'A T1 bulletin alone',
      life_safety_relay: 'Life-safety relay (not applicable yet)',
      own_correction: 'Our own correction',
    },
    status: {
      draft: 'Draft',
      in_review: 'In review',
      published: 'Published',
    },
    versionLabel: 'Version',
    statusLabel: 'Status',
    correctsLabel: 'Corrects version',
    youWrote: 'You wrote this version, so another staff member approves it.',
    actions: {
      save: 'Save draft',
      submit: 'Send for review',
      approve: 'Approve and publish',
      reject: 'Return to the authors',
      correct: 'Open a correction',
      newStatement: 'Start a new statement',
    },
    working: 'Working…',
    outcome: {
      saved: 'Saved as a draft.',
      submitted: 'Sent for review.',
      published: 'Published.',
      returned: 'Returned to its authors as a draft.',
      failed: 'That did not work. Try again.',
    },
    refusal: {
      notSignedIn: 'Sign in to the staff plane first.',
      forbidden: 'This needs an editor whose session has passed its second factor.',
      invalid: 'The server refused the statement under the editorial standard.',
      sourceUnverified: 'An unverified (T4) source is never the basis of a statement.',
      captureMissing: 'Every cited source needs its archived copy.',
      notFound: 'There is no statement with this id.',
      wrongStatus: 'The statement is not in a state that allows this step.',
      selfReview: 'A statement is approved by someone who did not write it.',
      conflict: 'Someone changed the statement since it was opened. Open it again.',
    },
    issuesTitle: 'Fix before saving',
    issue: {
      event_id_invalid: 'The event id is missing or malformed.',
      statement_type_invalid: 'Choose what the source states from the list.',
      source_tier_invalid: "Choose the source's tier.",
      source_unverified: 'An unverified (T4) source cannot be cited.',
      source_url_invalid: 'The source link must be a full web address.',
      capture_missing: "Add the source's archived copy.",
      stated_at_invalid: 'Enter the time the source stated it.',
      stated_at_in_future: 'The stated time is in the future.',
      journalistic_source_for_state:
        'A journalistic (T3) source cannot carry an official milestone.',
      second_source_required: 'Cite a second, independent source, or choose an exception.',
      official_source_missing: 'One of the two sources must be official (T1 or T2).',
      second_source_unverified: 'The second source cannot be unverified (T4).',
      second_source_not_independent: 'The second source must be a different publication.',
      second_source_capture_missing: "Add the second source's archived copy.",
      second_source_url_invalid: 'The second source link must be a full web address.',
      exception_invalid: 'Choose an exception from the list.',
      exception_not_applicable: 'That exception does not apply to this statement.',
      justification_missing: 'Write a one-line justification.',
      justification_not_one_line: 'The justification must be one line, within 280 characters.',
      correction_text_missing: 'A correction says what is now known.',
      correction_text_invalid: 'What is now known must be plain text, within 500 characters.',
      correction_text_not_allowed: 'Only a correction says what is now known.',
    },
  },
  newSignals: {
    regionLabel: 'New since you last looked',
    count: (count) =>
      count === 1
        ? '1 fire new or with new detections'
        : `${formatNumber(count, 'en')} fires new or with new detections`,
    latest: (age) => `Latest detection: ${age}`,
    showNewest: 'Show newest',
    markAllSeen: 'Mark all seen',
    soundTitle: 'Sound cue',
    soundLabel: 'Play a short sound when new satellite detections arrive while this page is open',
    soundNote:
      'A quiet cue, not an alarm. Satellite data can arrive hours after a pass, and your browser may keep the sound muted until you tap or click on the page.',
  },

  // PENDING FOUNDER REVIEW — see PENDING_FOUNDER_REVIEW in catalog-governance.ts.
  eventDetail: {
    eventIdLabel: 'Event ID',
    copied: 'Copied.',
    copyFailed: 'Could not copy. Select the text and copy it instead.',
    timelineTitle: 'Satellite timeline',
    firstDetected: 'First detected',
    lastDetected: 'Last detected',
    detectionsLabel: 'Detections',
    lastSensorLabel: 'Last seen by',
    frpTitle: 'Fire radiative power (FRP)',
    frpLatest: (mw, sensor, time) => `Latest pass: ${mw} MW (${sensor}, ${time})`,
    frpPeak: (mw, sensor, time) => `Highest pass: ${mw} MW (${sensor}, ${time})`,
    frpChartLabel: (passes, min, max) =>
      passes === 1
        ? `FRP chart: 1 satellite pass, ${max} MW`
        : `FRP chart: ${formatNumber(passes, 'en')} satellite passes, oldest to newest, from ${min} to ${max} MW`,
    frpNote:
      'FRP is the heat that satellite pixels measured, in megawatts, summed over one pass. It is not comparable across sensors: a coarser pixel reads the same fire differently, so a difference between sensors is not a change in the fire.',
    frpUnavailable: 'The detections we hold for this event carry no FRP values.',
    sensorsTitle: 'Contributing sensors',
    orbit: { polar: 'polar orbit', geostationary: 'geostationary' },
    sensorPixel: (size) => `${size} pixel`,
    metres: (value) => `${value} m`,
    kilometres: (value) => `${value} km`,
    detailUnavailable: 'Per-detection detail is not available for this event.',
    whereTitle: 'Where',
    approxCentreLabel: 'Approximate centre of the detections',
    copyCoordinates: 'Copy coordinates',
    openStreetMap: 'View the area on OpenStreetMap (opens in a new tab)',
    showDistance: 'Show distance from my location',
    locating: 'Finding your location…',
    locationDenied: 'Location permission denied, so no distance is shown.',
    locationUnavailable: 'Your location could not be determined.',
    distance: (km, direction) => `About ${km} km ${direction} of your location`,
    nearby: 'Less than 1 km from your location',
    compass: {
      N: 'north',
      NE: 'north-east',
      E: 'east',
      SE: 'south-east',
      S: 'south',
      SW: 'south-west',
      W: 'west',
      NW: 'north-west',
    },
    orientationNote: 'For orientation only, not directions. Your location stays on this device.',
    staticSourceSolar: 'Near a known solar park — this hotspot may not be a fire.',
    staticSourceIndustrial: 'Near a known industrial heat source — this hotspot may not be a fire.',
    staticSourceDetectionsSolar: (near, total) =>
      near === total
        ? total === 1
          ? 'Its only detection is near a known solar park — this hotspot may not be a fire.'
          : `All ${formatNumber(total, 'en')} detections are near a known solar park — this hotspot may not be a fire.`
        : `${formatNumber(near, 'en')} of ${formatNumber(total, 'en')} detections ${near === 1 ? 'is' : 'are'} near a known solar park — ${near === 1 ? 'it' : 'they'} may not be a fire.`,
    staticSourceDetectionsIndustrial: (near, total) =>
      near === total
        ? total === 1
          ? 'Its only detection is near a known industrial heat source — this hotspot may not be a fire.'
          : `All ${formatNumber(total, 'en')} detections are near a known industrial heat source — this hotspot may not be a fire.`
        : `${formatNumber(near, 'en')} of ${formatNumber(total, 'en')} detections ${near === 1 ? 'is' : 'are'} near a known industrial heat source — ${near === 1 ? 'it' : 'they'} may not be a fire.`,
    staticSourceServer:
      'Near a known heat source, according to our server check — this hotspot may not be a fire.',
    lightningContextFlashes: (count, radiusKm, hours, nearestKm) =>
      count === 1
        ? `Lightning context: 1 flash was recorded within ${formatNumber(radiusKm, 'en')} km in the ${formatNumber(hours, 'en')} hours before the first detection, ${formatNumber(nearestKm, 'en')} km away. Context only: it does not mean lightning started this fire.`
        : `Lightning context: ${formatNumber(count, 'en')} flashes were recorded within ${formatNumber(radiusKm, 'en')} km in the ${formatNumber(hours, 'en')} hours before the first detection, the nearest ${formatNumber(nearestKm, 'en')} km away. Context only: it does not mean lightning started this fire.`,
    lightningContextNone: (radiusKm, hours) =>
      `Lightning context: no flashes were recorded within ${formatNumber(radiusKm, 'en')} km in the ${formatNumber(hours, 'en')} hours before the first detection. The satellite misses some flashes, so this does not rule lightning out.`,
    lightningContextNoData:
      'Lightning context: no lightning data for the hours before the first detection.',
    fireOutlineArea: (area, low, high, edgeKm, pixels) =>
      `Estimated outline from satellite detections: ${area}${low === null ? `, up to ${high}` : ` (${low} to ${high})`}, from ${pixels === 1 ? '1 pixel' : `${formatNumber(pixels, 'en')} pixels`}; edges ±${formatNumber(edgeKm, 'en')} km.`,
    fireOutlineCaveat:
      'An estimate, not an official fire perimeter or a forecast: a pixel is larger than the fire it sees, so the burnt area may be much smaller.',
    protectedSiteInside: (name, code) => `Inside the Natura 2000 protected site ${name} (${code}).`,
    protectedSiteInsideSome: (inside, total, name, code) =>
      `${formatNumber(inside, 'en')} of ${formatNumber(total, 'en')} detections ${inside === 1 ? 'is' : 'are'} inside the Natura 2000 protected site ${name} (${code}).`,
    protectedSiteNear: (km, name, code) =>
      `About ${formatNumber(km, 'en')} km from the Natura 2000 protected site ${name} (${code}).`,
    landCover: (parts) => `Land cover (ESA WorldCover 2021): ${parts}.`,
    landCoverPart: (label, percent) => `${label} ${formatNumber(percent, 'en')}%`,
    landCoverTree: 'forest',
    landCoverShrub: 'shrubland',
    landCoverGrass: 'grassland',
    landCoverCrop: 'cropland',
    landCoverBuilt: 'built-up land',
    landCoverBare: 'bare ground',
    landCoverWater: 'water',
    landCoverWetland: 'wetland',
    cemsActivation: (code) => `Copernicus EMS activation ${code}`,
  },
};

export default messages;
