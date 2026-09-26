import { describe, expect, it } from 'vitest';

import type { AlertDecision } from './alert-decision.js';
import type { DigestDecision, DigestEntry } from './digest.js';
import {
  DEFAULT_OUTBOX_LOCALE,
  SOLO_COOLOFF_MS,
  digestOutboxRows,
  isDeliverable,
  manualOutboxRow,
  outboxRowFor,
  type ManualSendInput,
  type OutboxBinding,
} from './outbox.js';
import type { OutboxRowDraft } from '../ports/alert-outbox-store.js';

const DECIDED_AT = 1_785_670_170_000;

function binding(overrides: Partial<OutboxBinding> = {}): OutboxBinding {
  return {
    fireEventId: '9007199254740993',
    triggerRefSeq: '41',
    channel: 'push',
    channelSubscriptionId: '3f2b0a5e-0000-4000-8000-000000000001',
    templateId: 'new_fire.bg.v3',
    decidedAt: DECIDED_AT,
    ...overrides,
  };
}

function decision(overrides: Partial<AlertDecision> = {}): AlertDecision {
  return {
    zoneId: '11111111-0000-4000-8000-000000000001',
    eventPublicId: 'fw-2026-q7f3d',
    outcome: 'send',
    reason: 'first_alert',
    alertType: 'new_fire',
    alertSubkey: 'once',
    priority: 10,
    ladderStep: 0,
    inQuietHours: false,
    ruleVersion: 'alert_gating_v1',
    nextState: null,
    ...overrides,
  };
}

function digestDecision(overrides: Partial<DigestDecision> = {}): DigestDecision {
  return {
    accountId: 'acc-1',
    outcome: 'send',
    reason: 'daily_summary',
    windowStartIso: '2026-08-02T06:00:00.000Z',
    alertType: 'digest',
    alertSubkey: '2026-08-02T06:00:00.000Z',
    priority: 30,
    advanceWatermark: true,
    ruleVersion: 'digest_params_v1',
    entries: [],
    ...overrides,
  };
}

function entry(zoneId: string, eventPublicId: string): DigestEntry {
  return { zoneId, eventPublicId, distanceKm: 4.2, kind: 'deferred' };
}

function manual(overrides: Partial<ManualSendInput> = {}): ManualSendInput {
  return {
    ...binding(),
    watchZoneId: '11111111-0000-4000-8000-000000000001',
    alertType: 'escalation',
    alertSubkey: 'step-3',
    ruleVersion: 'alert_gating_v1',
    actorId: 'operator-anna',
    ...overrides,
  };
}

describe('outboxRowFor', () => {
  it('writes a row only for a send', () => {
    for (const outcome of ['defer', 'suppress'] as const) {
      expect(outboxRowFor(decision({ outcome }), binding())).toBeNull();
    }
  });

  it('writes no row for a seed', () => {
    // A1.8 is explicit: state advances to notified_new with no outbox row and zero
    // sends. A row "for the audit trail" would sit in a queue whose only consumer sends.
    expect(
      outboxRowFor(decision({ outcome: 'seed', reason: 'pre_existing_event' }), binding()),
    ).toBeNull();
  });

  it('carries the decision, the binding and A1.1 provenance', () => {
    const row = outboxRowFor(decision(), binding());
    expect(row).toEqual({
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
      status: 'pending',
      actorId: null,
      approverId: null,
      approvalMode: null,
      approvedAt: null,
      budgetOverride: false,
      decidedAt: DECIDED_AT,
      locale: 'bg',
    } satisfies OutboxRowDraft);
  });

  it('keeps the trigger and the alert equal on an automatic row', () => {
    // Migration 003's alert_outbox_trigger_matches_alert says the same thing in SQL.
    const row = outboxRowFor(
      decision({ alertType: 'escalation', alertSubkey: 'step-2' }),
      binding(),
    );
    expect(row?.triggerType).toBe('escalation');
  });

  it('renders in bg unless the binding names a shipped locale (H5)', () => {
    // No account or subscription holds a language yet (migration 015); bg is A6's default.
    expect(DEFAULT_OUTBOX_LOCALE).toBe('bg');
    expect(outboxRowFor(decision(), binding())?.locale).toBe('bg');
    expect(outboxRowFor(decision(), binding({ locale: 'en' }))?.locale).toBe('en');
  });

  it('takes the decision instant rather than reading a clock', () => {
    const row = outboxRowFor(decision(), binding({ decidedAt: 1_700_000_000_000 }));
    expect(row?.decidedAt).toBe(1_700_000_000_000);
  });

  it('recomputes priority only when the decision left it out', () => {
    expect(outboxRowFor(decision({ priority: null }), binding())?.priority).toBe(10);
    expect(
      outboxRowFor(
        decision({ alertType: 'escalation', alertSubkey: 'step-1', priority: null }),
        binding(),
      )?.priority,
    ).toBe(20);
  });

  it('lets the caller put an over-budget row in awaiting_approval', () => {
    const row = outboxRowFor(decision(), binding({ status: 'awaiting_approval', budgetSeq: 91 }));
    expect(row?.status).toBe('awaiting_approval');
    expect(row?.budgetSeq).toBe(91);
  });

  it('refuses a send with no idempotency key', () => {
    expect(() => outboxRowFor(decision({ alertSubkey: null }), binding())).toThrow(TypeError);
    expect(() => outboxRowFor(decision({ alertType: null }), binding())).toThrow(TypeError);
  });
});

describe('digestOutboxRows', () => {
  it('writes one row per folded entry, all sharing the window subkey', () => {
    const rows = digestOutboxRows(
      digestDecision({
        entries: [entry('zone-a', 'fw-2026-aaaaa'), entry('zone-b', 'fw-2026-bbbbb')],
      }),
      (folded) => binding({ fireEventId: folded.eventPublicId === 'fw-2026-aaaaa' ? '7' : '8' }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.watchZoneId)).toEqual(['zone-a', 'zone-b']);
    expect(rows.map((row) => row.fireEventId)).toEqual(['7', '8']);
    expect(new Set(rows.map((row) => row.alertSubkey))).toEqual(
      new Set(['2026-08-02T06:00:00.000Z']),
    );
    expect(rows.every((row) => row.triggerType === 'digest' && row.priority === 30)).toBe(true);
  });

  it('spends nothing on a held or empty window', () => {
    for (const outcome of ['hold', 'suppress', 'none'] as const) {
      expect(
        digestOutboxRows(
          digestDecision({ outcome, entries: [entry('zone-a', 'fw-2026-aaaaa')] }),
          () => binding(),
        ),
      ).toEqual([]);
    }
  });

  it('drops an entry whose binding vanished', () => {
    const rows = digestOutboxRows(
      digestDecision({
        entries: [entry('zone-a', 'fw-2026-aaaaa'), entry('zone-b', 'fw-2026-bbbbb')],
      }),
      (folded) => (folded.zoneId === 'zone-a' ? null : binding()),
    );
    expect(rows.map((row) => row.watchZoneId)).toEqual(['zone-b']);
  });
});

describe('manualOutboxRow', () => {
  it('is manual by trigger and ordinary by alert type', () => {
    const row = manualOutboxRow(manual());
    expect(row.triggerType).toBe('manual');
    // `manual` is not something a recipient can be told, and folding it into alert_type
    // would put it in the A1.11 key — making an operator-continued escalation a
    // different alert from the one it continues.
    expect(row.alertType).toBe('escalation');
    expect(row.alertSubkey).toBe('step-3');
  });

  it('sorts ahead of every automatic class (A1.2)', () => {
    expect(manualOutboxRow(manual()).priority).toBe(0);
  });

  it('waits for a second human by default', () => {
    const row = manualOutboxRow(manual());
    expect(row.status).toBe('awaiting_approval');
    expect(row.approverId).toBeNull();
    expect(row.actorId).toBe('operator-anna');
  });

  it('refuses an unattributed manual row', () => {
    expect(() => manualOutboxRow(manual({ actorId: '' }))).toThrow(TypeError);
  });
});

describe('isDeliverable', () => {
  const automatic = (): OutboxRowDraft => {
    const row = outboxRowFor(decision(), binding());
    if (row === null) throw new Error('unreachable');
    return row;
  };

  it('passes an automatic row with complete provenance', () => {
    expect(isDeliverable(automatic())).toEqual({ deliverable: true });
  });

  it('refuses a row missing any of D1s four provenance fields', () => {
    expect(isDeliverable({ ...automatic(), triggerRefSeq: '' })).toEqual({
      deliverable: false,
      reason: 'missing_trigger_ref',
    });
    expect(isDeliverable({ ...automatic(), ruleVersion: '' })).toEqual({
      deliverable: false,
      reason: 'missing_rule_version',
    });
    expect(isDeliverable({ ...automatic(), templateId: '' })).toEqual({
      deliverable: false,
      reason: 'missing_template',
    });
  });

  it('refuses a manual row nobody approved', () => {
    expect(isDeliverable(manualOutboxRow(manual()))).toEqual({
      deliverable: false,
      reason: 'unaccountable_manual',
    });
  });

  it('applies the same check to an automatic row a human pushed past budget', () => {
    // A1.1 says "whatever its trigger type": the override is the human act.
    expect(isDeliverable({ ...automatic(), budgetOverride: true })).toEqual({
      deliverable: false,
      reason: 'unaccountable_manual',
    });
  });

  it('refuses self-approval outside the cool-off mode', () => {
    const row = manualOutboxRow(
      manual({ approverId: 'operator-anna', approvalMode: 'two_person' }),
    );
    expect(isDeliverable(row)).toEqual({ deliverable: false, reason: 'self_approved' });
  });

  it('accepts two-person approval by someone else', () => {
    const row = manualOutboxRow(
      manual({ approverId: 'operator-boris', approvalMode: 'two_person' }),
    );
    expect(isDeliverable(row)).toEqual({ deliverable: true });
  });

  it('holds a solo approval until the cool-off is served', () => {
    const early = manualOutboxRow(
      manual({
        approverId: 'operator-anna',
        approvalMode: 'solo_cooloff',
        approvedAt: DECIDED_AT + SOLO_COOLOFF_MS - 1,
      }),
    );
    expect(isDeliverable(early)).toEqual({ deliverable: false, reason: 'cooloff_not_served' });

    const served = manualOutboxRow(
      manual({
        approverId: 'operator-anna',
        approvalMode: 'solo_cooloff',
        approvedAt: DECIDED_AT + SOLO_COOLOFF_MS,
      }),
    );
    expect(isDeliverable(served)).toEqual({ deliverable: true });
  });

  it('quotes A1.4s cool-off as 900 s', () => {
    expect(SOLO_COOLOFF_MS).toBe(900_000);
  });

  it('refuses a solo approval with no timestamp at all', () => {
    const row = manualOutboxRow(
      manual({ approverId: 'operator-anna', approvalMode: 'solo_cooloff' }),
    );
    expect(isDeliverable(row)).toEqual({ deliverable: false, reason: 'cooloff_not_served' });
  });
});
