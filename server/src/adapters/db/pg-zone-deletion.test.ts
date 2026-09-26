import { describe, expect, it } from 'vitest';

import {
  ZONE_DELETION_SQL,
  createPgZoneDeleter,
  type PgZoneDeletionClient,
} from './pg-zone-deletion.js';

type Responder = (text: string) => { rows: Record<string, unknown>[]; rowCount: number | null };

function stubPool(respond: Responder): {
  texts: string[];
  released: () => number;
  pool: { connect(): Promise<PgZoneDeletionClient> };
} {
  const texts: string[] = [];
  let released = 0;
  const client: PgZoneDeletionClient = {
    query<Row extends Record<string, unknown>>(text: string) {
      texts.push(text);
      try {
        return Promise.resolve(respond(text) as { rows: Row[]; rowCount: number | null });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    release() {
      released += 1;
    },
  };
  return { texts, released: () => released, pool: { connect: () => Promise.resolve(client) } };
}

const live: Responder = (text) => {
  if (text === ZONE_DELETION_SQL.lockAccount) return { rows: [{ live: 1 }], rowCount: 1 };
  if (text === ZONE_DELETION_SQL.softDeleteZone) return { rows: [], rowCount: 1 };
  if (text === ZONE_DELETION_SQL.cancelZoneOutbox) return { rows: [{ cancelled: 2 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};

describe('the statements', () => {
  it('locks the account against a digest pass and scopes the delete by account', () => {
    expect(ZONE_DELETION_SQL.lockAccount).toMatch(/deleted_at IS NULL\s+FOR NO KEY UPDATE$/);
    expect(ZONE_DELETION_SQL.softDeleteZone).toContain(
      'WHERE id = $2::uuid AND account_id = $1::uuid AND deleted_at IS NULL',
    );
  });

  it('cancels exactly the erasure-cancellable statuses, under row locks', () => {
    const text = ZONE_DELETION_SQL.cancelZoneOutbox;
    expect(text).toContain("status IN ('pending', 'awaiting_approval', 'claimed')");
    expect(text).toContain('FOR UPDATE');
    expect(text).toContain("SET status = 'cancelled_erasure'");
  });
});

describe('createPgZoneDeleter', () => {
  it('commits the delete and the cancellation together', async () => {
    const stub = stubPool(live);
    expect(await createPgZoneDeleter(stub.pool)('a', 'z', 'x')).toEqual({
      deleted: true,
      cancelled: 2,
    });
    expect(stub.texts).toEqual([
      'BEGIN',
      ZONE_DELETION_SQL.lockAccount,
      ZONE_DELETION_SQL.softDeleteZone,
      ZONE_DELETION_SQL.cancelZoneOutbox,
      'COMMIT',
    ]);
    expect(stub.released()).toBe(1);
  });

  it('rolls back without touching the outbox when there is no such zone or account', async () => {
    for (const miss of [ZONE_DELETION_SQL.lockAccount, ZONE_DELETION_SQL.softDeleteZone]) {
      const stub = stubPool((text) => (text === miss ? { rows: [], rowCount: 0 } : live(text)));
      expect(await createPgZoneDeleter(stub.pool)('a', 'z', 'x')).toEqual({
        deleted: false,
        cancelled: 0,
      });
      expect(stub.texts).not.toContain(ZONE_DELETION_SQL.cancelZoneOutbox);
      expect(stub.texts.at(-1)).toBe('ROLLBACK');
      expect(stub.released()).toBe(1);
    }
  });

  it('rolls back the soft-delete when the cancellation fails, and surfaces its error', async () => {
    const stub = stubPool((text) => {
      if (text === ZONE_DELETION_SQL.cancelZoneOutbox) throw new Error('lock timeout');
      if (text === 'ROLLBACK') throw new Error('rollback failed too');
      return live(text);
    });
    await expect(createPgZoneDeleter(stub.pool)('a', 'z', 'x')).rejects.toThrow('lock timeout');
    expect(stub.texts).not.toContain('COMMIT');
    expect(stub.released()).toBe(1);
  });
});
