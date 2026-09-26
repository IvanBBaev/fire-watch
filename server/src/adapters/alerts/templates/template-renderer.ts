/**
 * The {@link AlertRenderer} the gateway runs with — a lookup from `template_id` to a
 * reviewed template, and nothing else.
 *
 * **The corpus is empty, and that is deliberate.** D7 says every template is reviewed copy
 * that passed the never-send lint in CI. H6 drafted the templates
 * (`core/alerts/templates/alert-templates.ts`) and CI-10/CI-11 run over them, but alert
 * copy is a founder decision: every own-voice string is in
 * `ALERT_COPY_PENDING_FOUNDER_REVIEW`, and a template that can render a pending string is
 * not reviewed. The registered set is *derived* from that register rather than listed
 * here, so clearing a template's copy after review is what arms it — and nothing else
 * can. Placeholder copy that reached a phone would be unreviewed copy, sent, which is
 * the one outcome D7 exists to prevent.
 *
 * A row whose template is not registered therefore fails closed. `render` throws, the
 * gateway counts the row `errored` and leaves it claimed, the dispatch job releases it on
 * the next cycle, and at its D6 deadline it closes `ttl_expired` — loud in every cycle
 * line (`errored`) and in A1.12's expiry page, and silent on every phone.
 *
 * Templates are plain functions from the render request to the three-part copy, and they
 * are registered by id: the id on the outbox row is "the exact reviewed template the
 * decision chose" (renderer port), so a lookup that fell back to a similar id would send
 * copy nobody chose.
 */

import {
  DRAFT_ALERT_TEMPLATES,
  isReviewedTemplate,
} from '../../../core/alerts/templates/alert-templates.js';
import type { RenderedAlert } from '../../../core/ports/alert-channel.js';
import type { AlertRenderer, RenderRequest } from '../../../core/ports/alert-renderer.js';

/** One reviewed template. Synchronous and pure, per the renderer port. */
export type AlertTemplate = (request: RenderRequest) => RenderedAlert;

/**
 * The reviewed corpus (H6): the drafted templates whose copy has all cleared founder
 * review. Empty while any of it is pending — see the module comment.
 */
export const REVIEWED_TEMPLATES: ReadonlyMap<string, AlertTemplate> = new Map(
  [...DRAFT_ALERT_TEMPLATES].filter(([id]) => isReviewedTemplate(id)),
);

export function createTemplateRenderer(
  templates: ReadonlyMap<string, AlertTemplate> = REVIEWED_TEMPLATES,
): AlertRenderer {
  return {
    render(request: RenderRequest): RenderedAlert {
      const template = templates.get(request.templateId);
      if (template === undefined) {
        throw new Error(`no reviewed template registered for ${request.templateId}`);
      }
      return template(request);
    },
  };
}
