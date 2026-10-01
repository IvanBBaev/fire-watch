/**
 * Reads the static hot-source mask asset from disk (TASKS F16).
 *
 * The default is the copy in the repo, `web/src/assets/geodata/static-sources.json` — the
 * same bytes the web app draws and captions — so the scorer's override and the map's
 * caveat can never be about two different snapshots of OpenStreetMap. The path resolves
 * from this module's location, which is the same depth under `server/src/` and
 * `server/dist/`, so it holds for `tsx` and compiled runs alike; a deployment whose image
 * does not carry `web/` sets `FIRE_WATCH_STATIC_SOURCES` instead.
 *
 * A missing or malformed file throws at boot. Silently falling back to "no mask" would
 * turn the §3.6 override off with nothing in any log to say so.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseStaticSourceMask, type StaticSourceMask } from '@fire-watch/contracts';

export const REPO_STATIC_SOURCES_PATH = fileURLToPath(
  new URL('../../../../web/src/assets/geodata/static-sources.json', import.meta.url),
);

export function loadStaticSourceMask(path: string | null): StaticSourceMask {
  const file = path ?? REPO_STATIC_SOURCES_PATH;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(
      `static hot-source mask not readable at ${file} (set FIRE_WATCH_STATIC_SOURCES): ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  return parseStaticSourceMask(JSON.parse(text) as unknown);
}
