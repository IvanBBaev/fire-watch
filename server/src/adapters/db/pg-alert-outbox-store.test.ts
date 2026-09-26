import { describe, expect, it } from 'vitest';

import type { OutboxRowDraft } from '../../core/ports/alert-outbox-store.js';
import {
  INSERT_OUTBOX_ROWS_SQL,
  createPgAlertOutboxStore,
  outboxArrays,
  type PgQueryable,
} from './pg-alert-outbox-store.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubDb extends PgQueryable {
  readonly queries: RecordedQuery[];
}

function stubDb(rowCount: number | null = 0): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return Promise.resolve({ rowCount });
    },
  };
}

function draft(overrides: Partial<OutboxRowDraft> = {}): OutboxRowDraft {
  return {
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
    locale: 'bg',
    priority: 10,
    budgetSeq: null,
    status: 'pending',
    actorId: null,
    approverId: null,
    approvalMode: null,
    approvedAt: null,
    budgetOverride: false,
    decidedAt: 1_785_670_170_000,
    ...overrides,
  };
}

describe('the insert statement', () => {
  it('is A1.11s unique key, enforced by the database', () => {
    expect(INSERT_OUTBOX_ROWS_SQL).toContain(
      'ON CONFLICT (watch_zone_id, fire_event_id, alert_type, alert_subkey) DO NOTHING',
    );
    // DO UPDATE would let a redelivery rewrite a decision that has already been sent —
    // the outbox is the audit trail of what was decided, not a cache of the latest view.
    expect(INSERT_OUTBOX_ROWS_SQL).not.toMatch(/DO UPDATE/);
  });

  it('never writes the columns the gateway owns', () => {
    // Everything after the decision: writing any of these at decision time would make
    // D9's dispatch latency the difference between two numbers written together.
    for (const column of [
      'dispatched_at',
      'provider_ack_at',
      'last_error',
      'pseudonymized_at',
      'claimed_at',
    ]) {
      expect(INSERT_OUTBOX_ROWS_SQL).not.toContain(column);
    }
    expect(INSERT_OUTBOX_ROWS_SQL).not.toMatch(/\bid\b,/);
  });

  it('binds one array per column regardless of batch size', () => {
    // The 65,535-parameter wire limit is the reason: an August afternoon deciding several
    // hundred pairs must not become several statements.
    expect(INSERT_OUTBOX_ROWS_SQL).toContain('$21::timestamptz[]');
    expect(INSERT_OUTBOX_ROWS_SQL).not.toContain('$22');
  });

  it('casts the bound parameters to the column types', () => {
    expect(INSERT_OUTBOX_ROWS_SQL).toContain('$1::uuid[]');
    expect(INSERT_OUTBOX_ROWS_SQL).toContain('$2::bigint[]');
    // template_params travels as text and becomes jsonb in the projection: an array of
    // JSON documents would otherwise have to survive the driver's array-literal encoder.
    expect(INSERT_OUTBOX_ROWS_SQL).toContain('$9::text[]');
    expect(INSERT_OUTBOX_ROWS_SQL).toContain('template_params::jsonb');
  });
});

describe('enqueue', () => {
  it('touches nothing for an empty batch', async () => {
    const db = stubDb();
    const result = await createPgAlertOutboxStore(db).enqueue([]);
    expect(db.queries).toHaveLength(0);
    expect(result).toEqual({ received: 0, inserted: 0, alreadyDecided: 0 });
  });

  it('reports a conflict as already decided rather than as a failure', async () => {
    const db = stubDb(1);
    const result = await createPgAlertOutboxStore(db).enqueue([
      draft(),
      draft({ alertSubkey: 'step-1', alertType: 'escalation', triggerType: 'escalation' }),
    ]);
    expect(result).toEqual({ received: 2, inserted: 1, alreadyDecided: 1 });
  });

  it('counts a driver that reports no rowCount as nothing inserted', async () => {
    const db = stubDb(null);
    const result = await createPgAlertOutboxStore(db).enqueue([draft()]);
    expect(result).toEqual({ received: 1, inserted: 0, alreadyDecided: 1 });
  });

  it('sends one statement for the whole batch', async () => {
    const db = stubDb(3);
    await createPgAlertOutboxStore(db).enqueue([draft(), draft(), draft()]);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text).toBe(INSERT_OUTBOX_ROWS_SQL);
  });
});

describe('outboxArrays', () => {
  it('is one array per column, in statement order', () => {
    const arrays = outboxArrays([draft()]);
    expect(arrays).toHaveLength(21);
    expect(arrays.every((column) => column.length === 1)).toBe(true);
  });

  it('serializes template parameters rather than a rendered body', () => {
    const arrays = outboxArrays([
      draft({ templateParams: { zoneName: 'Витоша', distanceKm: 4.2 } }),
    ]);
    expect(arrays[8]).toEqual(['{"zoneName":"Витоша","distanceKm":4.2}']);
  });

  it('renders instants as ISO timestamps and keeps a missing approval null', () => {
    const arrays = outboxArrays([draft()]);
    expect(arrays[20]).toEqual(['2026-08-02T11:29:30.000Z']);
    expect(arrays[18]).toEqual([null]);
  });

  it('renders an approval instant when there is one', () => {
    const arrays = outboxArrays([draft({ approvedAt: 1_785_671_070_000 })]);
    expect(arrays[18]).toEqual(['2026-08-02T11:44:30.000Z']);
  });

  it('writes each row in its own locale (migration 015)', () => {
    expect(INSERT_OUTBOX_ROWS_SQL).toContain('$12::text[]');
    const arrays = outboxArrays([draft(), draft({ locale: 'en' })]);
    expect(arrays[11]).toEqual(['bg', 'en']);
  });

  it('keeps big identifiers as text', () => {
    // 9007199254740993 is 2^53 + 1: a round-trip through a JS number would return the
    // wrong event, which is a wrong alert about a real fire.
    const arrays = outboxArrays([draft()]);
    expect(arrays[1]).toEqual(['9007199254740993']);
  });

  it('refuses a decision instant that is not a real epoch', () => {
    expect(() => outboxArrays([draft({ decidedAt: Number.NaN })])).toThrow(RangeError);
  });
});
