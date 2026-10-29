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
