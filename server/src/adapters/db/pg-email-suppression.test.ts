import { describe, expect, it } from 'vitest';

import {
  EMAIL_SUPPRESSION_SQL,
  createPgEmailSuppression,
  type PgEmailSuppressionQueryable,
} from './pg-email-suppression.js';

const AT = Date.parse('2026-10-13T09:00:00Z');

function stubDb(rowCount: number | null): PgEmailSuppressionQueryable & {
  readonly calls: { text: string; values: readonly unknown[] }[];
} {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  return {
    calls,
    query: (text, values = []) => {
      calls.push({ text, values });
      return Promise.resolve({ rowCount });
    },
  };
}

describe('the email suppression statement', () => {
  it('touches only live email rows, by exact endpoint', () => {
    const sql = EMAIL_SUPPRESSION_SQL.suppress.replace(/\s+/gu, ' ');
    expect(sql).toContain("channel = 'email'");
    expect(sql).toContain('endpoint = $1');
    expect(sql).toContain('revoked_at IS NULL');
    expect(sql).not.toMatch(/lower\(/iu);
  });

  it('passes the address and the instant, and returns the count', async () => {
    const db = stubDb(2);
    expect(await createPgEmailSuppression(db).suppress('jane@example.com', AT)).toBe(2);
    expect(db.calls).toEqual([
      {
        text: EMAIL_SUPPRESSION_SQL.suppress,
        values: ['jane@example.com', '2026-10-13T09:00:00.000Z'],
      },
    ]);
  });

  it('a null rowCount reads as nothing revoked', async () => {
    expect(await createPgEmailSuppression(stubDb(null)).suppress('a@example.com', AT)).toBe(0);
  });

  it.each([
    ['an empty address', '', AT],
    ['a non-finite instant', 'a@example.com', Number.NaN],
  ])('refuses %s without a query', async (_name, address, at) => {
    const db = stubDb(0);
    await expect(createPgEmailSuppression(db).suppress(address, at)).rejects.toThrow(TypeError);
    expect(db.calls).toEqual([]);
  });
});
