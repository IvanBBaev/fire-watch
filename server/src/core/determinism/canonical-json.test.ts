import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('is insensitive to key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested keys too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('refuses values that cannot round-trip', () => {
    expect(() => canonicalJson({ eps: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ eps: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('drops undefined members rather than digesting them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('does not confuse an absent member with a null one', () => {
    expect(canonicalJson({ a: 1, b: undefined })).not.toBe(canonicalJson({ a: 1, b: null }));
  });
});
