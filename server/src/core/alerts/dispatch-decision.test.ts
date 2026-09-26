import { describe, expect, it } from 'vitest';

import {
  CHANNEL_MISMATCH_REASON,
  deliveryDeadline,
  dispatchVerdict,
  hasExpiredUnapproved,
} from './dispatch-decision.js';
import type { DispatchVerdict } from './dispatch-decision.js';
import { SOLO_COOLOFF_MS, UNDELIVERABLE_REASONS } from './outbox.js';
import type { UndeliverableReason } from './outbox.js';
import { DELIVERY_PARAMS } from '../config/delivery-params.js';
import type { DeliveryParams } from '../config/delivery-params.js';
import { CONFIG_VERSION_RE } from '../config/versioned-config.js';
import type { ClaimedOutboxRow } from '../ports/alert-dispatch-queue.js';
import { ALERT_CHANNELS, OUTBOX_STATUSES } from '../ports/alert-outbox-store.js';
import type { OutboxStatus } from '../ports/alert-outbox-store.js';
import type { ResolvedRecipient } from '../ports/recipient-resolver.js';

const PARAMS = DELIVERY_PARAMS.values;

/** The same instant `outbox.test.ts` decides at, so the two suites read as one story. */
const DECIDED_AT = 1_785_670_170_000;
/** D6's push TTL and queue expiry in milliseconds, spelled out so the maths is readable. */
const PUSH_TTL_MS = 1_800_000;
const QUEUE_EXPIRY_MS = 21_600_000;

function claimedRow(overrides: Partial<ClaimedOutboxRow> = {}): ClaimedOutboxRow {
  return {
    id: '4181',
    watchZoneId: '11111111-0000-4000-8000-000000000001',
    fireEventId: '9007199254740993',
    alertType: 'new_fire',
    alertSubkey: 'once',
    triggerType: 'new_fire',
    triggerRefSeq: '41',
    ruleVersion: 'alert_gating_v1',
    templateId: 'new_fire.bg.v3',
    templateParams: {},
    channel: 'push',
    channelSubscriptionId: '3f2b0a5e-0000-4000-8000-000000000001',
    priority: 10,
    budgetSeq: null,
    status: 'claimed',
    actorId: null,
    approverId: null,
    approvalMode: null,
    approvedAt: null,
    budgetOverride: false,
    decidedAt: DECIDED_AT,
    claimedAt: DECIDED_AT,
    locale: 'bg',
    ...overrides,
  };
}

const LIVE: ResolvedRecipient = {
  live: true,
  endpoint: 'https://fcm.googleapis.com/fcm/send/eXaMpLe',
  channel: 'push',
  timeZone: 'Europe/Sofia',
};

function dead(reason = 'zone_deleted'): ResolvedRecipient {
  return { live: false, reason };
}

/** By default the recipient's subscription is on the row's own channel (H5 agreement). */
function decide(
  row: ClaimedOutboxRow,
  now: number,
  recipient: ResolvedRecipient = {
    live: true,
    endpoint: 'https://fcm.googleapis.com/fcm/send/eXaMpLe',
    channel: row.channel,
    timeZone: 'Europe/Sofia',
  },
  params: DeliveryParams = PARAMS,
): DispatchVerdict {
  return dispatchVerdict({ row, now, recipient, params });
}

/** What the verdict settled on, in one word — the ordering tests are about exactly this. */
function outcomeOf(verdict: DispatchVerdict): OutboxStatus | 'send' | 'release' {
  return verdict.action === 'close' ? verdict.status : verdict.action;
}

/** One claimed row per way `isDeliverable` can refuse, keyed so none can be forgotten. */
const UNDELIVERABLE: Readonly<Record<UndeliverableReason, ClaimedOutboxRow>> = {
  missing_trigger_ref: claimedRow({ triggerRefSeq: '' }),
  missing_rule_version: claimedRow({ ruleVersion: '' }),
  missing_template: claimedRow({ templateId: '' }),
  unaccountable_manual: claimedRow({ triggerType: 'manual', actorId: 'operator-anna' }),
  self_approved: claimedRow({
    triggerType: 'manual',
    actorId: 'operator-anna',
    approverId: 'operator-anna',
    approvalMode: 'two_person',
  }),
  cooloff_not_served: claimedRow({
    triggerType: 'manual',
    actorId: 'operator-anna',
    approverId: 'operator-anna',
    approvalMode: 'solo_cooloff',
    approvedAt: DECIDED_AT + SOLO_COOLOFF_MS - 1,
  }),
};

describe('deliveryDeadline', () => {
  it('gives a push row 1800 s and the other two channels the queue expiry', () => {
    expect(deliveryDeadline(claimedRow({ channel: 'push' }), PARAMS)).toBe(
      DECIDED_AT + PUSH_TTL_MS,
    );
    expect(deliveryDeadline(claimedRow({ channel: 'telegram' }), PARAMS)).toBe(
      DECIDED_AT + QUEUE_EXPIRY_MS,
    );
    expect(deliveryDeadline(claimedRow({ channel: 'email' }), PARAMS)).toBe(
      DECIDED_AT + QUEUE_EXPIRY_MS,
    );
  });

  it('takes the shorter of the two deadlines, whichever one that is', () => {
    // A queue that died before the channel TTL would otherwise keep handing rows to a
    // provider with more life on them than the queue itself was willing to grant.
    const tightQueue: DeliveryParams = { ...PARAMS, queueExpirySeconds: 600 };
    for (const channel of ALERT_CHANNELS) {
      expect(deliveryDeadline(claimedRow({ channel }), tightQueue)).toBe(DECIDED_AT + 600_000);
    }
  });

  it('measures from decided_at and not from the claim', () => {
    const row = claimedRow({ decidedAt: 1_700_000_000_000 });
    expect(deliveryDeadline(row, PARAMS)).toBe(1_700_000_000_000 + PUSH_TTL_MS);
  });
});

describe('dispatchVerdict — the happy path', () => {
  it('sends with the life the row has left, not the channel TTL', () => {
    // Decided 25 minutes ago: the provider must be told 300 s, or it will hold the push
    // past the half-hour at which D6 says a fire alert stops being fresh.
    expect(decide(claimedRow(), DECIDED_AT + 1_500_000)).toEqual({
      action: 'send',
      ttlSeconds: 300,
      deadlineAt: DECIDED_AT + PUSH_TTL_MS,
    });
  });

  it('rounds the remaining life up, so a live row is never handed over with 0 s', () => {
    // 299_999 ms left. Rounding down would send a push the provider is entitled to drop.
    expect(decide(claimedRow(), DECIDED_AT + 1_500_001)).toMatchObject({ ttlSeconds: 300 });
    expect(decide(claimedRow(), DECIDED_AT + PUSH_TTL_MS - 1)).toMatchObject({ ttlSeconds: 1 });
  });
});

describe('dispatchVerdict — D6 deadlines', () => {
  it('keeps a push row sendable to the last millisecond of its 1800 s', () => {
    expect(decide(claimedRow(), DECIDED_AT + PUSH_TTL_MS - 1)).toEqual({
      action: 'send',
      ttlSeconds: 1,
      deadlineAt: DECIDED_AT + PUSH_TTL_MS,
    });
  });

  it('closes a push row exactly at the deadline, not a tick after it', () => {
    expect(decide(claimedRow(), DECIDED_AT + PUSH_TTL_MS)).toEqual({
      action: 'close',
      status: 'ttl_expired',
      reason: 'decided 1800s ago; push deadline is 1800s',
    });
  });

  it('lets telegram and email live all six hours, because nothing shorter is enforceable', () => {
    for (const channel of ['telegram', 'email'] as const) {
      const row = claimedRow({ channel });
      // Long past the push TTL and still perfectly sendable.
      expect(decide(row, DECIDED_AT + PUSH_TTL_MS)).toMatchObject({ action: 'send' });
      expect(decide(row, DECIDED_AT + QUEUE_EXPIRY_MS - 1)).toEqual({
        action: 'send',
        ttlSeconds: 1,
        deadlineAt: DECIDED_AT + QUEUE_EXPIRY_MS,
      });
      expect(decide(row, DECIDED_AT + QUEUE_EXPIRY_MS)).toEqual({
        action: 'close',
        status: 'ttl_expired',
        reason: `decided 21600s ago; ${channel} deadline is 21600s`,
      });
    }
  });
});

describe('dispatchVerdict — the order of the three rules', () => {
  it('closes an expired row as ttl_expired even though the recipient is gone', () => {
    // The deadline is rule 1 on purpose: the send stopped being wanted before anything
    // else about the row went wrong.
    expect(outcomeOf(decide(claimedRow(), DECIDED_AT + PUSH_TTL_MS, dead()))).toBe('ttl_expired');
  });

  it('closes an expired unapproved row as ttl_expired and not as an approval failure', () => {
    // Closing a queue problem as an accountability failure would page an operator about
    // the wrong thing.
    const row = UNDELIVERABLE.unaccountable_manual;
    expect(outcomeOf(decide(row, DECIDED_AT + 1000))).toBe('failed');
    expect(outcomeOf(decide(row, DECIDED_AT + PUSH_TTL_MS))).toBe('ttl_expired');
  });

  it('closes a dead recipients undeliverable row as cancelled_erasure and not as failed', () => {
    // A1.9's status is evidence that the send was *stopped*; `failed` would lose that.
    const row = UNDELIVERABLE.self_approved;
    expect(outcomeOf(decide(row, DECIDED_AT + 1000))).toBe('failed');
    expect(outcomeOf(decide(row, DECIDED_AT + 1000, dead()))).toBe('cancelled_erasure');
  });

  it('keeps the deadline in front when all three rules fire at once', () => {
    const row = UNDELIVERABLE.unaccountable_manual;
    expect(outcomeOf(decide(row, DECIDED_AT + PUSH_TTL_MS, dead()))).toBe('ttl_expired');
  });

  it('holds the cool-offs release behind both closes', () => {
    // The only healing refusal still loses to a dead recipient and to the deadline.
    const row = UNDELIVERABLE.cooloff_not_served;
    expect(outcomeOf(decide(row, DECIDED_AT + 1000))).toBe('release');
    expect(outcomeOf(decide(row, DECIDED_AT + 1000, dead()))).toBe('cancelled_erasure');
    expect(outcomeOf(decide(row, DECIDED_AT + PUSH_TTL_MS, dead()))).toBe('ttl_expired');
  });
});

describe('dispatchVerdict — A1.9 liveness re-check', () => {
  it('closes cancelled_erasure and passes the resolvers own reason through', () => {
    for (const reason of ['zone_deleted', 'subscription_deleted', 'subscription_unconfirmed']) {
      expect(decide(claimedRow(), DECIDED_AT + 1000, dead(reason))).toEqual({
        action: 'close',
        status: 'cancelled_erasure',
        reason,
      });
    }
  });

  it('stops a row that is otherwise perfectly sendable', () => {
    // The whole point of the re-check: this row passed every other gate at claim time.
    expect(decide(claimedRow(), DECIDED_AT + 1000)).toMatchObject({ action: 'send' });
    expect(decide(claimedRow(), DECIDED_AT + 1000, dead())).toMatchObject({ action: 'close' });
  });
});

describe('dispatchVerdict — channel agreement (H5)', () => {
  it('closes failed with channel_mismatch when the subscription is on another channel', () => {
    for (const rowChannel of ALERT_CHANNELS) {
      for (const subscriptionChannel of ALERT_CHANNELS) {
        if (rowChannel === subscriptionChannel) continue;
        const verdict = decide(claimedRow({ channel: rowChannel }), DECIDED_AT + 1000, {
          ...LIVE,
          channel: subscriptionChannel,
        });
        expect(verdict).toEqual({
          action: 'close',
          status: 'failed',
          reason: `${CHANNEL_MISMATCH_REASON}: row is ${rowChannel}, subscription is ${subscriptionChannel}`,
        });
      }
    }
  });

  it('sends when the channels agree', () => {
    for (const channel of ALERT_CHANNELS) {
      expect(
        decide(claimedRow({ channel }), DECIDED_AT + 1000, { ...LIVE, channel }),
      ).toMatchObject({ action: 'send' });
    }
  });

  it('ranks after the deadline and after liveness', () => {
    const onTelegram: ResolvedRecipient = { ...LIVE, channel: 'telegram' };
    expect(outcomeOf(decide(claimedRow(), DECIDED_AT + PUSH_TTL_MS, onTelegram))).toBe(
      'ttl_expired',
    );
    expect(outcomeOf(decide(claimedRow(), DECIDED_AT + 1000, dead()))).toBe('cancelled_erasure');
  });

  it('ranks before accountability: a mismatched row never waits out a cool-off', () => {
    const coolingOff = UNDELIVERABLE.cooloff_not_served;
    const verdict = decide(coolingOff, DECIDED_AT + 1000, { ...LIVE, channel: 'email' });
    expect(verdict).toMatchObject({ action: 'close', status: 'failed' });
  });
});

describe('dispatchVerdict — A1.1 and A1.4 accountability', () => {
  it('closes failed carrying the reason for every fault that cannot heal', () => {
    for (const reason of UNDELIVERABLE_REASONS) {
      if (reason === 'cooloff_not_served') {
        continue;
      }
      expect(decide(UNDELIVERABLE[reason], DECIDED_AT + 1000)).toEqual({
        action: 'close',
        status: 'failed',
        reason,
      });
    }
  });

  it('applies the same check to an automatic row a human pushed past budget', () => {
    // A1.1: "whatever its trigger type" — the override is the human act.
    expect(decide(claimedRow({ budgetOverride: true }), DECIDED_AT + 1000)).toEqual({
      action: 'close',
      status: 'failed',
      reason: 'unaccountable_manual',
    });
  });

  it('releases rather than closes while the cool-off is still running', () => {
    // Releasing is safe only because rule 1 terminates it: the row dies at the deadline.
    expect(decide(UNDELIVERABLE.cooloff_not_served, DECIDED_AT + 1000)).toEqual({
      action: 'release',
      reason: 'cooloff_not_served',
    });
  });

  it('sends the moment A1.4s 900 s cool-off is served', () => {
    const solo = (approvedAt: number): ClaimedOutboxRow =>
      claimedRow({
        triggerType: 'manual',
        actorId: 'operator-anna',
        approverId: 'operator-anna',
        approvalMode: 'solo_cooloff',
        approvedAt,
      });
    expect(decide(solo(DECIDED_AT + SOLO_COOLOFF_MS - 1), DECIDED_AT + 1_000_000)).toMatchObject({
      action: 'release',
    });
    expect(decide(solo(DECIDED_AT + SOLO_COOLOFF_MS), DECIDED_AT + 1_000_000)).toEqual({
      action: 'send',
      ttlSeconds: 800,
      deadlineAt: DECIDED_AT + PUSH_TTL_MS,
    });
  });

  it('sends a manual row a second human approved', () => {
    const row = claimedRow({
      triggerType: 'manual',
      actorId: 'operator-anna',
      approverId: 'operator-boris',
      approvalMode: 'two_person',
    });
    expect(decide(row, DECIDED_AT + 1000)).toMatchObject({ action: 'send' });
  });
});

describe('dispatchVerdict — guards', () => {
  it('refuses any row the queue did not hand out claimed', () => {
    for (const status of OUTBOX_STATUSES) {
      if (status === 'claimed') {
        continue;
      }
      expect(() => decide(claimedRow({ status }), DECIDED_AT + 1000)).toThrow(TypeError);
    }
    expect(() => decide(claimedRow({ status: 'pending' }), DECIDED_AT + 1000)).toThrow(
      'row 4181 is pending, not claimed',
    );
  });

  it('refuses an instant that is not a finite epoch', () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => decide(claimedRow(), now)).toThrow(RangeError);
    }
    expect(() => decide(claimedRow(), Number.NaN)).toThrow('now must be a finite epoch, got NaN');
  });

  it('runs both guards ahead of every rule', () => {
    // An expired, erased, unapproved row still throws rather than quietly closing: a
    // caller that read the queue instead of claiming it is a bug, not a verdict.
    expect(() =>
      decide(
        { ...UNDELIVERABLE.unaccountable_manual, status: 'pending' },
        DECIDED_AT + PUSH_TTL_MS,
        dead(),
      ),
    ).toThrow(TypeError);
    expect(() => decide(claimedRow({ status: 'sent' }), Number.NaN)).toThrow(RangeError);
  });
});

describe('hasExpiredUnapproved', () => {
  const EXPIRY = DECIDED_AT + QUEUE_EXPIRY_MS;

  it('is false for every status but awaiting_approval', () => {
    for (const status of OUTBOX_STATUSES) {
      if (status === 'awaiting_approval') {
        continue;
      }
      // Long past the expiry, and still not the sweeper's business.
      expect(hasExpiredUnapproved({ status, decidedAt: DECIDED_AT }, EXPIRY + 1, PARAMS)).toBe(
        false,
      );
    }
  });

  it('turns true exactly at the six-hour queue expiry', () => {
    const row = { status: 'awaiting_approval', decidedAt: DECIDED_AT } as const;
    expect(hasExpiredUnapproved(row, EXPIRY - 1, PARAMS)).toBe(false);
    expect(hasExpiredUnapproved(row, EXPIRY, PARAMS)).toBe(true);
    expect(hasExpiredUnapproved(row, EXPIRY + 1, PARAMS)).toBe(true);
  });

  it('reads the same queue expiry the dispatch deadline does', () => {
    // The two deadlines share a config so an approval window cannot outlive the queue.
    const row = { status: 'awaiting_approval', decidedAt: DECIDED_AT } as const;
    const telegramDeadline = deliveryDeadline(claimedRow({ channel: 'telegram' }), PARAMS);
    expect(hasExpiredUnapproved(row, telegramDeadline, PARAMS)).toBe(true);
    expect(hasExpiredUnapproved(row, telegramDeadline - 1, PARAMS)).toBe(false);
  });
});

describe('delivery_params_v1', () => {
  it('carries a version the replay fixtures can validate, and is frozen', () => {
    expect(DELIVERY_PARAMS.name).toBe('delivery_params');
    expect(DELIVERY_PARAMS.version).toBe('delivery_params_v1');
    expect(DELIVERY_PARAMS.version).toMatch(CONFIG_VERSION_RE);
    expect(Object.isFrozen(DELIVERY_PARAMS)).toBe(true);
    expect(Object.isFrozen(PARAMS)).toBe(true);
  });

  it('ships D6s numbers verbatim', () => {
    // Edited silently, these move a promise made in an ADR and quoted in a runbook.
    expect(PARAMS.channelTtlSeconds.push).toBe(1800);
    expect(PARAMS.channelTtlSeconds.telegram).toBe(21_600);
    expect(PARAMS.channelTtlSeconds.email).toBe(21_600);
    expect(PARAMS.queueExpirySeconds).toBe(21_600);
    expect(PARAMS.dispatchSloP95Seconds).toBe(60);
    expect(PARAMS.queueAgePageSeconds).toBe(600);
  });

  it('states the same numbers the prose does', () => {
    expect(PARAMS.channelTtlSeconds.push).toBe(30 * 60);
    expect(PARAMS.queueExpirySeconds).toBe(6 * 60 * 60);
  });

  it('gives every channel a TTL, so no channel falls back to an implicit one', () => {
    expect(Object.keys(PARAMS.channelTtlSeconds).sort()).toEqual([...ALERT_CHANNELS].sort());
  });
});
