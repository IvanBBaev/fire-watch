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
      // TASKS L15 — the staff curation form.
      'staffCuration.title',
      'staffCuration.draftNotice',
      'staffCuration.intro',
      'staffCuration.unavailable',
      'staffCuration.openTitle',
      'staffCuration.openLabel',
      'staffCuration.open',
      'staffCuration.formTitle',
      'staffCuration.fields.eventId',
      'staffCuration.fields.statementType',
      'staffCuration.fields.sourceLegend',
      'staffCuration.fields.secondSourceLegend',
      'staffCuration.fields.useSecondSource',
      'staffCuration.fields.tier',
      'staffCuration.fields.url',
      'staffCuration.fields.capture',
      'staffCuration.fields.statedAt',
      'staffCuration.fields.exception',
      'staffCuration.fields.justification',
      'staffCuration.fields.correctionText',
      'staffCuration.type.officially_contained',
      'staffCuration.type.officially_extinguished',
      'staffCuration.type.curated_correction',
      'staffCuration.tier.T1',
      'staffCuration.tier.T2',
      'staffCuration.tier.T3',
      'staffCuration.tier.T4',
      'staffCuration.exception.none',
      'staffCuration.exception.t1_de_escalation',
      'staffCuration.exception.life_safety_relay',
      'staffCuration.exception.own_correction',
      'staffCuration.status.draft',
      'staffCuration.status.in_review',
      'staffCuration.status.published',
      'staffCuration.versionLabel',
      'staffCuration.statusLabel',
      'staffCuration.correctsLabel',
      'staffCuration.youWrote',
      'staffCuration.actions.save',
      'staffCuration.actions.submit',
      'staffCuration.actions.approve',
      'staffCuration.actions.reject',
      'staffCuration.actions.correct',
      'staffCuration.actions.newStatement',
      'staffCuration.working',
      'staffCuration.outcome.saved',
      'staffCuration.outcome.submitted',
      'staffCuration.outcome.published',
      'staffCuration.outcome.returned',
      'staffCuration.outcome.failed',
      'staffCuration.refusal.notSignedIn',
      'staffCuration.refusal.forbidden',
      'staffCuration.refusal.invalid',
      'staffCuration.refusal.sourceUnverified',
      'staffCuration.refusal.captureMissing',
      'staffCuration.refusal.notFound',
      'staffCuration.refusal.wrongStatus',
      'staffCuration.refusal.selfReview',
      'staffCuration.refusal.conflict',
      'staffCuration.issuesTitle',
      'staffCuration.issue.event_id_invalid',
      'staffCuration.issue.statement_type_invalid',
      'staffCuration.issue.source_tier_invalid',
      'staffCuration.issue.source_unverified',
      'staffCuration.issue.source_url_invalid',
      'staffCuration.issue.capture_missing',
      'staffCuration.issue.stated_at_invalid',
      'staffCuration.issue.stated_at_in_future',
      'staffCuration.issue.journalistic_source_for_state',
      'staffCuration.issue.second_source_required',
      'staffCuration.issue.official_source_missing',
      'staffCuration.issue.second_source_unverified',
      'staffCuration.issue.second_source_not_independent',
      'staffCuration.issue.second_source_capture_missing',
      'staffCuration.issue.second_source_url_invalid',
      'staffCuration.issue.exception_invalid',
      'staffCuration.issue.exception_not_applicable',
      'staffCuration.issue.justification_missing',
      'staffCuration.issue.justification_not_one_line',
      'staffCuration.issue.correction_text_missing',
      'staffCuration.issue.correction_text_invalid',
      'staffCuration.issue.correction_text_not_allowed',
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
      // V2-D1 — export
      'dataExport.downloadList',
      'dataExport.downloadDetections',
      'dataExport.formatsLabel',
      'dataExport.preparing',
      'dataExport.failed',
      'dataExport.eventsTitle',
      'dataExport.detectionsTitle',
      'dataExport.notice',
      // V2-D4 — og:image
      'ogImage.alt',
      // V2-A4 — estimated outlines
      'layers.outlines',
      'layers.outlinesNote',
      'layers.outlinesLegend',
      'layers.outlinesAsOf',
      'layers.outlinesTruncated',
      'layers.outlinesNone',
      'eventDetail.fireOutlineArea',
      'eventDetail.fireOutlineCaveat',
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
