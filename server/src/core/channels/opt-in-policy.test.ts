import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import {
  CHANNEL_OPT_IN_POLICY,
  confirmationState,
  decideConfirmationIssue,
  evaluateConfirmation,
  isChannelArmed,
  isSubscriptionDispatchable,
  type ConfirmationRecord,
} from './opt-in-policy.js';

const AT = epochMsFromIso('2026-09-23T08:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function record(overrides: Partial<ConfirmationRecord> = {}): ConfirmationRecord {
  return {
    channel: 'email',
    expiresAt: AT + HOUR,
    consumedAt: null,
    supersededAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('CHANNEL_OPT_IN_POLICY', () => {
  it('states the email numbers from 05 §5.5.3 and leaves Telegram and push unarmed', () => {
    expect(CHANNEL_OPT_IN_POLICY.email).toEqual({
      pendingTtlMs: 48 * HOUR,
      issuesPerWindow: 3,
      issueWindowMs: DAY,
    });
    expect(isChannelArmed(CHANNEL_OPT_IN_POLICY.email)).toBe(true);
    expect(isChannelArmed(CHANNEL_OPT_IN_POLICY.telegram)).toBe(false);
    expect(isChannelArmed(CHANNEL_OPT_IN_POLICY.push)).toBe(false);
  });
});

describe('decideConfirmationIssue', () => {
  const email = CHANNEL_OPT_IN_POLICY.email;

  it('allows the first three in a day and sets a 48 h expiry', () => {
    expect(decideConfirmationIssue(email, [AT - HOUR, AT - 2 * HOUR], AT)).toEqual({
      allowed: true,
      expiresAt: AT + 48 * HOUR,
    });
  });

  it('refuses the fourth, and says when the oldest leaves the window', () => {
    expect(decideConfirmationIssue(email, [AT - 10 * HOUR, AT - HOUR, AT - 60_000], AT)).toEqual({
      allowed: false,
      reason: 'rate_limited',
      retryAfterSeconds: 14 * 3600,
    });
  });

  it('ignores issuances outside the window', () => {
    expect(decideConfirmationIssue(email, [AT - DAY, AT - DAY - 1, AT - HOUR], AT).allowed).toBe(
      true,
    );
  });

  it('refuses every issuance on an unarmed channel', () => {
    expect(decideConfirmationIssue(CHANNEL_OPT_IN_POLICY.telegram, [], AT)).toEqual({
      allowed: false,
      reason: 'unarmed',
    });
    expect(
      decideConfirmationIssue(
        { pendingTtlMs: HOUR, issuesPerWindow: null, issueWindowMs: DAY },
        [],
        AT,
      ),
    ).toEqual({ allowed: false, reason: 'unarmed' });
  });
});

describe('confirmationState', () => {
  it('is pending until it expires, then expired', () => {
    expect(confirmationState(record(), AT)).toBe('pending');
    expect(confirmationState(record(), AT + HOUR)).toBe('expired');
  });

  it('lets a recorded ending win over expiry', () => {
    expect(confirmationState(record({ consumedAt: AT }), AT + DAY)).toBe('confirmed');
    expect(confirmationState(record({ revokedAt: AT }), AT + DAY)).toBe('revoked');
    expect(confirmationState(record({ supersededAt: AT }), AT + DAY)).toBe('superseded');
  });
});

describe('evaluateConfirmation', () => {
  const live = { ...record(), accountDeleted: false };

  it('accepts a pending token for its own channel only', () => {
    expect(evaluateConfirmation(live, 'email', AT)).toBeNull();
    expect(evaluateConfirmation(live, 'telegram', AT)).toBe('wrong_channel');
  });

  it('names the refusal a person can act on', () => {
    expect(evaluateConfirmation(null, 'email', AT)).toBe('unknown');
    expect(evaluateConfirmation({ ...live, accountDeleted: true }, 'email', AT)).toBe(
      'account_deleted',
    );
    expect(evaluateConfirmation({ ...live, consumedAt: AT - 1 }, 'email', AT + DAY)).toBe('used');
    expect(evaluateConfirmation({ ...live, revokedAt: AT - 1 }, 'email', AT)).toBe('revoked');
    expect(evaluateConfirmation({ ...live, supersededAt: AT - 1 }, 'email', AT)).toBe('superseded');
    expect(evaluateConfirmation(live, 'email', AT + HOUR)).toBe('expired');
  });
});

describe('isSubscriptionDispatchable', () => {
  it('is true only for a confirmed, unrevoked subscription', () => {
    expect(isSubscriptionDispatchable({ confirmedAt: AT, revokedAt: null })).toBe(true);
    expect(isSubscriptionDispatchable({ confirmedAt: null, revokedAt: null })).toBe(false);
    expect(isSubscriptionDispatchable({ confirmedAt: AT, revokedAt: AT })).toBe(false);
  });
});
