import { describe, expect, it } from 'vitest';

import {
  ERASURE_CANCELLABLE_STATUSES,
  ERASURE_OPEN_ITEMS,
  ERASURE_PLAN,
  ERASURE_PLAN_VERSION,
  isCancelledByErasure,
  RETAINED_TEMPLATE_PARAM_KEYS,
  retainedTemplateParams,
} from './erasure-plan.js';

/** Every table 001–018 class `personal`. The integration test reads the live registry. */
const PERSONAL_TABLES = [
  'accounts',
  'account_sessions',
  'alert_decision_log',
  'alert_digest_log',
  'alert_outbox',
  'alert_states',
  'alerts_shadow',
  'auth_link_requests',
  'channel_confirmations',
  'channel_subscriptions',
  'erasure_requests',
  'watch_zones',
];

describe('ERASURE_PLAN', () => {
  it('has exactly one rule per table', () => {
    const tables = ERASURE_PLAN.map((rule) => rule.table);
    expect(new Set(tables).size).toBe(tables.length);
    expect([...tables].sort()).toEqual([...PERSONAL_TABLES].sort());
  });

  it('keeps nothing of a deleted table', () => {
    for (const rule of ERASURE_PLAN.filter((r) => r.action === 'delete')) {
      expect(rule.survives, rule.table).toEqual([]);
    }
  });

  it('never lets a recipient column survive', () => {
    const recipient = [
      'account_id',
      'email',
      'email_verified_at',
      'endpoint',
      'watch_zone_id',
      'channel_subscription_id',
      'template_params',
      'area',
      'token_hash',
      'ua_family',
      'user_id',
    ];
    for (const rule of ERASURE_PLAN) {
      for (const column of recipient) {
        expect(rule.survives, `${rule.table}.${column}`).not.toContain(column);
      }
    }
  });

  it('records the account in the ledger as a hash only', () => {
    const ledger = ERASURE_PLAN.find((rule) => rule.table === 'erasure_requests');
    expect(ledger?.survives).toEqual([
      'account_hash',
      'erased_at',
      'deadline_at',
      'counts',
      'plan_version',
    ]);
  });

  it('gives every rule a reason and a spec', () => {
    for (const rule of ERASURE_PLAN) {
      expect(rule.reason.length, rule.table).toBeGreaterThan(0);
      expect(rule.spec.length, rule.table).toBeGreaterThan(0);
    }
  });

  it('carries a version the ledger CHECK accepts', () => {
    expect(ERASURE_PLAN_VERSION).toMatch(/^[a-z0-9_]+_v[0-9]+$/);
  });

  it('names its open items', () => {
    expect(ERASURE_OPEN_ITEMS.length).toBeGreaterThan(0);
  });
});

describe('the cancel set (A1.9)', () => {
  it('is every status not yet final', () => {
    expect([...ERASURE_CANCELLABLE_STATUSES]).toEqual(['pending', 'awaiting_approval', 'claimed']);
  });

  it('leaves final statuses as they are', () => {
    for (const status of [
      'sent',
      'failed',
      'cancelled_erasure',
      'expired_unapproved',
      'ttl_expired',
    ]) {
      expect(isCancelledByErasure(status), status).toBe(false);
    }
    for (const status of ERASURE_CANCELLABLE_STATUSES) {
      expect(isCancelledByErasure(status), status).toBe(true);
    }
  });
});

describe('retainedTemplateParams', () => {
  it('drops every parameter while no key is registered as non-personal', () => {
    expect(RETAINED_TEMPLATE_PARAM_KEYS).toEqual([]);
    expect(retainedTemplateParams({ distanceKm: 4.2, zoneName: 'Home' })).toEqual({});
  });

  it('keeps exactly the listed keys', () => {
    expect(
      retainedTemplateParams({ distanceKm: 4.2, zoneName: 'Home', band: '5-10' }, ['band']),
    ).toEqual({ band: '5-10' });
  });
});
