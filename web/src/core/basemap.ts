/**
 * Which basemap is drawn — the one decision the map and the credits both read.
 *
 * The map loads either the self-hosted outdoor style (TASKS G3, built by
 * `map/outdoor-style.ts`) or the external style URL for the theme, and the outdoor style
 * carries a Terrarium hillshade only when a DEM mirror is configured. Attribution follows
 * the data actually drawn (ADR-001 A1.4), so the credit surfaces must not guess this from
 * the config independently of the map: `resolveBasemapStyle` and `activeCreditConditions`
 * both call {@link activeBasemap}, and a config that makes one of them switch styles makes
 * the other switch credits in the same breath.
 *
 * Pure and framework-free: the credits page and About read it from the entry chunk
 * without pulling in the lazy map chunk.
 */

import type { OutdoorBasemapConfig, ThemeName } from './types.js';

/** A complete set of outdoor-style inputs — what {@link outdoorConfigProblem} vouches for. */
export interface OutdoorStyleInputs {
  readonly tilesUrl: string;
  readonly glyphsUrl: string;
  readonly demTilesUrl: string | null;
  readonly maxzoom: number;
}

/** What the map draws as its basemap. */
export type ActiveBasemap =
  | {
      /** The self-hosted outdoor style (a Protomaps-schema build of OSM data). */
      readonly kind: 'outdoor';
      readonly inputs: OutdoorStyleInputs;
      /** The Terrarium hillshade layer is part of the style. */
      readonly terrain: boolean;
    }
  | {
      /** The external style document at `styleUrls[theme]`. */
      readonly kind: 'external';
      readonly styleUrls: Readonly<Record<ThemeName, string>>;
    };

const ABSOLUTE_URL = /^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/)/u;

function templateProblem(
  name: string,
  url: string,
  placeholders: readonly string[],
): string | null {
  if (!ABSOLUTE_URL.test(url)) return `${name} must be an https URL (or http on localhost)`;
  const missing = placeholders.filter((placeholder) => !url.includes(placeholder));
  return missing.length === 0 ? null : `${name} lacks ${missing.join(', ')}`;
}

/**
 * Why this config cannot build the outdoor style, or `null` when it can. "Not deployed"
 * (either required URL `null`) is a reason too — the caller falls back either way; the
 * difference only matters to the test that pins the default config as intentionally unset.
 */
export function outdoorConfigProblem(
  config: OutdoorBasemapConfig | null | undefined,
): string | null {
  if (config === null || config === undefined) return 'not configured';
  if (config.tilesUrl === null || config.glyphsUrl === null) return 'not deployed';
  const problems = [
    templateProblem('tilesUrl', config.tilesUrl, ['{z}', '{x}', '{y}']),
    templateProblem('glyphsUrl', config.glyphsUrl, ['{fontstack}', '{range}']),
    config.demTilesUrl === null
      ? null
      : templateProblem('demTilesUrl', config.demTilesUrl, ['{z}', '{x}', '{y}']),
    Number.isInteger(config.maxzoom) && config.maxzoom >= 0 && config.maxzoom <= 14
      ? null
      : 'maxzoom must be an integer in 0–14 (ADR-001 A1.1)',
  ].filter((problem): problem is string => problem !== null);
  return problems.length === 0 ? null : problems.join('; ');
}

/**
 * The basemap the map draws: the outdoor style when its config is complete and
 * well-formed, otherwise the external style URLs — a malformed config is a deploy mistake,
 * and a blank map is a worse answer to it than the old basemap.
 */
export function activeBasemap(
  styleUrls: Readonly<Record<ThemeName, string>>,
  outdoor: OutdoorBasemapConfig | null | undefined,
): ActiveBasemap {
  if (outdoor === null || outdoor === undefined || outdoorConfigProblem(outdoor) !== null) {
    return { kind: 'external', styleUrls };
  }
  const { tilesUrl, glyphsUrl, demTilesUrl, maxzoom } = outdoor;
  if (tilesUrl === null || glyphsUrl === null) return { kind: 'external', styleUrls };
  return {
    kind: 'outdoor',
    inputs: { tilesUrl, glyphsUrl, demTilesUrl, maxzoom },
    terrain: demTilesUrl !== null,
  };
}
