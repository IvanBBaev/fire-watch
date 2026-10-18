/**
 * The route table is data every consumer resolves; these pin the invariants the
 * Record<RouteId, …> maps cannot express.
 */

import { describe, expect, it } from 'vitest';

import { ROUTES } from './routes.js';

describe('ROUTES', () => {
  it('has unique ids and unique paths', () => {
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(ROUTES.length);
  });

  it('uses absolute paths', () => {
    for (const route of ROUTES) expect(route.path.startsWith('/')).toBe(true);
  });

  it('keeps Home first, since the router takes the first match', () => {
    expect(ROUTES[0]).toMatchObject({ id: 'home', path: '/', surface: 'map' });
  });

  it('gives only situational-awareness routes the map', () => {
    const mapRoutes = ROUTES.filter((r) => r.surface === 'map').map((r) => r.id);
    expect(mapRoutes).toEqual(['home', 'event']);
  });

  it('lists the sign-in landing route', () => {
    expect(ROUTES.map((r) => r.path)).toContain('/sign-in/continue');
  });

  it('only uses the two known surfaces', () => {
    for (const route of ROUTES) expect(['map', 'panel']).toContain(route.surface);
  });
});
