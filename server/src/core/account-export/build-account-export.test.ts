import { describe, expect, it } from 'vitest';

import { ERASURE_PLAN, ERASURE_PLAN_VERSION } from '../erasure/erasure-plan.js';
import type {
  AccountExportSource,
  ExportAccountLookup,
  ExportRow,
  ExportRowTable,
  ExportSelector,
  ExportZone,
} from '../ports/account-export-source.js';
import { epochMsFromIso } from '../ports/clock.js';
import type { ZoneCentreCipher } from '../ports/zone-centre-cipher.js';
import { ACCOUNT_EXPORT_FORMAT, buildAccountExport, checkRow } from './build-account-export.js';
import {
  ACCOUNT_EXPORT_TABLES,
  EXPORT_COLUMNS,
  EXPORT_SCOPES,
  EXPORT_WITHHELD,
  type AccountExportTable,
} from './export-schema.js';

const AT = epochMsFromIso('2026-09-24T08:00:00Z');
const ACCOUNT = '99999999-0000-4000-8000-000000000001';
const ZONE_A = '99999999-0000-4000-8000-0000000000a1';
const ZONE_B = '99999999-0000-4000-8000-0000000000b2';

/** A row of the table with every column NULL, then the overrides. */
function row(table: AccountExportTable, values: Record<string, unknown> = {}): ExportRow {
  const base: Record<string, unknown> = {};
  for (const column of Object.keys(EXPORT_COLUMNS[table])) base[column] = null;
  return { ...base, ...values } as ExportRow;
}

const ACCOUNT_ROW = row('accounts', {
  id: ACCOUNT,
  email: 'person@example.org',
  timezone: 'Europe/Sofia',
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  new_fire_overrides_quiet_hours: true,
  created_at: '2026-06-01T10:00:00.000Z',
});

function zone(id: string, sealed: ExportZone['sealed']): ExportZone {
  return {
    row: row('watch_zones', { id, account_id: ACCOUNT, name: 'Home', radius_m: 5000 }),
    sealed,
  };
}

interface Fake {
  readonly source: AccountExportSource;
  readonly reads: { table: ExportRowTable; selector: ExportSelector }[];
}

function fakeSource(
  options: {
    account?: ExportAccountLookup;
    zones?: readonly ExportZone[];
    rows?: Partial<Record<ExportRowTable, readonly ExportRow[]>>;
  } = {},
): Fake {
  const reads: { table: ExportRowTable; selector: ExportSelector }[] = [];
  return {
    reads,
    source: {
      readAccount: () =>
        Promise.resolve(
          options.account ?? { state: 'live', row: ACCOUNT_ROW, email: 'person@example.org' },
        ),
      readZones: () => Promise.resolve(options.zones ?? []),
      readRows: (table, selector) => {
        reads.push({ table, selector });
        return Promise.resolve(options.rows?.[table] ?? []);
      },
    },
  };
}

/** Opens `ok:<lat>,<lon>` ciphertexts; anything else fails, as a wrong key would. */
const CIPHER: ZoneCentreCipher = {
  seal: () => {
    throw new Error('not used');
  },
  open: (_zoneId, sealed) => {
    const text = new TextDecoder().decode(sealed.ciphertext);
    const match = /^ok:(-?[\d.]+),(-?[\d.]+)$/.exec(text);
    if (match === null) throw new Error('does not authenticate');
    return { lat: Number(match[1]), lon: Number(match[2]) };
  },
};

function sealed(text: string) {
  return { ciphertext: new TextEncoder().encode(text), keyId: 'k1' };
}

describe('the export schema', () => {
  it('covers exactly the tables the erasure plan covers', () => {
    expect([...ACCOUNT_EXPORT_TABLES].sort()).toEqual(
      ERASURE_PLAN.map((rule) => rule.table).sort(),
    );
    expect(Object.keys(EXPORT_COLUMNS).sort()).toEqual([...ACCOUNT_EXPORT_TABLES].sort());
    expect(Object.keys(EXPORT_SCOPES).sort()).toEqual([...ACCOUNT_EXPORT_TABLES].sort());
  });

  it('never exports a token hash, a sealed centre or an operator id', () => {
    for (const table of ACCOUNT_EXPORT_TABLES) {
      const columns = Object.keys(EXPORT_COLUMNS[table]);
      for (const secret of [
        'token_hash',
        'centre_ciphertext',
        'centre_key_id',
        'approver_id',
        'actor_id',
        'account_hash',
      ]) {
        expect(columns, `${table}.${secret}`).not.toContain(secret);
      }
    }
  });

  it('withholds no column it also exports, and gives every withheld column a reason', () => {
    for (const entry of EXPORT_WITHHELD) {
      expect(Object.keys(EXPORT_COLUMNS[entry.table])).not.toContain(entry.column);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('buildAccountExport', () => {
  it('builds account_export_v1 with every covered table, withheld columns and limits', async () => {
    const { source } = fakeSource();
    const outcome = await buildAccountExport(ACCOUNT, AT, source, CIPHER);
    if (outcome.status !== 'exported') throw new Error(outcome.status);
    const { document } = outcome;
    expect(document.format).toBe(ACCOUNT_EXPORT_FORMAT);
    expect(document.format).toBe('account_export_v1');
    expect(document.generated_at).toBe('2026-09-24T08:00:00Z');
    expect(document.account_id).toBe(ACCOUNT);
    expect(document.erasure_plan_version).toBe(ERASURE_PLAN_VERSION);
    expect(Object.keys(document.tables)).toEqual([...ACCOUNT_EXPORT_TABLES]);
    expect(document.coverage).toEqual([...ACCOUNT_EXPORT_TABLES]);
    expect(document.tables.accounts).toEqual([ACCOUNT_ROW]);
    expect(document.withheld).toEqual(EXPORT_WITHHELD);
    expect(document.limits.length).toBeGreaterThan(0);
  });

  it('selects each table by the erasure plan scope', async () => {
    const fake = fakeSource({ zones: [zone(ZONE_A, sealed('ok:42.7,23.3'))] });
    await buildAccountExport(ACCOUNT, AT, fake.source, CIPHER);
    const byTable = Object.fromEntries(fake.reads.map((r) => [r.table, r.selector]));
    expect(byTable).toEqual({
      alert_outbox: { by: 'zones', zoneIds: [ZONE_A] },
      alert_states: { by: 'zones', zoneIds: [ZONE_A] },
      alerts_shadow: { by: 'zones', zoneIds: [ZONE_A] },
      alert_decision_log: { by: 'zones', zoneIds: [ZONE_A] },
      alert_digest_log: { by: 'zones', zoneIds: [ZONE_A] },
      channel_confirmations: { by: 'account', accountId: ACCOUNT },
      channel_subscriptions: { by: 'account', accountId: ACCOUNT },
      account_sessions: { by: 'account', accountId: ACCOUNT },
      auth_link_requests: { by: 'email', email: 'person@example.org' },
      erasure_requests: { by: 'account_hash', accountId: ACCOUNT },
    });
  });

  it('skips zone-scoped reads without zones, and link requests without an address', async () => {
    const fake = fakeSource({ account: { state: 'live', row: ACCOUNT_ROW, email: null } });
    const outcome = await buildAccountExport(ACCOUNT, AT, fake.source, CIPHER);
    expect(fake.reads.map((r) => r.table).sort()).toEqual([
      'account_sessions',
      'channel_confirmations',
      'channel_subscriptions',
      'erasure_requests',
    ]);
    if (outcome.status !== 'exported') throw new Error(outcome.status);
    expect(outcome.document.tables.alert_outbox).toEqual([]);
    expect(outcome.document.tables.auth_link_requests).toEqual([]);
  });

  it('opens zone centres, and reports a legacy or unreadable one instead of failing', async () => {
    const { source } = fakeSource({
      zones: [
        zone(ZONE_A, sealed('ok:42.69751,23.32415')),
        zone(ZONE_B, sealed('garbage')),
        zone('99999999-0000-4000-8000-0000000000c3', null),
      ],
    });
    const outcome = await buildAccountExport(ACCOUNT, AT, source, CIPHER);
    if (outcome.status !== 'exported') throw new Error(outcome.status);
    const zones = outcome.document.tables.watch_zones;
    expect(zones.map((z) => [z['centre'], z['centre_status']])).toEqual([
      [{ lat: 42.69751, lon: 23.32415 }, 'opened'],
      [null, 'unreadable'],
      [null, 'legacy_plaintext_area'],
    ]);
    const text = JSON.stringify(outcome.document);
    expect(text).not.toContain('garbage');
    expect(text).not.toContain('k1');
  });

  it('returns erased or missing without reading anything else', async () => {
    for (const state of ['erased', 'missing'] as const) {
      const fake = fakeSource({ account: { state } });
      expect(await buildAccountExport(ACCOUNT, AT, fake.source, CIPHER)).toEqual({
        status: state,
      });
      expect(fake.reads).toEqual([]);
    }
  });

  it('fails closed when an adapter returns a column outside the allow-list', async () => {
    const { source } = fakeSource({
      rows: {
        account_sessions: [{ ...row('account_sessions'), token_hash: 'deadbeef' }],
      },
    });
    await expect(buildAccountExport(ACCOUNT, AT, source, CIPHER)).rejects.toThrow(
      /account_sessions carries a column outside the schema: token_hash/,
    );
  });
});

describe('checkRow', () => {
  it('accepts a well-typed row and NULLs', () => {
    expect(() =>
      checkRow(
        'alert_outbox',
        row('alert_outbox', {
          id: '9007199254740993',
          template_params: { place: 'x' },
          priority: 100,
          budget_override: false,
          decided_at: '2026-09-24T08:00:00.123456Z',
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['accounts', 'created_at', '2026-09-24 08:00:00+00'],
    ['accounts', 'quiet_hours_start', '22:00:00'],
    ['alert_outbox', 'id', 12],
    ['alert_outbox', 'priority', 1.5],
    ['watch_zones', 'min_score', Number.NaN],
    ['watch_zones', 'area', 'POINT(23 42)'],
    ['accounts', 'new_fire_overrides_quiet_hours', 'true'],
  ] as const)('refuses %s.%s = %j', (table, column, value) => {
    expect(() => checkRow(table, row(table, { [column]: value }))).toThrow(
      `${table}.${column} is not a`,
    );
  });

  it('refuses a row missing a declared column, naming the column but not a value', () => {
    const partial: Record<string, unknown> = { ...row('accounts', { email: 'secret@x.org' }) };
    delete partial['timezone'];
    expect(() => checkRow('accounts', partial as ExportRow)).toThrow(/lacks timezone$/);
  });
});
