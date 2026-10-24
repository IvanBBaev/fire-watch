/**
 * `GET /event/:id` — the app shell with the event's link-preview tags (TASKS V2-D4).
 * Other methods fall through to the static asset handler.
 */

import { handleEventShell } from '../../src/edge/og/og-handlers.js';
import { ogDependencies, param, type OgContext } from '../_shared/og-runtime.js';

export function onRequestGet(context: OgContext): Promise<Response> {
  return handleEventShell(context.request, param(context, 'id'), ogDependencies(context));
}
