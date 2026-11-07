import { describe, expect, it } from 'vitest';

import { deployDataProblem, readDataSource } from './data-source.js';

describe('readDataSource', () => {
  it('is live only on an explicit live', () => {
    expect(readDataSource('live')).toBe('live');
    expect(readDataSource(' LIVE ')).toBe('live');
    expect(readDataSource(undefined)).toBe('fixtures');
    expect(readDataSource('')).toBe('fixtures');
    expect(readDataSource('liv')).toBe('fixtures');
  });
});

describe('deployDataProblem (FD-5)', () => {
  it('refuses a production build on fixtures', () => {
    expect(deployDataProblem('production', 'fixtures')).toMatch(/never serves fixtures/u);
    expect(deployDataProblem(' Production ', 'fixtures')).not.toBeNull();
  });

  it('lets a production build on live data through', () => {
    expect(deployDataProblem('production', 'live')).toBeNull();
  });

  it('lets every other environment serve fixtures, behind the demo-data notice', () => {
    expect(deployDataProblem(undefined, 'fixtures')).toBeNull();
    expect(deployDataProblem('', 'fixtures')).toBeNull();
    expect(deployDataProblem('staging', 'fixtures')).toBeNull();
    expect(deployDataProblem('preview', 'fixtures')).toBeNull();
  });
});
