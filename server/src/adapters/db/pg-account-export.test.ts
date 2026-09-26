import { describe, expect, it } from 'vitest';

import { EXPORT_COLUMNS } from '../../core/account-export/export-schema.js';
import { ERASURE_PLAN } from '../../core/erasure/erasure-plan.js';
import { epochMsFromIso } from '../../core/ports/clock.js';
import type { ZoneCentreCipher } from '../../core/ports/zone-centre-cipher.js';
import {
  ACCOUNT_EXPORT_SQL,
  createPgAccountExporter,
  createPgAccountExportSource,
  type PgExportClient,
} from './pg-account-export.js';
import { ACCOUNT_ERASURE_SQL } from './pg-account-erasure.js';

const AT = epochMsFromIso('2026-09-24T08:00:00Z');
const ACCOUNT = '99999999-0000-4000-8000-000000000001';
const ZONE = '99999999-0000-4000-8000-0000000000a1';

type Table = keyof typeof ACCOUNT_EXPORT_SQL;

function nullRow(table: Table, values: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const column of Object.keys(EXPORT_COLUMNS[table])) base[column] = null;
  return { ...base, ...values };
}

/** Answers by statement; anything unlisted returns no rows. */
function stubPool(answers: Partial<Record<Table | 'begin', Record<string, unknown>[] | Error>>) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  let released = 0;
  const tableOf = new Map<string, string>(
    Object.entries(ACCOUNT_EXPORT_SQL).map(([table, text]) => [text, table]),
  );
  const query = <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) => {
    queries.push({ text, values });
    const key = text.startsWith('BEGIN') ? 'begin' : tableOf.get(text);
    const answer = key === undefined ? undefined : answers[key as Table | 'begin'];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ rows: (answer ?? []) as Row[], rowCount: answer?.length ?? 0 });
  };
  const client: PgExportClient = {
    query,
    release() {
      released += 1;
    },
  };
  return {
    queries,
    steps: () => queries.map((q) => tableOf.get(q.text) ?? q.text),
    released: () => released,
    pool: { query, connect: () => Promise.resolve(client) },
  };
}

const CIPHER: ZoneCentreCipher = {
  seal: () => {
    throw new Error('not used');
  },
  open: (zoneId, sealed) => {
    if (zoneId !== ZONE || sealed.keyId !== 'k1' || sealed.ciphertext.length !== 44) {
      throw new Error('does not authenticate');
    }
    return { lat: 42.69751, lon: 23.32415 };
  },
};

const LIVE_ACCOUNT = nullRow('accounts', {
  id: ACCOUNT,
  email: 'person@example.org',
  timezone: 'Europe/Sofia',
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  new_fire_overrides_quiet_hours: true,
  created_at: '2026-06-01T10:00:00.000000Z',
});

describe('ACCOUNT_EXPORT_SQL', () => {
  it('has one statement per erasure-plan table, and no other', () => {
    expect(Object.keys(ACCOUNT_EXPORT_SQL).sort()).toEqual(
      ERASURE_PLAN.map((rule) => rule.table).sort(),
    );
  });

  it('reads each table from that table, never with *', () => {
    for (const [table, text] of Object.entries(ACCOUNT_EXPORT_SQL)) {
      expect(text).toContain(`FROM ${table} AS t`);
      expect(text).not.toMatch(/SELECT\s+\*/);
      expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
  });

  it('never selects a token hash, an operator id or the ledger key', () => {
    const all = Object.values(ACCOUNT_EXPORT_SQL).join('\n');
    for (const column of ['token_hash', 'approver_id', 'actor_id', 'account_hash AS']) {
      expect(all).not.toContain(column);
    }
  });

  it('selects rows by the same predicates the erasure uses', () => {
    const erasure = Object.values(ACCOUNT_ERASURE_SQL).join('\n');
    expect(erasure).toContain('watch_zone_id = ANY($1::uuid[])');
    expect(erasure).toContain('email = $1::text');
    expect(erasure).toContain('account_id = $1::uuid');
    expect(erasure).toContain("sha256(convert_to($1::text, 'UTF8'))");
    expect(ACCOUNT_EXPORT_SQL.alert_outbox).toContain('t.watch_zone_id = ANY($1::uuid[])');
    expect(ACCOUNT_EXPORT_SQL.auth_link_requests).toContain('t.email = $1::text');
    expect(ACCOUNT_EXPORT_SQL.channel_confirmations).toContain('t.account_id = $1::uuid');
    expect(ACCOUNT_EXPORT_SQL.erasure_requests).toContain(
      "t.account_hash = sha256(convert_to($1::text, 'UTF8'))",
    );
    // Soft-deleted zones are exported, as they are erased: no `deleted_at IS NULL` filter.
    expect(ACCOUNT_EXPORT_SQL.watch_zones).not.toContain('deleted_at IS NULL');
  });

  it('casts values into the shape the core checks', () => {
    expect(ACCOUNT_EXPORT_SQL.accounts).toContain(
      `to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
    );
    expect(ACCOUNT_EXPORT_SQL.accounts).toContain(
      `to_char(t.quiet_hours_start, 'HH24:MI') AS quiet_hours_start`,
    );
    expect(ACCOUNT_EXPORT_SQL.alert_outbox).toContain('t.id::text AS id');
    expect(ACCOUNT_EXPORT_SQL.watch_zones).toContain('ST_AsGeoJSON(t.area)::jsonb AS area');
    expect(ACCOUNT_EXPORT_SQL.watch_zones).toContain('t.min_score::numeric::float8 AS min_score');
  });
});

describe('createPgAccountExportSource', () => {
  it('reports an erased account without handing over its row', async () => {
    const { pool } = stubPool({
      accounts: [nullRow('accounts', { id: ACCOUNT, deleted_at: '2026-09-01T00:00:00.000000Z' })],
    });
    expect(await createPgAccountExportSource(pool).readAccount(ACCOUNT)).toEqual({
      state: 'erased',
    });
  });

  it('reduces a row to the schema columns, dropping anything else the driver returned', async () => {
    const { pool } = stubPool({
      account_sessions: [
        nullRow('account_sessions', { id: 's1', token_hash: Buffer.alloc(32), extra: 1 }),
      ],
    });
    const rows = await createPgAccountExportSource(pool).readRows('account_sessions', {
      by: 'account',
      accountId: ACCOUNT,
    });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      Object.keys(EXPORT_COLUMNS.account_sessions).sort(),
    );
  });

  it('refuses a selector that is not the table scope', async () => {
    const { pool } = stubPool({});
    await expect(
      createPgAccountExportSource(pool).readRows('auth_link_requests', {
        by: 'account',
        accountId: ACCOUNT,
      }),
    ).rejects.toThrow(/selected by email/);
  });

  it('passes the sealed centre aside, never in the row', async () => {
    const { pool } = stubPool({
      watch_zones: [
        {
          ...nullRow('watch_zones', { id: ZONE }),
          sealed_centre_ciphertext: Buffer.alloc(44, 7),
          sealed_centre_key_id: 'k1',
        },
      ],
    });
    const [zone] = await createPgAccountExportSource(pool).readZones(ACCOUNT);
    expect(zone?.sealed?.keyId).toBe('k1');
    expect(zone?.sealed?.ciphertext.length).toBe(44);
    expect(Object.keys(zone?.row ?? {})).not.toContain('sealed_centre_ciphertext');
  });
});

describe('createPgAccountExporter', () => {
  it('reads every table in one read-only snapshot and opens the centre', async () => {
    const stub = stubPool({
      accounts: [LIVE_ACCOUNT],
      watch_zones: [
        {
          ...nullRow('watch_zones', { id: ZONE, account_id: ACCOUNT, name: 'Home' }),
          sealed_centre_ciphertext: Buffer.alloc(44, 7),
          sealed_centre_key_id: 'k1',
        },
      ],
      auth_link_requests: [
        nullRow('auth_link_requests', { id: 'l1', email: 'person@example.org' }),
      ],
    });
    const outcome = await createPgAccountExporter(stub.pool, CIPHER)(ACCOUNT, AT);
    expect(stub.steps()).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'accounts',
      'watch_zones',
      'alert_outbox',
      'alert_states',
      'alerts_shadow',
      'alert_decision_log',
      'alert_digest_log',
      'channel_confirmations',
      'channel_subscriptions',
      'account_sessions',
      'auth_link_requests',
      'erasure_requests',
      'COMMIT',
    ]);
    expect(stub.released()).toBe(1);
    if (outcome.status !== 'exported') throw new Error(outcome.status);
    expect(outcome.document.tables.watch_zones[0]?.['centre']).toEqual({
      lat: 42.69751,
      lon: 23.32415,
    });
    expect(outcome.document.tables.auth_link_requests).toHaveLength(1);
    const values = stub.queries.map((q) => q.values);
    expect(values).toContainEqual([[ZONE]]);
    expect(values).toContainEqual(['person@example.org']);
    expect(JSON.stringify(outcome.document)).not.toMatch(/sealed_centre|token_hash"\s*:/);
  });

  it('rolls back and releases when a read fails', async () => {
    const stub = stubPool({ accounts: [LIVE_ACCOUNT], watch_zones: new Error('boom') });
    await expect(createPgAccountExporter(stub.pool, CIPHER)(ACCOUNT, AT)).rejects.toThrow('boom');
    expect(stub.steps()).toContain('ROLLBACK');
    expect(stub.steps()).not.toContain('COMMIT');
    expect(stub.released()).toBe(1);
  });
});
