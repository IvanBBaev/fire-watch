/**
 * Which surfaces a route wants on screen.
 *
 * The map is not a page. It is a long-lived instance that costs a chunk download, a style
 * fetch and a WebGL context to create, and it holds the user's frame — so the shell mounts
 * it once and routes render *beside* it. Opening `/event/:id` must therefore keep the map
 * exactly where it was, showing the fire in context, rather than swapping it for a text
 * page (the map is the answer to "where is it?", and a detail page without one is a fact
 * sheet about somewhere unknown).
 *
 * Pure string logic, kept out of the components so the routing rules are testable without
 * a renderer.
 */

import { ROUTES } from './routes.js';

/**
 * Routes that are documents, not situational awareness — they get the full width.
 *
 * Read off the route table rather than listed again here: a second copy of the route list
 * is a copy that stops agreeing with the first, and the page added tomorrow would render
 * with the map beside it because someone edited `ui/app.tsx` and not this file. Declaring
 * the surface is now part of declaring the route (`routes.ts`).
 */
const PANEL_ONLY_ROUTES: ReadonlySet<string> = new Set(
  ROUTES.filter((route) => route.surface === 'panel').map((route) => route.path),
);

const EVENT_PATH_PREFIX = '/event/';

/**
 * Should this route show the map? Unknown paths do, matching the router's own fail-open
 * default onto Home: an unrecognised link is more likely a stale event permalink than a
 * request for a settings page.
 */
export function isMapRoute(path: string): boolean {
  return !PANEL_ONLY_ROUTES.has(normalize(path));
}

/**
 * The event a route selects on the map, or `null`. Selection follows the URL rather than a
 * click handler, so a pasted permalink highlights the same fire a tap does.
 */
export function selectedEventIdFrom(path: string): string | null {
  const normalized = normalize(path);
  if (!normalized.startsWith(EVENT_PATH_PREFIX)) return null;
  const id = normalized.slice(EVENT_PATH_PREFIX.length);
  // A nested segment is not an event id; `/event/` alone selects nothing.
  if (id === '' || id.includes('/')) return null;
  return decodeURIComponent(id);
}

/** Trailing slashes are the same place; `/settings/` must not become a map route. */
function normalize(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
