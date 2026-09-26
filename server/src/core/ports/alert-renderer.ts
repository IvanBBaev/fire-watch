/**
 * Copy production — ADR-004 D1, D7.
 *
 * The outbox stores `template_id` plus bound `template_params` and **never a rendered
 * body** (A1.3: pseudonymization has to be able to drop the zone-derived parameters and
 * keep the rest, which it cannot do to prose). Rendering therefore happens at dispatch,
 * which is what makes this a port: the gateway must be able to turn a row into words
 * without the template corpus being compiled into it, and H6 supplies the corpus.
 *
 * Rendering is synchronous and pure by contract. A renderer that could await would be a
 * renderer that could fetch, and copy fetched at dispatch time is copy that never passed
 * D7's CI lint.
 */

import type { RenderedAlert } from './alert-channel.js';
import type { AlertChannel } from './alert-outbox-store.js';

export interface RenderRequest {
  /** The exact reviewed template the decision chose. */
  readonly templateId: string;
  readonly templateParams: Readonly<Record<string, unknown>>;
  /**
   * Channels are not interchangeable surfaces: a push title has a few dozen characters,
   * an email has a subject line, Telegram has its own markup. Same template, different
   * rendering.
   */
  readonly channel: AlertChannel;
  /** BCP-47. The product ships Bulgarian first; A6 adds the neighbours. */
  readonly locale: string;
  /** IANA zone — every timestamp in the copy is the recipient's local time, not ours. */
  readonly timeZone: string;
}

export interface AlertRenderer {
  render(request: RenderRequest): RenderedAlert;
}
