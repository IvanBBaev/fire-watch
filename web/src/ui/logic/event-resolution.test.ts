import { describe, expect, it } from 'vitest';

import { eventPath, redirectTargetFor } from './event-resolution.js';

describe('eventPath', () => {
  it('builds the canonical event route', () => {
    expect(eventPath('fw-2026-q7f3d')).toBe('/event/fw-2026-q7f3d');
  });
});

describe('redirectTargetFor', () => {
  it('stays put when the id resolves to itself', () => {
    expect(redirectTargetFor('fw-2026-q7f3d', 'fw-2026-q7f3d')).toBeNull();
  });

  it('stays put when nothing resolved (unknown id renders not-found, no redirect)', () => {
    expect(redirectTargetFor('fw-2026-nope0', null)).toBeNull();
  });

  it('redirects a merged tombstone to the survivor path', () => {
    // Fixture: fw-2026-z7c3f was merged into fw-2026-q7f3d.
    expect(redirectTargetFor('fw-2026-z7c3f', 'fw-2026-q7f3d')).toBe('/event/fw-2026-q7f3d');
  });
});
