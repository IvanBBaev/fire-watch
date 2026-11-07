/**
 * The route table as surfaces a browser gate visits (TASKS CI-18, R5-SEC-2).
 *
 * Two suites sweep every route of `ui/logic/routes.ts`: the layout floors (`a11y.e2e.ts`)
 * and the security headers (`security-headers.e2e.ts`). Both need the same two answers for
 * every route — which URL(s) to visit, and what "rendered" looks like there — and both must
 * fail to compile when a route is added and neither answer is given. This module holds
 * those answers once, keyed by `RouteId`, so a new route is one edit here and covered by
 * every sweep at once.
 */

import { eventPath } from '../../src/ui/logic/event-resolution.js';
import type { AppRoute, RouteId } from '../../src/ui/logic/routes.js';
import { ROUTES } from '../../src/ui/logic/routes.js';

/** The fixture event `polling-only.e2e.ts` also navigates to. */
export const EVENT_ID = 'fw-2026-q7f3d';

/** Well-formed and absent from the fixture, so the not-found branch renders. */
export const MISSING_EVENT_ID = 'fw-2026-zzzz9';

export const ROW_SELECTOR = '.home-list a.event-row';
export const EVENT_PAGE_SELECTOR = 'article.page.event-page';

/**
 * How a sweep knows a route has finished rendering — one selector per route, exhaustive
 * over `RouteId`.
 *
 * This is the half of the gate that used to be a hand-written list. A route added to
 * `ui/logic/routes.ts` and forgotten here would not have failed anything: the sweep would
 * simply have stopped covering the newest surface while staying green, which is the worst
 * shape a gate can fail in. Now it is a compile error in this file until someone says what
 * "rendered" looks like on the new page.
 */
export const READY_SELECTOR: Record<RouteId, string> = {
  home: ROW_SELECTOR,
  // Not the loading state a cold permalink open shows before its first snapshot (TASKS F3):
  // the sweep measures the page with its event on it.
  event: `${EVENT_PAGE_SELECTOR}:not([data-state="loading"])`,
  settings: '.settings-group',
  about: '#data-freshness',
  credits: '.credits-list',
  privacy: '#disclaimer',
  accessibility: '#accessibility-contact',
  // TASKS I1. The harness origin serves no auth routes, so both pages settle on their
  // neutral "not available" line — the state a deployment with auth off shows.
  signIn: '.auth-page[data-ready]',
  signInContinue: '.auth-page[data-ready]',
  staffCuration: '.staff-curation[data-ready]',
};

/** One URL a sweep visits, under the name its findings are reported against. */
export interface Visit {
  readonly name: string;
  readonly path: string;
}

/**
 * The URLs each route is swept at, and what to call them.
 *
 * A static path is swept at itself, taken from the route table rather than written out a
 * second time. `/event/:id` is a pattern and not a URL, so it names the two ids the sweeps
 * have always visited: one the fixture contains and one it does not, which renders the
 * not-found branch on the same route. Exhaustive over `RouteId` as well, so a
 * parameterised route cannot be added to the table and then swept at a literal `:param`.
 */
const SWEEP_VISITS: Record<RouteId, (route: AppRoute) => readonly Visit[]> = {
  home: (route) => [{ name: 'home list', path: route.path }],
  event: () => [
    { name: 'event page', path: eventPath(EVENT_ID) },
    { name: 'event not found', path: eventPath(MISSING_EVENT_ID) },
  ],
  settings: (route) => [{ name: 'settings', path: route.path }],
  about: (route) => [{ name: 'about', path: route.path }],
  credits: (route) => [{ name: 'credits', path: route.path }],
  privacy: (route) => [{ name: 'privacy', path: route.path }],
  accessibility: (route) => [{ name: 'accessibility statement', path: route.path }],
  signIn: (route) => [{ name: 'sign in', path: route.path }],
  signInContinue: (route) => [{ name: 'sign-in landing', path: route.path }],
  staffCuration: (route) => [{ name: 'staff curation', path: route.path }],
};

/** A visit with the selector that says its route has rendered. */
export interface RouteSurface extends Visit {
  readonly ready: string;
}

/**
 * Every surface of review 19 Appendix A a build can reach without an account: the list, an
 * event, the not-found branch that shares its route, and the static pages — in the route
 * table's own order.
 */
export const ROUTE_SURFACES: readonly RouteSurface[] = ROUTES.flatMap((route) =>
  SWEEP_VISITS[route.id](route).map((visit) => ({ ...visit, ready: READY_SELECTOR[route.id] })),
);
