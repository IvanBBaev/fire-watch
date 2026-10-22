/**
 * The incident log's versions over Postgres (TASKS I1; 05 C4; migration 026).
 *
 * The workflow (`core/staff/incident-log-workflow.ts`) decides; this store persists the
 * decision as a compare-and-set. A write names the latest version the caller decided from
 * (`expected`); the entry row is locked, the latest version re-read, and if it is not the
 * one the caller saw — number, status or edit counter (028) — nothing is written and the result is `conflict`. Two editors racing on
 * the same draft therefore cannot both win, and a review cannot publish text that changed
 * after the reviewer read it.
 *
 * Writes map onto rows like this:
 * - no `expected` → a new entry and its version 1;
 * - `expected` published → version N+1 (a revision; the published row is never touched —
 *   026's trigger would refuse it anyway);
 * - otherwise → the same version row, updated in place.
 *
 * Every write appends its staff audit row in the same transaction. The audited state is the
 * version's full public shape (status, flags, content, contributors), so a reader can
 * re-hash a published version and compare it with the trail's `after_hash`.
 */

import { isoFromEpochMs } from '../../core/ports/clock.js';
import type {
  IncidentLogStore,
  IncidentVersionWrite,
  StoredIncidentVersion,
} from '../../core/ports/staff-stores.js';
import type {
  IncidentEntryStatus,
  IncidentEntryVersion,
} from '../../core/staff/incident-log-workflow.js';
import { buildStaffAuditRecord } from '../../core/staff/staff-audit.js';
import { boolean, epochMs, field, number, string } from './pg-rows.js';
import {
  inTransaction,
  insertAuditRecord,
  sha256Hex,
  type PgStaffPool,
  type PgStaffQueryable,
} from './pg-staff-store.js';

const VERSION_COLUMNS = `
  v.entry_id::text AS entry_id, v.version, v.status, v.triggers_notifications, v.major,
  v.content, v.edit_seq, v.updated_at, v.published_at,
  COALESCE(
    (SELECT array_agg(c.staff_id::text ORDER BY c.position)
     FROM incident_log_version_contributors c
     WHERE c.entry_id = v.entry_id AND c.version = v.version),
    '{}'
  ) AS contributor_ids`;

const FIND_LATEST = `
SELECT ${VERSION_COLUMNS}
FROM incident_log_versions v
WHERE v.entry_id = $1::uuid
ORDER BY v.version DESC
LIMIT 1`;

const LIST_PUBLISHED = `
SELECT ${VERSION_COLUMNS}
FROM incident_log_versions v
WHERE v.entry_id = $1::uuid AND v.status = 'published'
ORDER BY v.version`;

const LOCK_ENTRY = `SELECT 1 FROM incident_log_entries WHERE id = $1::uuid FOR UPDATE`;

const INSERT_ENTRY = `
INSERT INTO incident_log_entries (id, created_at)
VALUES ($1::uuid, $2::timestamptz)
ON CONFLICT (id) DO NOTHING`;

const INSERT_VERSION = `
INSERT INTO incident_log_versions
  (entry_id, version, status, triggers_notifications, major, content,
   created_at, updated_at, published_at)
VALUES ($1::uuid, $2::integer, $3::text, $4::boolean, $5::boolean, $6::jsonb,
        $7::timestamptz, $7::timestamptz,
        CASE WHEN $3::text = 'published' THEN $7::timestamptz END)`;

/**
 * `status = $3 AND edit_seq = $9` is the CAS: the row must still be in the state the
 * caller decided from, and every in-place update moves the counter on.
 */
const UPDATE_VERSION = `
UPDATE incident_log_versions
SET status = $4::text,
    edit_seq = edit_seq + 1,
    triggers_notifications = $5::boolean,
    major = $6::boolean,
    content = COALESCE($7::jsonb, content),
    updated_at = $8::timestamptz,
    published_at = CASE WHEN $4::text = 'published' THEN $8::timestamptz END
WHERE entry_id = $1::uuid AND version = $2::integer AND status = $3::text
  AND edit_seq = $9::integer`;

/** Contributors only accumulate, in first-touch order, so existing rows keep their place. */
const INSERT_CONTRIBUTORS = `
INSERT INTO incident_log_version_contributors (entry_id, version, staff_id, position)
SELECT $1::uuid, $2::integer, staff_id, (ord - 1)::integer
FROM unnest($3::uuid[]) WITH ORDINALITY AS t (staff_id, ord)
ON CONFLICT DO NOTHING`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const INCIDENT_LOG_SQL = {
  findLatest: FIND_LATEST,
  listPublished: LIST_PUBLISHED,
  lockEntry: LOCK_ENTRY,
  insertEntry: INSERT_ENTRY,
  insertVersion: INSERT_VERSION,
  updateVersion: UPDATE_VERSION,
  insertContributors: INSERT_CONTRIBUTORS,
} as const;

export const INCIDENT_LOG_ENTITY_KIND = 'incident_log_entry';

export function createPgIncidentLogStore(pool: PgStaffPool): IncidentLogStore {
  return {
    async findLatest(entryId) {
      const result = await pool.query(FIND_LATEST, [entryId]);
      const [row] = result.rows;
      return row === undefined ? null : decodeVersion(row);
    },

    async listPublished(entryId) {
      const result = await pool.query(LIST_PUBLISHED, [entryId]);
      return result.rows.map(decodeVersion);
    },

    write: (input) =>
      inTransaction(pool, async (client) => {
        const outcome = await writeVersion(client, input);
        return { kind: outcome };
      }),
  };
}

async function writeVersion(
  client: PgStaffQueryable,
  input: IncidentVersionWrite,
): Promise<'written' | 'conflict'> {
  const { expected, next, context } = input;
  const atIso = isoFromEpochMs(context.at);
  if (next.contributorIds.length === 0)
    throw new TypeError('a version has at least one contributor');

  let before: StoredIncidentVersion | null = null;
  if (expected === null) {
    if (next.version !== 1) throw new RangeError('a new entry starts at version 1');
    if (input.content === undefined) throw new TypeError('a new version needs its content');
    const created = await client.query(INSERT_ENTRY, [next.entryId, atIso]);
    if (created.rowCount !== 1) return 'conflict';
    await client.query(INSERT_VERSION, versionInsertValues(next, input.content, atIso));
  } else {
    const locked = await client.query(LOCK_ENTRY, [next.entryId]);
    if (locked.rowCount !== 1) return 'conflict';
    const latestResult = await client.query(FIND_LATEST, [next.entryId]);
    const [latestRow] = latestResult.rows;
    if (latestRow === undefined) return 'conflict';
    before = decodeVersion(latestRow);
    if (
      before.version.version !== expected.version ||
      before.version.status !== expected.status ||
      before.editSeq !== expected.editSeq
    ) {
      return 'conflict';
    }
    if (expected.status === 'published') {
      if (next.version !== expected.version + 1)
        throw new RangeError('a revision is the next version');
      if (input.content === undefined) throw new TypeError('a new version needs its content');
      await client.query(INSERT_VERSION, versionInsertValues(next, input.content, atIso));
    } else {
      if (next.version !== expected.version)
        throw new RangeError('an open version keeps its number');
      const updated = await client.query(UPDATE_VERSION, [
        next.entryId,
        next.version,
        expected.status,
        next.status,
        next.triggersNotifications,
        next.major,
        input.content === undefined ? null : JSON.stringify(input.content),
        atIso,
        expected.editSeq,
      ]);
      if (updated.rowCount !== 1) return 'conflict';
    }
  }

  await client.query(INSERT_CONTRIBUTORS, [next.entryId, next.version, [...next.contributorIds]]);

  const content = input.content ?? before?.content;
  if (content === undefined) throw new TypeError('a version needs its content');
  const revision = before !== null && before.version.version !== next.version;
  await insertAuditRecord(
    client,
    buildStaffAuditRecord(
      {
        actorId: context.actorId,
        action: input.action,
        entity: { kind: INCIDENT_LOG_ENTITY_KIND, id: next.entryId },
        // A revision's "before" is nothing: it is a new version row, and the published one
        // it follows is unchanged.
        ...(before === null || revision
          ? {}
          : { before: auditedState(before.version, before.content) }),
        after: auditedState(next, content),
        ...(context.ip === undefined ? {} : { ip: context.ip }),
        at: context.at,
      },
      sha256Hex,
    ),
  );
  return 'written';
}

/** The state the trail hashes: everything the public page could show about the version. */
export function auditedState(
  version: IncidentEntryVersion,
  content: Readonly<Record<string, unknown>>,
): unknown {
  return {
    entryId: version.entryId,
    version: version.version,
    status: version.status,
    triggersNotifications: version.triggersNotifications,
    major: version.major,
    content,
    contributorIds: version.contributorIds,
  };
}

function versionInsertValues(
  next: IncidentEntryVersion,
  content: Readonly<Record<string, unknown>>,
  atIso: string,
): readonly unknown[] {
  return [
    next.entryId,
    next.version,
    next.status,
    next.triggersNotifications,
    next.major,
    JSON.stringify(content),
    atIso,
  ];
}

const STATUSES: readonly IncidentEntryStatus[] = ['draft', 'in_review', 'published'];

function decodeVersion(row: Record<string, unknown>): StoredIncidentVersion {
  const status = string(field(row, 'status'), 'status');
  if (!(STATUSES as readonly string[]).includes(status))
    throw new Error('status holds an unknown value');
  const contributors = field(row, 'contributor_ids');
  if (!Array.isArray(contributors) || !contributors.every((id) => typeof id === 'string')) {
    throw new Error('contributor_ids is not a list of ids');
  }
  const content = field(row, 'content');
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new Error('content is not an object');
  }
  const publishedAt = field(row, 'published_at');
  return {
    version: {
      entryId: string(field(row, 'entry_id'), 'entry_id'),
      version: number(field(row, 'version'), 'version'),
      status: status as IncidentEntryStatus,
      contributorIds: contributors,
      triggersNotifications: boolean(
        field(row, 'triggers_notifications'),
        'triggers_notifications',
      ),
      major: boolean(field(row, 'major'), 'major'),
    },
    content: content as Record<string, unknown>,
    editSeq: number(field(row, 'edit_seq'), 'edit_seq'),
    updatedAt: epochMs(field(row, 'updated_at'), 'updated_at'),
    publishedAt: publishedAt === null ? null : epochMs(publishedAt, 'published_at'),
  };
}
