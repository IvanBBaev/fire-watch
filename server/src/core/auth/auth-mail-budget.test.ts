import { describe, expect, it } from 'vitest';

import { AUTH_MAIL_BUDGET, budgetClientKey, createAuthMailBudget } from './auth-mail-budget.js';

const T0 = Date.parse('2026-11-07T10:00:00Z');
const HOUR = 3_600_000;

describe('AUTH_MAIL_BUDGET', () => {
  it('holds review 28 Q3 numbers: 10 per client, 200 global, per hour, warn at half', () => {
    expect(AUTH_MAIL_BUDGET).toEqual({
      perClientPerWindow: 10,
      globalPerWindow: 200,
      windowMs: HOUR,
      warnFraction: 0.5,
    });
  });
});

describe('createAuthMailBudget', () => {
  it('admits ten links from one client in an hour and holds back the eleventh', () => {
    const budget = createAuthMailBudget();
    const answers = Array.from({ length: 11 }, () => budget.admit('203.0.113.7', T0));
    expect(answers.slice(0, 10)).toEqual(Array<string>(10).fill('send'));
    expect(answers[10]).toBe('over_client');
    expect(budget.admit('203.0.113.8', T0)).toBe('send');
  });

  it('admits the client again once its window has passed', () => {
    const budget = createAuthMailBudget();
    for (let i = 0; i < 10; i += 1) budget.admit('203.0.113.7', T0);
    expect(budget.admit('203.0.113.7', T0 + HOUR - 1)).toBe('over_client');
    expect(budget.admit('203.0.113.7', T0 + HOUR)).toBe('send');
  });

  it('holds back the (N+1)th link globally, however many clients share it', () => {
    const budget = createAuthMailBudget();
    for (let i = 0; i < 200; i += 1) {
      expect(budget.admit(`198.51.${Math.floor(i / 10)}.${i % 10}`, T0)).toBe('send');
    }
    expect(budget.admit('192.0.2.1', T0)).toBe('over_global');
    expect(budget.admit('192.0.2.1', T0 + HOUR)).toBe('send');
  });

  it('does not charge the global budget for a request the per-client cap refused', () => {
    const budget = createAuthMailBudget({ perClientPerWindow: 1, globalPerWindow: 2 });
    expect(budget.admit('a', T0)).toBe('send');
    expect(budget.admit('a', T0)).toBe('over_client');
    expect(budget.admit('a', T0)).toBe('over_client');
    expect(budget.admit('b', T0)).toBe('send');
    expect(budget.admit('c', T0)).toBe('over_global');
  });

  it('keys one IPv6 /64 as one client', () => {
    const budget = createAuthMailBudget({ perClientPerWindow: 2 });
    expect(budget.admit('2001:db8:1:2::1', T0)).toBe('send');
    expect(budget.admit('2001:db8:1:2:ffff:0:0:9', T0)).toBe('send');
    expect(budget.admit('2001:0db8:0001:0002::abcd', T0)).toBe('over_client');
    expect(budget.admit('2001:db8:1:3::1', T0)).toBe('send');
  });

  it('reads the spent share and the held-back counts, the share resetting with the window', () => {
    const budget = createAuthMailBudget({ perClientPerWindow: 1, globalPerWindow: 4 });
    expect(budget.reading(T0)).toEqual({
      globalUsed: 0,
      globalLimit: 4,
      suppressed: { over_client: 0, over_global: 0 },
    });
    budget.admit('a', T0);
    budget.admit('a', T0);
    budget.admit('b', T0);
    expect(budget.reading(T0)).toEqual({
      globalUsed: 2,
      globalLimit: 4,
      suppressed: { over_client: 1, over_global: 0 },
    });
    expect(budget.reading(T0 + HOUR).globalUsed).toBe(0);
    expect(budget.reading(T0 + HOUR).suppressed.over_client).toBe(1);
  });

  it('refuses a global budget that is not a positive integer', () => {
    expect(() => createAuthMailBudget({ globalPerWindow: 0 })).toThrow(RangeError);
    expect(() => createAuthMailBudget({ globalPerWindow: 1.5 })).toThrow(RangeError);
  });
});

describe('budgetClientKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:0003:0004:0005:0006', '2001:db8:1:2::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8::1::2', '2001:db8::1::2'],
    ['not-an-address', 'not-an-address'],
    ['zz::1', 'zz::1'],
  ])('%s → %s', (input, expected) => {
    expect(budgetClientKey(input)).toBe(expected);
  });
});
