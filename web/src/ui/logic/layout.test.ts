import { describe, expect, it } from 'vitest';

import { isMapRoute, selectedEventIdFrom } from './layout.js';
import { ROUTES } from './routes.js';

describe('isMapRoute', () => {
  it('keeps the map on home and on an event permalink', () => {
    expect(isMapRoute('/')).toBe(true);
    expect(isMapRoute('/event/fw-2026-q7f3d')).toBe(true);
  });

  it('drops the map on the document routes', () => {
    expect(isMapRoute('/settings')).toBe(false);
    expect(isMapRoute('/about')).toBe(false);
    expect(isMapRoute('/credits')).toBe(false);
    expect(isMapRoute('/privacy')).toBe(false);
  });

  it('treats a trailing slash as the same route', () => {
    expect(isMapRoute('/settings/')).toBe(false);
    expect(isMapRoute('/')).toBe(true);
  });

  it('fails open onto the map for an unknown path, like the router does', () => {
    expect(isMapRoute('/zones')).toBe(true);
    expect(isMapRoute('/whatever')).toBe(true);
  });

  // `isMapRoute` decides by literal path, so a panel route whose pattern carries a
  // `:param` would be declared a document in the route table and still render with the map
  // beside it — `/education/wildfire-basics` is not the string `/education/:topic`. The
  // trap is latent today because every panel route is static, and a latent trap is exactly
  // the kind that is sprung by someone who never read this file. Asserted here rather than
  // worked around in `isMapRoute`, because matching patterns is a behaviour change to the
  // fail-open default and that default is deliberate: this says the table may not declare
  // something the layout cannot honour. If a parameterised document route is ever wanted,
  // teach `isMapRoute` to match patterns in the same change — do not delete this test.
  it('has no parameterised panel route, which it could not honour', () => {
    const parameterised = ROUTES.filter(
      (route) => route.surface === 'panel' && route.path.includes(':'),
    ).map((route) => route.path);
    expect(parameterised).toEqual([]);
  });
});

describe('selectedEventIdFrom', () => {
  it('reads the public id out of a permalink', () => {
    expect(selectedEventIdFrom('/event/fw-2026-q7f3d')).toBe('fw-2026-q7f3d');
  });

  it('tolerates a trailing slash', () => {
    expect(selectedEventIdFrom('/event/fw-2026-q7f3d/')).toBe('fw-2026-q7f3d');
  });

  it('decodes a percent-encoded id rather than selecting a literal escape', () => {
    expect(selectedEventIdFrom('/event/fw-2026-q7f3d%2Fx')).toBe('fw-2026-q7f3d/x');
  });

  it('selects nothing off the event route', () => {
    expect(selectedEventIdFrom('/')).toBeNull();
    expect(selectedEventIdFrom('/settings')).toBeNull();
    expect(selectedEventIdFrom('/events/fw-2026-q7f3d')).toBeNull();
  });

  it('selects nothing for a bare or nested event path', () => {
    expect(selectedEventIdFrom('/event/')).toBeNull();
    expect(selectedEventIdFrom('/event/fw-2026-q7f3d/detections')).toBeNull();
  });
});
