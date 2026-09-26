import { describe, expect, it } from 'vitest';

import {
  ABANDONED_CLAIM_ERROR,
  ALERT_DISPATCH_SQL,
  EXPIRED_CLAIM_ERROR,
  createPgAlertDispatchQueue,
  createPgSendRateReader,
  decodeClaimedRow,
  type PgDispatchQueryable,
} from './pg-alert-dispatch-queue.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

type Reply = { rows: Record<string, unknown>[]; rowCount: number | null } | Error;

interface StubDb extends PgDispatchQueryable {
  readonly queries: RecordedQuery[];
}

/** Answers each query with the next scripted reply, then with an empty one-row update. */
function stubDb(...replies: Reply[]): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      const reply = replies.shift() ?? { rows: [], rowCount: 1 };
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve(reply as { rows: Row[]; rowCount: number | null });
    },
  };
}

const NOW = 1_785_670_200_000;

function claimedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '9007199254740993',
    watch_zone_id: '11111111-0000-4000-8000-000000000001',
    fire_event_id: '42',
    alert_type: 'new_fire',
    alert_subkey: 'once',
    trigger_type: 'new_fire',
    trigger_ref_seq: '41',
    rule_version: 'alert_gating_v1',
    template_id: 'new_fire.bg.v3',
    template_params: { distanceKm: 4 },
    channel: 'push',
    channel_subscription_id: '3f2b0a5e-0000-4000-8000-000000000001',
    priority: 10,
    budget_seq: null,
    status: 'claimed',
    actor_id: null,
    approver_id: null,
    approval_mode: null,
    approved_at: null,
    budget_override: false,
    decided_at: new Date(NOW - 5_000),
    locale: 'bg',
    claimed_at: new Date(NOW),
    ...overrides,
  };
}

describe('the claim statement', () => {
  it('reads and takes the rows in one statement', () => {
    // The port's rule: no instant at which a row has been read and is not yet owned.
    expect(ALERT_DISPATCH_SQL.claim).toContain('FOR UPDATE SKIP LOCKED');
    expect(ALERT_DISPATCH_SQL.claim).toMatch(/UPDATE alert_outbox o\s+SET status = 'claimed'/);
    expect(ALERT_DISPATCH_SQL.claim).toContain("WHERE status = 'pending'");
  });

  it("takes rows in A1.2's stored order and returns them in it, as numbers", () => {
    expect(ALERT_DISPATCH_SQL.claim).toContain('ORDER BY priority, decided_at, id');
    // Qualified: the bare `id` would be the text cast, and '10' sorts before '9'.
    expect(ALERT_DISPATCH_SQL.claim).toContain(
      'ORDER BY claimed.priority, claimed.decided_at, claimed.id',
    );
  });

  it('never claims a row decided after now, so a replay claims the same rows', () => {
    expect(ALERT_DISPATCH_SQL.claim).toContain('decided_at <= $2::timestamptz');
  });
});

describe('every settle', () => {
  it('matches only a row that is still claimed, by this claim', () => {
    // A1.9's erasure moves queued rows behind the gateway's back; a settle must not undo
    // it. And a claim whose lease expired and was re-claimed is someone else's (H4).
    for (const text of [
      ALERT_DISPATCH_SQL.settleSent,
      ALERT_DISPATCH_SQL.settleClosed,
      ALERT_DISPATCH_SQL.settleReleased,
      ALERT_DISPATCH_SQL.releaseAbandoned,
    ]) {
      expect(text).toContain("status = 'claimed'");
      expect(text).toMatch(/claimed_at = (\$\d+|mine\.claimed_at)/);
    }
  });
});

describe('claim', () => {
  it('binds the limit and now, and decodes what it took', async () => {
    const db = stubDb({ rows: [claimedRow()], rowCount: 1 });
    const rows = await createPgAlertDispatchQueue(db).claim(25, NOW);

    expect(db.queries[0]?.values).toEqual([25, new Date(NOW).toISOString()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '9007199254740993',
      channel: 'push',
      templateParams: { distanceKm: 4 },
      decidedAt: NOW - 5_000,
      claimedAt: NOW,
      locale: 'bg',
      status: 'claimed',
    });
  });

  it('refuses a limit that is not a positive integer without touching the table', async () => {
    const db = stubDb();
    const queue = createPgAlertDispatchQueue(db);
    for (const limit of [0, -1, 2.5, Number.NaN]) {
      await expect(queue.claim(limit, NOW), String(limit)).rejects.toThrow(RangeError);
    }
    expect(db.queries).toHaveLength(0);
  });

  it('still remembers a row it took and could not decode', async () => {
    // Claimed in the table either way; forgetting it would strand it until a restart.
    const db = stubDb(
      { rows: [claimedRow({ trigger_type: 'hunch' })], rowCount: 1 },
      { rows: [], rowCount: 1 },
    );
    const queue = createPgAlertDispatchQueue(db);

    await expect(queue.claim(1, NOW)).rejects.toThrow(/trigger_type/);
    expect(await queue.releaseAbandonedClaims()).toBe(1);
    expect(db.queries[1]?.values).toEqual([
      ['9007199254740993'],
      [new Date(NOW).toISOString()],
      ABANDONED_CLAIM_ERROR,
    ]);
  });
});

/** A queue that has claimed `ids` at NOW, and the stub behind it. */
async function claimed(...ids: string[]): Promise<{
  db: StubDb;
  queue: ReturnType<typeof createPgAlertDispatchQueue>;
}> {
  const db = stubDb(
    { rows: ids.map((id) => claimedRow({ id })), rowCount: ids.length },
    ...ids.map(() => ({ rows: [], rowCount: 1 })),
  );
  const queue = createPgAlertDispatchQueue(db);
  await queue.claim(Math.max(ids.length, 1), NOW);
  db.queries.length = 0;
  return { db, queue };
}

const CLAIMED_AT = new Date(NOW).toISOString();

describe('settle', () => {
  it('writes both timestamps of a send, fenced on the claim', async () => {
    const { db, queue } = await claimed('7');
    await queue.settle('7', { kind: 'sent', dispatchedAt: NOW, providerAckAt: NOW + 300 });
    expect(db.queries[0]?.text).toBe(ALERT_DISPATCH_SQL.settleSent);
    expect(db.queries[0]?.values).toEqual([
      '7',
      new Date(NOW).toISOString(),
      new Date(NOW + 300).toISOString(),
      CLAIMED_AT,
    ]);
  });

  it('writes a close with or without a provider hand-off', async () => {
    const { db, queue } = await claimed('7', '8');
    await queue.settle('7', { kind: 'closed', status: 'failed', error: '410', dispatchedAt: NOW });
    await queue.settle('8', {
      kind: 'closed',
      status: 'ttl_expired',
      error: 'past deadline',
      dispatchedAt: null,
    });
    expect(db.queries[0]?.values).toEqual([
      '7',
      'failed',
      '410',
      new Date(NOW).toISOString(),
      CLAIMED_AT,
    ]);
    expect(db.queries[1]?.values).toEqual(['8', 'ttl_expired', 'past deadline', null, CLAIMED_AT]);
  });

  it('refuses to close a row into a status that is not terminal', async () => {
    const { db, queue } = await claimed('7');
    for (const status of ['pending', 'claimed', 'sent', 'awaiting_approval'] as const) {
      await expect(
        queue.settle('7', { kind: 'closed', status, error: 'x', dispatchedAt: null }),
        status,
      ).rejects.toThrow(TypeError);
    }
    expect(db.queries).toHaveLength(0);
  });

  it('returns a released row to pending with its reason', async () => {
    const { db, queue } = await claimed('7');
    await queue.settle('7', { kind: 'released', error: 'timeout' });
    expect(db.queries[0]?.text).toBe(ALERT_DISPATCH_SQL.settleReleased);
    expect(db.queries[0]?.values).toEqual(['7', 'timeout', CLAIMED_AT]);
  });

  it('refuses to settle a row this instance never claimed, without touching the table', async () => {
    // Another dispatcher's claim, or a row this one already settled: either way there is
    // no claim to fence on, and settling unfenced is the double-settle H4 closes.
    const db = stubDb();
    await expect(
      createPgAlertDispatchQueue(db).settle('7', { kind: 'released', error: null }),
    ).rejects.toThrow(/not claimed by this dispatcher/);
    expect(db.queries).toHaveLength(0);
  });

  it('refuses a second settle of the same claim', async () => {
    const { db, queue } = await claimed('7');
    await queue.settle('7', { kind: 'released', error: null });
    await expect(queue.settle('7', { kind: 'released', error: null })).rejects.toThrow(
      /not claimed by this dispatcher/,
    );
    expect(db.queries).toHaveLength(1);
  });

  it('throws when another writer moved the row first, and forgets it', async () => {
    const db = stubDb({ rows: [claimedRow({ id: '7' })], rowCount: 1 }, { rows: [], rowCount: 0 });
    const queue = createPgAlertDispatchQueue(db);
    await queue.claim(1, NOW);

    await expect(
      queue.settle('7', { kind: 'sent', dispatchedAt: NOW, providerAckAt: NOW }),
    ).rejects.toThrow(/another writer moved it first/);
    // Not this instance's to release any more: releasing it would undo the erasure, or
    // the new owner's claim after a lease expiry.
    expect(await queue.releaseAbandonedClaims()).toBe(0);
    expect(db.queries).toHaveLength(2);
  });

  it('refuses an id that is not a decimal bigint', async () => {
    const db = stubDb();
    await expect(
      createPgAlertDispatchQueue(db).settle('7; DROP TABLE', { kind: 'released', error: null }),
    ).rejects.toThrow(RangeError);
    expect(db.queries).toHaveLength(0);
  });
});

describe('the claim lease (migration 015)', () => {
  it('stamps claimed_at with the bound now in the claiming statement', () => {
    expect(ALERT_DISPATCH_SQL.claim).toMatch(
      /SET status = 'claimed', claimed_at = \$2::timestamptz/,
    );
    expect(ALERT_DISPATCH_SQL.claim).toContain('claimed.claimed_at');
    expect(ALERT_DISPATCH_SQL.claim).toContain('claimed.locale');
  });

  it('fences each claim on the instant of that claim, not the latest one', async () => {
    const db = stubDb(
      { rows: [claimedRow({ id: '1' })], rowCount: 1 },
      { rows: [claimedRow({ id: '2' })], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    );
    const queue = createPgAlertDispatchQueue(db);
    await queue.claim(1, NOW);
    await queue.claim(1, NOW + 10_000);
    await queue.settle('1', { kind: 'released', error: null });
    await queue.settle('2', { kind: 'released', error: null });

    expect(db.queries[2]?.values).toEqual(['1', null, new Date(NOW).toISOString()]);
    expect(db.queries[3]?.values).toEqual(['2', null, new Date(NOW + 10_000).toISOString()]);
  });

  it('releases every claim at or before the cutoff, whoever made it', async () => {
    expect(ALERT_DISPATCH_SQL.releaseExpired).toContain("status = 'claimed'");
    expect(ALERT_DISPATCH_SQL.releaseExpired).toContain('claimed_at <= $1::timestamptz');
    const db = stubDb({ rows: [], rowCount: 4 });

    expect(await createPgAlertDispatchQueue(db).releaseExpiredClaims(NOW - 120_000)).toBe(4);
    expect(db.queries[0]?.text).toBe(ALERT_DISPATCH_SQL.releaseExpired);
    expect(db.queries[0]?.values).toEqual([
      new Date(NOW - 120_000).toISOString(),
      EXPIRED_CLAIM_ERROR,
    ]);
  });
});

describe('claim expiry', () => {
  it('releases exactly the rows this instance claimed and never settled', async () => {
    const db = stubDb(
      { rows: [claimedRow({ id: '1' }), claimedRow({ id: '2' })], rowCount: 2 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    );
    const queue = createPgAlertDispatchQueue(db);
    await queue.claim(2, NOW);
    await queue.settle('1', { kind: 'released', error: null });

    expect(await queue.releaseAbandonedClaims()).toBe(1);
    expect(db.queries[2]?.text).toBe(ALERT_DISPATCH_SQL.releaseAbandoned);
    expect(db.queries[2]?.values).toEqual([
      ['2'],
      [new Date(NOW).toISOString()],
      ABANDONED_CLAIM_ERROR,
    ]);
    // Released once: the next cycle has nothing left to release.
    expect(await queue.releaseAbandonedClaims()).toBe(0);
    expect(db.queries).toHaveLength(3);
  });

  it('keeps the ids when the release itself fails, so the next cycle retries them', async () => {
    const db = stubDb(
      { rows: [claimedRow({ id: '3' })], rowCount: 1 },
      new Error('connection reset'),
      { rows: [], rowCount: 1 },
    );
    const queue = createPgAlertDispatchQueue(db);
    await queue.claim(1, NOW);

    await expect(queue.releaseAbandonedClaims()).rejects.toThrow(/connection reset/);
    expect(await queue.releaseAbandonedClaims()).toBe(1);
    expect(db.queries[2]?.values).toEqual([
      ['3'],
      [new Date(NOW).toISOString()],
      ABANDONED_CLAIM_ERROR,
    ]);
  });
});

describe('decodeClaimedRow', () => {
  it('rejects a vocabulary the schema and the code do not share', () => {
    for (const [column, value] of [
      ['alert_type', 'maybe_fire'],
      ['trigger_type', 'hunch'],
      ['channel', 'carrier_pigeon'],
      ['status', 'lost'],
      ['approval_mode', 'vibes'],
      ['locale', 'fr'],
    ] as const) {
      expect(() => decodeClaimedRow(claimedRow({ [column]: value })), column).toThrow(column);
    }
  });

  it('accepts only an object as the template parameters', () => {
    for (const value of [[], 'x', 3, null]) {
      expect(() => decodeClaimedRow(claimedRow({ template_params: value }))).toThrow(
        /template_params/,
      );
    }
  });

  it('decodes the claim instant and refuses a row claimed without one', () => {
    expect(decodeClaimedRow(claimedRow({ claimed_at: new Date(NOW - 1) })).claimedAt).toBe(NOW - 1);
    expect(decodeClaimedRow(claimedRow({ locale: 'en' })).locale).toBe('en');
    // Migration 015's CHECK makes this impossible; the decoder does not trust that.
    expect(() => decodeClaimedRow(claimedRow({ claimed_at: null }))).toThrow(/claimed_at/);
  });

  it('keeps nullable columns null and rejects a fractional priority', () => {
    const decoded = decodeClaimedRow(claimedRow({ channel_subscription_id: null }));
    expect(decoded.channelSubscriptionId).toBeNull();
    expect(decoded.approvedAt).toBeNull();
    expect(() => decodeClaimedRow(claimedRow({ priority: 1.5 }))).toThrow(/priority/);
  });
});

describe('the send-rate reader', () => {
  it("counts every provider hand-off since the window's start", async () => {
    expect(ALERT_DISPATCH_SQL.sendsSince).toContain('dispatched_at >= $1::timestamptz');
    const db = stubDb({ rows: [{ sends: 12 }], rowCount: 1 });
    expect(await createPgSendRateReader(db).sendsSince(NOW - 600_000)).toBe(12);
    expect(db.queries[0]?.values).toEqual([new Date(NOW - 600_000).toISOString()]);
  });

  it('throws rather than return a count it cannot trust', async () => {
    // The caller turns a throw into `null`, and `null` halts dispatch; a guessed 0 would not.
    for (const reply of [
      { rows: [], rowCount: 0 },
      { rows: [{ sends: -1 }], rowCount: 1 },
      { rows: [{ sends: 1.5 }], rowCount: 1 },
    ]) {
      await expect(createPgSendRateReader(stubDb(reply)).sendsSince(NOW)).rejects.toThrow();
    }
    await expect(createPgSendRateReader(stubDb()).sendsSince(Number.NaN)).rejects.toThrow(
      RangeError,
    );
  });
});
