/**
 * The register of catalog copy awaiting founder review (`PENDING_FOUNDER_REVIEW`).
 *
 * Asserted exactly, so adding implementer-written copy or clearing it after review is
 * always a visible edit to this file as well as to the register. Pending copy must be
 * own-voice — a frozen glossary line or a mandated claim is never drafted by an
 * implementer — and must render to real text in both catalogs.
 */

import { describe, expect, it } from 'vitest';

import type { Locale } from '../types.js';
import bg from './bg.js';
import {
  CATALOG_GOVERNANCE,
  PENDING_FOUNDER_REVIEW,
  classificationKey,
  governanceOf,
} from './catalog-governance.js';
import { renderCatalog } from './catalog-render.js';
import en from './en.js';
import type { Messages } from './messages.js';

const catalogs: readonly (readonly [Locale, Messages])[] = [
  ['bg', bg],
  ['en', en],
];

describe('PENDING_FOUNDER_REVIEW', () => {
  it('lists exactly the copy awaiting review', () => {
    expect([...PENDING_FOUNDER_REVIEW]).toEqual([
      // TASKS F6 — share card.
      'shareCard.share',
      'shareCard.observedAt',
      'shareCard.madeAt',
      // TASKS I5 — privacy page and layered disclaimers; legal review pending as well.
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
      // TASKS L16 — the accessibility statement; legal review pending as well.
      'accessibility.title',
      'accessibility.draftNotice',
      'accessibility.dated',
      'accessibility.target.title',
      'accessibility.target.paragraphs',
      'accessibility.scope.title',
      'accessibility.scope.paragraphs',
      'accessibility.alternative.title',
      'accessibility.alternative.paragraphs',
      'accessibility.knownGaps.title',
      'accessibility.knownGaps.paragraphs',
      'accessibility.testing.title',
      'accessibility.testing.paragraphs',
      'accessibility.legal.title',
      'accessibility.legal.paragraphs',
      'accessibility.contact.title',
      'accessibility.contact.paragraphs',
      'accessibility.linkLabel',
      // TASKS G6 — imagery toggle label.
      'mapControls.imagery',
      // TASKS I1 — sign-in by email link.
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
      'newSignals.regionLabel',
      'newSignals.count',
      'newSignals.latest',
      'newSignals.showNewest',
      'newSignals.markAllSeen',
      'newSignals.soundTitle',
      'newSignals.soundLabel',
      'newSignals.soundNote',
      // Rich event panel — timeline, FRP, sensors, distance.
      'eventDetail.eventIdLabel',
      'eventDetail.copied',
      'eventDetail.copyFailed',
      'eventDetail.timelineTitle',
      'eventDetail.firstDetected',
      'eventDetail.lastDetected',
      'eventDetail.detectionsLabel',
      'eventDetail.lastSensorLabel',
      'eventDetail.frpTitle',
      'eventDetail.frpLatest',
      'eventDetail.frpPeak',
      'eventDetail.frpChartLabel',
      'eventDetail.frpNote',
      'eventDetail.frpUnavailable',
      'eventDetail.sensorsTitle',
      'eventDetail.orbit.polar',
      'eventDetail.orbit.geostationary',
      'eventDetail.sensorPixel',
      'eventDetail.metres',
      'eventDetail.kilometres',
      'eventDetail.detailUnavailable',
      'eventDetail.whereTitle',
      'eventDetail.approxCentreLabel',
      'eventDetail.copyCoordinates',
      'eventDetail.openStreetMap',
      'eventDetail.showDistance',
      'eventDetail.locating',
      'eventDetail.locationDenied',
      'eventDetail.locationUnavailable',
      'eventDetail.distance',
      'eventDetail.nearby',
      'eventDetail.compass.N',
      'eventDetail.compass.NE',
      'eventDetail.compass.E',
      'eventDetail.compass.SE',
      'eventDetail.compass.S',
      'eventDetail.compass.SW',
      'eventDetail.compass.W',
      'eventDetail.compass.NW',
      'eventDetail.orientationNote',
      // TASKS F — finer time presets, source/region filters, place search.
      'ageWindow.option.1h',
      'ageWindow.option.3h',
      'ageWindow.option.12h',
      'ageWindow.emptyShortWindow',
      'filters.label',
      'filters.sourceLabel',
      'filters.sourceAll',
      'filters.sourceOption',
      'filters.family.v',
      'filters.family.m',
      'filters.family.s',
      'filters.family.g',
      'filters.sourceUnreported',
      'filters.regionLabel',
      'filters.regionAll',
      'filters.regionLoading',
      'filters.regionFailed',
      'filters.hiddenByFilters',
      'filters.clear',
      'filters.emptyFiltered',
      'search.label',
      'search.placeholder',
      'search.loading',
      'search.failed',
      'search.noResults',
      'search.goToCoordinates',
      'search.resultCount',
      // TASKS G4 — the Layers panel and its EFFIS overlays.
      'layers.toggle',
      'layers.panelLabel',
      'layers.basemapTitle',
      'layers.basemapMap',
      'layers.overlaysTitle',
      'layers.fwi',
      'layers.fwiNote',
      'layers.fwiLegendTitle',
      'layers.fwiClasses',
      'layers.fwiValidFor',
      'layers.fwiNotToday',
      'layers.ba',
      'layers.baNote',
      'layers.copyDated',
      'layers.suspect',
      'layers.loading',
      'layers.unavailable',
      // TASKS F14 — the wind context layer.
      'layers.wind',
      'layers.windNote',
      'layers.windLegendTitle',
      'layers.windClasses',
      'layers.windValidFor',
      // TASKS F16 — the static hot-source mask: its Layers toggle and the event caveat.
      'layers.staticSources',
      'layers.staticSourcesNote',
      'eventDetail.staticSourceSolar',
      'eventDetail.staticSourceIndustrial',
      'eventDetail.staticSourceDetectionsSolar',
      'eventDetail.staticSourceDetectionsIndustrial',
      'eventDetail.staticSourceServer',
      // TASKS F18 — the lightning context on the event detail page.
      'eventDetail.lightningContextFlashes',
      'eventDetail.lightningContextNone',
      'eventDetail.lightningContextNoData',
      // TASKS F15 — the predicted swath overlay (its Layers toggle and legend).
      'layers.swaths',
      'layers.swathsNote',
      'layers.swathsNext',
      'layers.swathsRecent',
      'layers.swathsPassAt',
      // TASKS F18 — the lightning context layer (its Layers toggle and legend).
      'layers.lightning',
      'layers.lightningNote',
      'layers.lightningLegendTitle',
      'layers.lightningClasses',
      'layers.lightningAsOf',
      'layers.lightningNone',
      // TASKS F15 — the satellite-pass section of the Layers panel.
      'passes.title',
      'passes.note',
      'passes.forMapCentre',
      'passes.forEvent',
      'passes.outsideArea',
      'passes.predicted',
      'passes.computedFor',
      'passes.expired',
      'passes.lastPass',
      'passes.nextPass',
      'passes.none',
      'passes.inTime',
      'passes.day',
      'passes.night',
      'passes.elementsStale',
      'passes.elementsMissing',
      // TASKS F17 — the per-pass cloud forecast and its caveat.
      'passes.cloudClear',
      'passes.cloudPartly',
      'passes.cloudCloudy',
      'passes.cloudForecast',
      'passes.cloudCaveat',
    ]);
  });

  it('holds only own-voice copy', () => {
    for (const path of PENDING_FOUNDER_REVIEW) {
      expect(governanceOf(path).governance, path).toBe('own-voice');
    }
  });

  // Legal copy is the one kind whose wording an implementer may never call final, so the
  // posture that names it and this register cannot disagree: every `legal-notice` path is
  // pending. Clearing one after legal review is a deliberate edit here as well.
  it('holds every legal-notice path', () => {
    const legal = Object.keys(CATALOG_GOVERNANCE).filter((path) => {
      const governance = governanceOf(path);
      return governance.governance === 'own-voice' && governance.reason === 'legal-notice';
    });
    expect(legal.length).toBeGreaterThan(0);
    for (const path of legal) {
      expect(PENDING_FOUNDER_REVIEW as readonly string[], path).toContain(path);
    }
  });

  it.each(catalogs)('renders every pending path to non-empty text in %s', (_locale, messages) => {
    const rendered = renderCatalog(messages);
    for (const path of PENDING_FOUNDER_REVIEW) {
      // Array paths render per element (`privacy.summary[0]`); match on the classification key.
      const texts = rendered
        .filter((message) => classificationKey(message.path) === path)
        .map((m) => m.text);
      expect(texts.length, path).toBeGreaterThan(0);
      for (const text of texts) expect(text.trim(), path).not.toBe('');
    }
  });
});
