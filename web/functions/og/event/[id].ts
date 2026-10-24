/**
 * `GET|HEAD /og/event/:id.png` — the event's share card as a PNG (TASKS V2-D4). The route
 * parameter is the whole last segment, `.png` included; the handler checks and strips it.
 */

import { handleEventImage } from '../../../src/edge/og/og-handlers.js';
import { ogDependencies, param, type OgContext } from '../../_shared/og-runtime.js';

export function onRequest(context: OgContext): Promise<Response> {
  return handleEventImage(context.request, param(context, 'id'), ogDependencies(context));
}
