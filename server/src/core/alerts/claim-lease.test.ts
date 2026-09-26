import { describe, expect, it } from 'vitest';

import {
  CLAIM_LEASE_MS,
  CLAIM_SEND_WINDOW_MS,
  DEFAULT_CLAIM_LEASE,
  LEASE_EXHAUSTED_REASON,
  assertClaimLease,
  leaseAllowsSend,
  leaseExpiryCutoff,
} from './claim-lease.js';

const NOW = 1_785_670_200_000;

describe('the default lease', () => {
  it('is 120 s with a 30 s send window, and valid', () => {
    expect(DEFAULT_CLAIM_LEASE).toEqual({
      leaseMs: CLAIM_LEASE_MS,
      sendWindowMs: CLAIM_SEND_WINDOW_MS,
    });
    expect(CLAIM_LEASE_MS).toBe(120_000);
    expect(CLAIM_SEND_WINDOW_MS).toBe(30_000);
    expect(() => assertClaimLease(DEFAULT_CLAIM_LEASE)).not.toThrow();
    expect(Object.isFrozen(DEFAULT_CLAIM_LEASE)).toBe(true);
  });

  it("returns a crashed dispatcher's rows well inside push's D6 deadline", () => {
    // D6: push expires at 1800 s and the queue-age page fires at 600 s.
    expect(CLAIM_LEASE_MS).toBeLessThan(600_000);
  });

  it('names its release reason', () => {
    expect(LEASE_EXHAUSTED_REASON).toBe('claim_lease_exhausted');
  });
});

describe('assertClaimLease', () => {
  it('refuses a lease or a window that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertClaimLease({ leaseMs: bad, sendWindowMs: 1 }), String(bad)).toThrow(
        RangeError,
      );
      expect(() => assertClaimLease({ leaseMs: 120_000, sendWindowMs: bad }), String(bad)).toThrow(
        RangeError,
      );
    }
  });

  it('refuses a window that leaves no room to send', () => {
    expect(() => assertClaimLease({ leaseMs: 30_000, sendWindowMs: 30_000 })).toThrow(
      /must be shorter/,
    );
    expect(() => assertClaimLease({ leaseMs: 30_000, sendWindowMs: 29_999 })).not.toThrow();
  });
});

describe('leaseExpiryCutoff', () => {
  it('is one lease before now', () => {
    expect(leaseExpiryCutoff(NOW)).toBe(NOW - CLAIM_LEASE_MS);
    expect(leaseExpiryCutoff(NOW, { leaseMs: 5_000, sendWindowMs: 1_000 })).toBe(NOW - 5_000);
  });

  it('refuses a clock that is not a finite epoch', () => {
    expect(() => leaseExpiryCutoff(Number.NaN)).toThrow(RangeError);
  });
});

describe('leaseAllowsSend', () => {
  it('allows a send while the whole window fits in the lease, and not a millisecond later', () => {
    const lastStart = NOW + CLAIM_LEASE_MS - CLAIM_SEND_WINDOW_MS;
    expect(leaseAllowsSend(NOW, NOW)).toBe(true);
    expect(leaseAllowsSend(NOW, lastStart)).toBe(true);
    expect(leaseAllowsSend(NOW, lastStart + 1)).toBe(false);
  });

  it('never allows a send on a claim the expiry sweep could already release', () => {
    // The sweep releases claims at or before now - lease; a send must end before that.
    const claimedAt = NOW;
    for (let now = NOW; now <= NOW + CLAIM_LEASE_MS; now += 1_000) {
      if (leaseAllowsSend(claimedAt, now)) {
        expect(leaseExpiryCutoff(now + CLAIM_SEND_WINDOW_MS)).toBeLessThanOrEqual(claimedAt);
      }
    }
  });

  it('uses an injected lease', () => {
    const lease = { leaseMs: 10_000, sendWindowMs: 4_000 };
    expect(leaseAllowsSend(NOW, NOW + 6_000, lease)).toBe(true);
    expect(leaseAllowsSend(NOW, NOW + 6_001, lease)).toBe(false);
  });

  it('refuses instants that are not finite epochs', () => {
    expect(() => leaseAllowsSend(Number.NaN, NOW)).toThrow(RangeError);
    expect(() => leaseAllowsSend(NOW, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
