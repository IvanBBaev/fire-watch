import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import type { IncidentEntryVersion } from '../../core/staff/incident-log-workflow.js';
import { createPgIncidentLogStore, INCIDENT_LOG_SQL } from './pg-incident-log-store.js';
import { STAFF_SQL, type PgStaffClient } from './pg-staff-store.js';

const AT = epochMsFromIso('2026-10-22T08:00:00Z');
const ENTRY = '26262626-0000-4000-8000-0000000000e1';
const ED = '26262626-0000-4000-8000-000000000001';
const REVIEWER = '26262626-0000-4000-8000-000000000002';

const SQL = { ...INCIDENT_LOG_SQL, insertAudit: STAFF_SQL.insertAudit };
type Answer = { rows: Record<string, unknown>[]; rowCount: number } | Error;

function stubPool(answers: Partial<Record<keyof typeof SQL, Answer>> = {}) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const byText = new Map<string, Answer>();
  for (const [key, answer] of Object.entries(answers))
    byText.set(SQL[key as keyof typeof SQL], answer);
  const query = <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) => {
    queries.push({ text, values });
    const answer = byText.get(text);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      rows: (answer?.rows ?? []) as Row[],
      rowCount: answer?.rowCount ?? 1,
    });
  };
  const client: PgStaffClient = { query, release: () => undefined };
  const keyOf = new Map<string, string>(Object.entries(SQL).map(([key, text]) => [text, key]));
  return {
    queries,
    trace: () => queries.map((q) => keyOf.get(q.text) ?? q.text),
    pool: { query, connect: () => Promise.resolve(client) },
  };
}

function versionRow(version: number, status: string, contributors = [ED]) {
  return {
    entry_id: ENTRY,
    version,
    status,
    triggers_notifications: false,
    major: false,
    content: { title: 'Outage' },
    updated_at: new Date(AT),
    published_at: status === 'published' ? new Date(AT) : null,
    contributor_ids: contributors,
  };
}

function next(
  version: number,
  status: IncidentEntryVersion['status'],
  contributorIds = [ED],
): IncidentEntryVersion {
  return {
    entryId: ENTRY,
    version,
    status,
    contributorIds,
    triggersNotifications: false,
    major: false,
  };
}

function audit(stub: ReturnType<typeof stubPool>): readonly unknown[] {
  const row = stub.queries.find((q) => q.text === SQL.insertAudit);
  if (row === undefined) throw new Error('no audit row');
  return row.values;
}

describe('createPgIncidentLogStore', () => {
  it('starts an entry: entry, version 1, contributors, audit — no before state', async () => {
    const stub = stubPool();
    const result = await createPgIncidentLogStore(stub.pool).write({
      expected: null,
      next: next(1, 'draft'),
      content: { title: 'Outage' },
      action: 'incident.edit',
      context: { actorId: ED, at: AT },
    });
    expect(result).toEqual({ kind: 'written' });
    expect(stub.trace()).toEqual([
      'BEGIN',
      'insertEntry',
      'insertVersion',
      'insertContributors',
      'insertAudit',
      'COMMIT',
    ]);
    const values = audit(stub);
    expect(values.slice(0, 4)).toEqual([ED, 'incident.edit', 'incident_log_entry', ENTRY]);
    expect(values[4]).toBeNull();
    expect(values[5]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a conflict when the entry id already exists', async () => {
    const stub = stubPool({ insertEntry: { rows: [], rowCount: 0 } });
    const result = await createPgIncidentLogStore(stub.pool).write({
      expected: null,
      next: next(1, 'draft'),
      content: {},
      action: 'incident.edit',
      context: { actorId: ED, at: AT },
    });
    expect(result).toEqual({ kind: 'conflict' });
    expect(stub.trace()).toEqual(['BEGIN', 'insertEntry', 'COMMIT']);
  });

  it('updates an open version in place, guarded by the status the caller saw', async () => {
    const stub = stubPool({ findLatest: { rows: [versionRow(1, 'in_review')], rowCount: 1 } });
    const result = await createPgIncidentLogStore(stub.pool).write({
      expected: { version: 1, status: 'in_review' },
      next: next(1, 'published'),
      action: 'incident.publish',
      context: { actorId: REVIEWER, at: AT },
    });
    expect(result).toEqual({ kind: 'written' });
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockEntry',
      'findLatest',
      'updateVersion',
      'insertContributors',
      'insertAudit',
      'COMMIT',
    ]);
    const update = stub.queries.find((q) => q.text === SQL.updateVersion);
    expect(update?.values.slice(0, 4)).toEqual([ENTRY, 1, 'in_review', 'published']);
    expect(update?.values[6]).toBeNull();
    const values = audit(stub);
    expect(values[4]).toMatch(/^[0-9a-f]{64}$/);
    expect(values[5]).toMatch(/^[0-9a-f]{64}$/);
    expect(values[4]).not.toBe(values[5]);
  });

  it('writes nothing when the latest version is not the one the caller decided from', async () => {
    const stub = stubPool({ findLatest: { rows: [versionRow(2, 'draft')], rowCount: 1 } });
    const result = await createPgIncidentLogStore(stub.pool).write({
      expected: { version: 1, status: 'published' },
      next: next(2, 'draft'),
      content: {},
      action: 'incident.edit',
      context: { actorId: ED, at: AT },
    });
    expect(result).toEqual({ kind: 'conflict' });
    expect(stub.trace()).toEqual(['BEGIN', 'lockEntry', 'findLatest', 'COMMIT']);
  });

  it('reports a conflict when the guarded update matched no row', async () => {
    const stub = stubPool({
      findLatest: { rows: [versionRow(1, 'draft')], rowCount: 1 },
      updateVersion: { rows: [], rowCount: 0 },
    });
    const result = await createPgIncidentLogStore(stub.pool).write({
      expected: { version: 1, status: 'draft' },
      next: next(1, 'in_review'),
      action: 'incident.submit',
      context: { actorId: ED, at: AT },
    });
    expect(result).toEqual({ kind: 'conflict' });
  });

  it('revises a published version as a new row and never updates the published one', async () => {
    const stub = stubPool({ findLatest: { rows: [versionRow(1, 'published')], rowCount: 1 } });
    await createPgIncidentLogStore(stub.pool).write({
      expected: { version: 1, status: 'published' },
      next: next(2, 'draft', [REVIEWER]),
      content: { title: 'Outage (corrected)' },
      action: 'incident.edit',
      context: { actorId: REVIEWER, at: AT },
    });
    expect(stub.trace()).not.toContain('updateVersion');
    expect(stub.trace()).toContain('insertVersion');
    expect(audit(stub)[4]).toBeNull();
  });

  it('refuses a revision without content or with the wrong number', async () => {
    const stub = stubPool({ findLatest: { rows: [versionRow(1, 'published')], rowCount: 1 } });
    const store = createPgIncidentLogStore(stub.pool);
    const base = {
      expected: { version: 1, status: 'published' as const },
      action: 'incident.edit' as const,
      context: { actorId: ED, at: AT },
    };
    await expect(store.write({ ...base, next: next(2, 'draft') })).rejects.toThrow(/content/);
    await expect(store.write({ ...base, next: next(3, 'draft'), content: {} })).rejects.toThrow(
      /next version/,
    );
    expect(stub.trace().filter((t) => t === 'ROLLBACK')).toHaveLength(2);
  });

  it('decodes versions with their contributors in first-touch order', async () => {
    const stub = stubPool({
      findLatest: { rows: [versionRow(1, 'draft', [REVIEWER, ED])], rowCount: 1 },
    });
    const latest = await createPgIncidentLogStore(stub.pool).findLatest(ENTRY);
    expect(latest).toEqual({
      version: next(1, 'draft', [REVIEWER, ED]),
      content: { title: 'Outage' },
      updatedAt: AT,
      publishedAt: null,
    });
    expect(INCIDENT_LOG_SQL.findLatest).toContain('ORDER BY c.position');
  });
});
