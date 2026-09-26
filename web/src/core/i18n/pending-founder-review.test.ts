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
