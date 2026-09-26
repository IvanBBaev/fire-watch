/**
 * Every route this build serves, as data — the one list the shell, the layout rule and the
 * accessibility gate all read.
 *
 * It used to be written out three times: the `<Route>` elements in `ui/app.tsx`, the set of
 * paths that suppress the map in `ui/logic/layout.ts`, and the surfaces CI-18's sweep walks
 * in `e2e/a11y.e2e.ts`. Nothing compared them. A page added to the first and forgotten in
 * the second renders with the map beside a document; forgotten in the third it escapes the
 * accessibility floors entirely, and *that* failure is silent — the gate stays green while
 * covering less. `core/i18n/catalog-render.ts` makes the same argument about a hand-written
 * list of message keys, and this is the same answer in the routing layer: hold the list as
 * data, and make every consumer resolve it through a `Record<RouteId, …>` so the compiler
 * asks for the missing piece instead of a reviewer having to notice its absence.
 *
 * {@link RouteId} is *derived from* the table rather than declared beside it, so adding a
 * row is what widens the union: the new id is then missing from the page map in `ui/app.tsx`
 * and from the readiness selectors in `e2e/a11y.e2e.ts`, and both are compile errors until
 * someone answers them. A route cannot reach the build without saying what renders it, and
 * cannot reach the build without telling CI-18 how to know it has rendered.
 *
 * Renderer-free on purpose. `ui/logic/layout.ts` imports this module and is covered by pure
 * unit tests that run with no DOM and no framework, so nothing here may reach for Preact,
 * the router or the map.
 */

/**
 * What a route wants beside it.
 *
 * `'map'` keeps the shell's single long-lived MapLibre instance mounted and renders the
 * route into the panel next to it; `'panel'` is a document — situational awareness is not
 * what it is for, so it takes the full width. `ui/logic/layout.ts` applies the decision.
 */
export type RouteSurface = 'map' | 'panel';

/** The shape of a row. {@link AppRoute} is this with its id narrowed to the table's own. */
interface RouteSpec {
  readonly id: string;
  /** The preact-iso pattern, `:param` segments and all. */
  readonly path: string;
  readonly surface: RouteSurface;
}

/**
 * The routes, in the order the router matches them — preact-iso takes the first match, so
 * this order is behaviour rather than presentation. There is no `/zones` until v1, and no
 * row for the fallback: unknown paths are not a route, they fail open onto Home and onto
 * the map (see `ui/app.tsx` and `isMapRoute` in `ui/logic/layout.ts`).
 */
const ROUTE_TABLE = [
  { id: 'home', path: '/', surface: 'map' },
  { id: 'event', path: '/event/:id', surface: 'map' },
  { id: 'settings', path: '/settings', surface: 'panel' },
  { id: 'about', path: '/about', surface: 'panel' },
  { id: 'credits', path: '/credits', surface: 'panel' },
  { id: 'privacy', path: '/privacy', surface: 'panel' },
  // TASKS I1 — sign-in. Rendered by lazy pages (one chunk, CI-12 role `page`); with auth
  // off server-side both render a neutral "not available" line and nothing links to them.
  // `/sign-in/continue` is where boot moves a link's `#token=` (`core/auth/sign-in.ts`).
  { id: 'signIn', path: '/sign-in', surface: 'panel' },
  { id: 'signInContinue', path: '/sign-in/continue', surface: 'panel' },
] as const satisfies readonly RouteSpec[];

/**
 * The id of a route this build serves. Read off the table above, which is what makes every
 * `Record<RouteId, …>` in the codebase a list that cannot fall behind it.
 */
export type RouteId = (typeof ROUTE_TABLE)[number]['id'];

/** One row of the route table. */
export interface AppRoute extends RouteSpec {
  readonly id: RouteId;
}

/** The route table, in router-match order. */
export const ROUTES: readonly AppRoute[] = ROUTE_TABLE;
