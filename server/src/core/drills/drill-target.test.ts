import { describe, expect, it } from 'vitest';

import { assessDrillTarget, tokensOf } from './drill-target.js';

describe('assessDrillTarget', () => {
  it('accepts a database named as staging, and describes it without credentials', () => {
    const result = assessDrillTarget({
      databaseUrl: 'postgres://app:s3cret@db.staging.internal:5432/fire_watch',
    });
    expect(result.ok).toBe(true);
    expect(result.described).toEqual({
      database_host: 'db.staging.internal',
      database_name: 'fire_watch',
    });
    expect(JSON.stringify(result)).not.toContain('s3cret');
  });

  it("refuses production's own shape: fire_watch on localhost", () => {
    const result = assessDrillTarget({ databaseUrl: 'postgres://app:x@localhost:5432/fire_watch' });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/non-production marker/);
  });

  it('refuses a production marker even beside a non-production one', () => {
    const result = assessDrillTarget({ databaseUrl: 'postgres://a@prod-db/fire_watch_test' });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/production marker \(prod\)/);
  });

  it('matches markers as words, not substrings', () => {
    expect(assessDrillTarget({ databaseName: 'protest' }).ok).toBe(false);
    expect(assessDrillTarget({ databaseName: 'products_drill' }).ok).toBe(true);
    expect(tokensOf('fw-Drill_2026.x')).toEqual(['fw', 'drill', '2026', 'x']);
  });

  it('takes the bucket and PGDATABASE into account together', () => {
    expect(assessDrillTarget({ databaseName: 'fire_watch', bucket: 'fire-watch-staging' }).ok).toBe(
      true,
    );
    expect(assessDrillTarget({ databaseName: 'fire_watch', bucket: 'fire-watch-live' }).ok).toBe(
      false,
    );
  });

  it('refuses a malformed URL and an empty input', () => {
    expect(assessDrillTarget({ databaseUrl: 'not a url' }).problems).toContain(
      'DATABASE_URL is not a URL',
    );
    expect(assessDrillTarget({}).problems).toEqual(['no database or bucket to assess']);
  });
});
