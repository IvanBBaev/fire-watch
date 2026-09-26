/**
 * Which attribution conditions are active — attribution follows the data actually drawn
 * (the contracts credits registry), so the credits page must not hardcode "we run on
 * OpenFreeMap"; it asks the same basemap decision the map makes (`core/basemap.ts`).
 */

import { renderMapCornerLine } from '@fire-watch/contracts';
import type { CreditCondition, RenderContext } from '@fire-watch/contracts';
import { activeBasemap } from '../../core/basemap.js';
import type { ClientConfig } from '../../core/config.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { Clock } from '../../core/ports.js';

/** Session state that changes what is on the map without being configuration. */
export interface CreditSessionState {
  /** The Esri imagery layer is drawn (`imageryOn` in `ui/imagery.ts`, TASKS G6). */
  readonly imageryOn?: boolean;
}

/**
 * The credit conditions of what the map draws for this config and session.
 *
 * - The self-hosted outdoor style (complete `outdoorBasemap`) is a Protomaps build, so it
 *   owes `basemap:protomaps` — and never the external style's credits, even though
 *   `basemapStyleUrl` still names it underneath as the fallback. Its Terrarium hillshade
 *   owes `layer:terrain` exactly when a DEM mirror is configured.
 * - Otherwise the external style URLs are drawn; their host names the provider. Both
 *   themes count, because the reader can swap themes without the credits page re-deriving
 *   anything — over-crediting the other theme's provider is the safe direction.
 */
export function activeCreditConditions(
  config: Pick<ClientConfig, 'basemapStyleUrl' | 'outdoorBasemap'>,
  session: CreditSessionState = {},
): readonly CreditCondition[] {
  const conditions: CreditCondition[] = [];
  const basemap = activeBasemap(config.basemapStyleUrl, config.outdoorBasemap);
  if (basemap.kind === 'outdoor') {
    conditions.push('basemap:protomaps');
    if (basemap.terrain) conditions.push('layer:terrain');
  } else {
    const styleUrls = [basemap.styleUrls.light, basemap.styleUrls.dark];
    if (styleUrls.some((url) => url.includes('openfreemap'))) {
      conditions.push('basemap:openfreemap');
    }
    if (styleUrls.some((url) => url.includes('protomaps'))) {
      conditions.push('basemap:protomaps');
    }
  }
  // Imagery is offered and chosen at runtime, so the reader's toggle — not the config —
  // is what makes the Esri credit owed (ADR-001 A1.4).
  if (session.imageryOn === true) conditions.push('toggle:esri');
  return conditions;
}

/**
 * The placeholders every credit surface resolves the same way: the year from the clock,
 * the product name from the catalog. One function so the map corner, `/credits` and About
 * cannot drift apart — and so CI-13 exercises the context the shell really passes.
 */
export function creditRenderContext(
  clock: Pick<Clock, 'epochNow'>,
  messages: Pick<Messages, 'appTitle'>,
): RenderContext {
  return {
    // new Date(ms) is a pure conversion of clock time — no wall-clock read.
    year: new Date(clock.epochNow()).getUTCFullYear(),
    productName: messages.appTitle,
  };
}

/** The map-corner line exactly as the shell hands it to the map controller. */
export function mapCornerAttribution(
  clock: Pick<Clock, 'epochNow'>,
  messages: Pick<Messages, 'appTitle'>,
): string {
  return renderMapCornerLine(creditRenderContext(clock, messages));
}
