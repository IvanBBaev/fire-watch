import { describe, expect, it } from 'vitest';

import { markOf, objectAgeSeconds } from './driver.js';

describe('driver helpers', () => {
  it('reads the cursor mark from the snapshot ETag', () => {
    expect(markOf('"v1-4211"')).toBe(4211);
    expect(markOf('W/"v1-0"')).toBe(0);
    expect(markOf('"opaque"')).toBeNull();
  });

  it('ages a T2 object by its own generation stamp, falling back to Last-Modified', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(
      objectAgeSeconds(new Headers({ 'x-amz-meta-generated-at': '2026-09-24T11:58:00Z' }), now),
    ).toBe(120);
    expect(
      objectAgeSeconds(new Headers({ 'last-modified': 'Thu, 24 Sep 2026 11:59:00 GMT' }), now),
    ).toBe(60);
    expect(
      objectAgeSeconds(new Headers({ 'x-amz-meta-generated-at': '2026-09-24T12:00:05Z' }), now),
    ).toBe(0);
    expect(objectAgeSeconds(new Headers(), now)).toBeNull();
    expect(objectAgeSeconds(new Headers({ 'last-modified': 'garbage' }), now)).toBeNull();
  });
});
