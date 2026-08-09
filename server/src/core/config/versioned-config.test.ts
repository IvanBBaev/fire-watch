import { describe, expect, it } from 'vitest';

import { configDigest, defineConfig } from './versioned-config.js';

describe('configDigest', () => {
  it('changes when any value changes', () => {
    expect(configDigest({ epsKm: 1.0 })).not.toBe(configDigest({ epsKm: 1.5 }));
  });

  it('does not change when only key order changes', () => {
    expect(configDigest({ epsKm: 1.0, tLinkHours: 36 })).toBe(
      configDigest({ tLinkHours: 36, epsKm: 1.0 }),
    );
  });
});

describe('defineConfig', () => {
  it('carries a digest of its values', () => {
    const config = defineConfig('clustering', 'clustering_params_v1', { epsKm: 1.25 });
    expect(config.version).toBe('clustering_params_v1');
    expect(config.digest).toBe(configDigest({ epsKm: 1.25 }));
    expect(config.values.epsKm).toBe(1.25);
  });

  it('rejects a version string that is not a version', () => {
    expect(() => defineConfig('clustering', 'latest', {})).toThrow(RangeError);
    expect(() => defineConfig('clustering', 'clustering_params', {})).toThrow(RangeError);
  });
});
