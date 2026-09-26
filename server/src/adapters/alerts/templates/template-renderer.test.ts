import { describe, expect, it } from 'vitest';

import { ALERT_COPY_PENDING_FOUNDER_REVIEW } from '../../../core/alerts/templates/alert-copy.js';
import {
  DRAFT_ALERT_TEMPLATES,
  isReviewedTemplate,
} from '../../../core/alerts/templates/alert-templates.js';
import type { RenderRequest } from '../../../core/ports/alert-renderer.js';
import {
  REVIEWED_TEMPLATES,
  createTemplateRenderer,
  type AlertTemplate,
} from './template-renderer.js';

const request = (templateId: string): RenderRequest => ({
  templateId,
  templateParams: { distanceKm: 4 },
  channel: 'push',
  locale: 'bg',
  timeZone: 'Europe/Sofia',
});

describe('createTemplateRenderer', () => {
  it('registers no template while its copy is pending founder review', () => {
    // H6 drafted all three templates; every own-voice string is still pending, so none is
    // reviewed. Unreviewed wording that reached a phone would be unreviewed copy, sent (D7).
    expect(ALERT_COPY_PENDING_FOUNDER_REVIEW.length).toBeGreaterThan(0);
    expect(REVIEWED_TEMPLATES.size).toBe(0);
  });

  it('registers exactly the drafts whose copy is reviewed', () => {
    for (const id of DRAFT_ALERT_TEMPLATES.keys()) {
      expect(REVIEWED_TEMPLATES.has(id), id).toBe(isReviewedTemplate(id));
    }
  });

  it('fails closed on a template nobody reviewed', () => {
    expect(() => createTemplateRenderer().render(request('new_fire.bg.v3'))).toThrow(
      'no reviewed template registered for new_fire.bg.v3',
    );
  });

  it('renders by exact id and never falls back to a similar one', () => {
    const template: AlertTemplate = (req) => ({
      title: `t:${req.locale}`,
      body: `b:${String(req.templateParams['distanceKm'])}`,
      footer: 'f',
      url: 'https://example.invalid/e/1',
    });
    const renderer = createTemplateRenderer(new Map([['new_fire.bg.v3', template]]));

    expect(renderer.render(request('new_fire.bg.v3'))).toEqual({
      title: 't:bg',
      body: 'b:4',
      footer: 'f',
      url: 'https://example.invalid/e/1',
    });
    expect(() => renderer.render(request('new_fire.bg.v4'))).toThrow(/new_fire\.bg\.v4/);
  });
});
