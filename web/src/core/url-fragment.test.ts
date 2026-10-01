import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  readFragmentMember,
  withFragmentMembers,
  withMissingFragmentMembers,
} from './url-fragment.js';

describe('readFragmentMember', () => {
  it('reads a member with or without the leading #', () => {
    expect(readFragmentMember('#map=7/42/25&t=6h', 't')).toBe('6h');
    expect(readFragmentMember('map=7/42/25&t=6h', 'map')).toBe('7/42/25');
    expect(readFragmentMember('#map=7/42/25', 't')).toBeNull();
    expect(readFragmentMember('', 't')).toBeNull();
    // A key is matched whole: `src=` is not `r=`.
    expect(readFragmentMember('#src=v', 'r')).toBeNull();
  });
});

describe('withFragmentMembers', () => {
  it('replaces in place, appends new members and keeps the rest in order', () => {
    expect(withFragmentMembers('#map=7/42/25&token=abc', { t: '6h' })).toBe(
      '#map=7/42/25&token=abc&t=6h',
    );
    expect(withFragmentMembers('#t=6h&map=7/42/25', { t: '1h' })).toBe('#t=1h&map=7/42/25');
    expect(withFragmentMembers('#x=1&future=yes', { t: null })).toBe('#x=1&future=yes');
  });

  it('removes members set to null and collapses duplicates', () => {
    expect(withFragmentMembers('#t=6h&map=7/42/25', { t: null })).toBe('#map=7/42/25');
    expect(withFragmentMembers('#t=6h&t=1h', { t: '3h' })).toBe('#t=3h');
    expect(withFragmentMembers('#t=6h', { t: null })).toBe('');
  });
});

describe('withMissingFragmentMembers', () => {
  it('fills a fragment a route change emptied', () => {
    expect(withMissingFragmentMembers('', { map: '7.0/42.7/25.3', t: '6h', r: null })).toBe(
      '#map=7.0/42.7/25.3&t=6h',
    );
  });

  it('never overwrites a member that is present, and adds nothing for null', () => {
    expect(withMissingFragmentMembers('#t=1h&token=abc', { t: '6h', src: 'v' })).toBe(
      '#t=1h&token=abc&src=v',
    );
    expect(withMissingFragmentMembers('#map=7/42/25', { map: '9/1/1', t: null })).toBe(
      '#map=7/42/25',
    );
    expect(withMissingFragmentMembers('', { t: null })).toBe('');
  });

  const key = fc.constantFrom('map', 't', 'src', 'r', 'ov', 'token');
  const value = fc.stringMatching(/^[a-z0-9./,-]{1,8}$/);
  const members = fc.dictionary(key, fc.option(value, { nil: null }));

  it('round-trips: every non-null member reads back, and present ones are untouched', () => {
    fc.assert(
      fc.property(members, members, (before, fill) => {
        const hash = withFragmentMembers('', before);
        const out = withMissingFragmentMembers(hash, fill);
        for (const [k, v] of Object.entries(before)) {
          if (v !== null) expect(readFragmentMember(out, k)).toBe(v);
        }
        for (const [k, v] of Object.entries(fill)) {
          if (v !== null && readFragmentMember(hash, k) === null) {
            expect(readFragmentMember(out, k)).toBe(v);
          }
        }
        // Idempotent: a second repair finds nothing missing.
        expect(withMissingFragmentMembers(out, fill)).toBe(out);
      }),
    );
  });
});
