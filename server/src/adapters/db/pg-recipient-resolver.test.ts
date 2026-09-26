import { describe, expect, it } from 'vitest';

import {
  RECIPIENT_SQL,
  createPgRecipientResolver,
  type PgRecipientQueryable,
} from './pg-recipient-resolver.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubDb extends PgRecipientQueryable {
  readonly queries: RecordedQuery[];
}

function stubDb(rows: Record<string, unknown>[] = []): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
    },
  };
}

const NOW = 1_785_670_200_000;
const ZONE = '11111111-0000-4000-8000-000000000001';
const SUB = '3f2b0a5e-0000-4000-8000-000000000001';
const ACCOUNT = '22222222-0000-4000-8000-000000000001';

function liveRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zone_deleted_at: null,
    account_id: ACCOUNT,
    account_deleted_at: null,
    timezone: 'Europe/Sofia',
    subscription_id: SUB,
    subscription_account_id: ACCOUNT,
    channel: 'push',
    endpoint: 'https://example.invalid/push/not-a-real-endpoint',
    revoked_at: null,
    confirmed_at: new Date(NOW - 86_400_000),
    ...overrides,
  };
}

const resolver = (db: StubDb) => createPgRecipientResolver(db, { now: () => NOW });

describe('the resolve statement', () => {
  it('reads liveness and the endpoint together, keyed by zone', () => {
    // One statement, so the check and the read cannot disagree (A1.9's race).
    expect(RECIPIENT_SQL.resolve).toContain('LEFT JOIN channel_subscriptions s ON s.id = $2::uuid');
    expect(RECIPIENT_SQL.resolve).toContain('WHERE z.id = $1::uuid');
  });
});

describe('resolve', () => {
  it("returns the endpoint, the subscription's channel and the account time zone for a live pair", async () => {
    const db = stubDb([liveRow()]);
    expect(await resolver(db).resolve({ watchZoneId: ZONE, channelSubscriptionId: SUB })).toEqual({
      live: true,
      endpoint: 'https://example.invalid/push/not-a-real-endpoint',
      channel: 'push',
      timeZone: 'Europe/Sofia',
    });
    expect(db.queries[0]?.values).toEqual([ZONE, SUB]);
  });

  it('names which link broke', async () => {
    const cases: [Record<string, unknown>[], string][] = [
      [[], 'watch zone is gone'],
      [[liveRow({ zone_deleted_at: new Date(NOW) })], 'watch zone was deleted'],
      [[liveRow({ account_deleted_at: new Date(NOW) })], 'account was deleted'],
      [
        [liveRow({ subscription_id: null, subscription_account_id: null })],
        'channel subscription is gone',
      ],
      [[liveRow({ revoked_at: new Date(NOW) })], 'channel subscription was revoked'],
      [[liveRow({ confirmed_at: null })], 'channel subscription is not confirmed'],
      [[liveRow({ endpoint: null })], 'channel subscription has no endpoint'],
      [[liveRow({ endpoint: '' })], 'channel subscription has no endpoint'],
    ];
    for (const [rows, reason] of cases) {
      expect(
        await resolver(stubDb(rows)).resolve({ watchZoneId: ZONE, channelSubscriptionId: SUB }),
        reason,
      ).toEqual({ live: false, reason });
    }
  });

  it('checks deletion before revocation, so the post-mortem names the erasure', async () => {
    const db = stubDb([liveRow({ account_deleted_at: new Date(NOW), revoked_at: new Date(NOW) })]);
    expect(await resolver(db).resolve({ watchZoneId: ZONE, channelSubscriptionId: SUB })).toEqual({
      live: false,
      reason: 'account was deleted',
    });
  });

  it('never resolves a pending subscription live, and names revocation first', async () => {
    // Double opt-in (I3): an unconfirmed endpoint is not a recipient.
    expect(RECIPIENT_SQL.resolve).toContain('s.confirmed_at');
    const pending = stubDb([liveRow({ confirmed_at: null })]);
    expect(
      await resolver(pending).resolve({ watchZoneId: ZONE, channelSubscriptionId: SUB }),
    ).toEqual({ live: false, reason: 'channel subscription is not confirmed' });
    const both = stubDb([liveRow({ confirmed_at: null, revoked_at: new Date(NOW) })]);
    expect(await resolver(both).resolve({ watchZoneId: ZONE, channelSubscriptionId: SUB })).toEqual(
      { live: false, reason: 'channel subscription was revoked' },
    );
  });

  it('answers a row without a subscription without a query', async () => {
    const db = stubDb([liveRow()]);
    expect(await resolver(db).resolve({ watchZoneId: ZONE, channelSubscriptionId: null })).toEqual({
      live: false,
      reason: 'no channel subscription on the row',
    });
    expect(db.queries).toHaveLength(0);
  });

  it("throws on a subscription that belongs to someone else's account", async () => {
    // Not a dead recipient: a row that would put one person's fire on another's phone.
    const db = stubDb([
      liveRow({ subscription_account_id: '22222222-0000-4000-8000-000000000002' }),
    ]);
    await expect(
      resolver(db).resolve({ watchZoneId: ZONE, channelSubscriptionId: SUB }),
    ).rejects.toThrow(/different account/);
  });

  it("reports the subscription's channel as stored, without judging it against the row", async () => {
    // The mismatch verdict belongs to dispatchVerdict (H5); the resolver only reads.
    expect(RECIPIENT_SQL.resolve).toContain('s.channel');
    const db = stubDb([liveRow({ channel: 'telegram' })]);
    expect(
      await resolver(db).resolve({ watchZoneId: ZONE, channelSubscriptionId: SUB }),
    ).toMatchObject({ live: true, channel: 'telegram' });
  });

  it('throws on a channel outside the vocabulary rather than guessing one', async () => {
    const db = stubDb([liveRow({ channel: 'carrier_pigeon' })]);
    await expect(
      resolver(db).resolve({ watchZoneId: ZONE, channelSubscriptionId: SUB }),
    ).rejects.toThrow(/outside its vocabulary/);
  });

  it('no longer answers a locale: the row carries its own (migration 015)', async () => {
    const resolved = await resolver(stubDb([liveRow()])).resolve({
      watchZoneId: ZONE,
      channelSubscriptionId: SUB,
    });
    expect(resolved).not.toHaveProperty('locale');
  });
});

describe('applyDisposition', () => {
  it('leaves a kept subscription alone', async () => {
    const db = stubDb();
    await resolver(db).applyDisposition(SUB, 'keep');
    expect(db.queries).toHaveLength(0);
  });

  it('revokes a pruned or reprompted subscription at now, once', async () => {
    const db = stubDb();
    await resolver(db).applyDisposition(SUB, 'prune');
    await resolver(db).applyDisposition(SUB, 'reprompt');
    expect(db.queries.map((q) => q.text)).toEqual([RECIPIENT_SQL.revoke, RECIPIENT_SQL.revoke]);
    expect(db.queries[0]?.values).toEqual([SUB, new Date(NOW).toISOString()]);
    // A second prune must keep the first instant.
    expect(RECIPIENT_SQL.revoke).toContain('AND revoked_at IS NULL');
  });

  it('refuses a clock that is not a finite epoch', async () => {
    const db = stubDb();
    await expect(
      createPgRecipientResolver(db, { now: () => Number.NaN }).applyDisposition(SUB, 'prune'),
    ).rejects.toThrow(RangeError);
    expect(db.queries).toHaveLength(0);
  });
});
