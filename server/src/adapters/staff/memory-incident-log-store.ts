/**
 * An in-memory `IncidentLogStore` with the Postgres store's write rules (TASKS L15).
 *
 * It exists for the curated-correction rehearsal (`pnpm curation-rehearsal`) and for unit
 * tests that need a store with the real semantics rather than a stub: a write is a
 * compare-and-set on (version, status, edit counter); a write whose `expected` is published
 * opens version N+1 and leaves the published row untouched; a published row is frozen
 * (026's trigger); and every write appends its audit record. The Postgres store
 * (`pg-incident-log-store.ts`) is the production one, and the integration test runs the
 * same rehearsal against it.
 *
 * Not for production: nothing here survives the process.
 */

import { isoFromEpochMs } from '../../core/ports/clock.js';
import type {
  IncidentLogStore,
  IncidentVersionWrite,
  StoredIncidentVersion,
} from '../../core/ports/staff-stores.js';
import type { StaffAuditAction } from '../../core/staff/staff-audit.js';

export interface MemoryAuditRow {
  readonly actorId: string;
  readonly action: StaffAuditAction;
  readonly entityId: string;
  readonly version: number;
  readonly status: string;
  readonly atIso: string;
}

export interface MemoryIncidentLogStore extends IncidentLogStore {
  /** The audit trail, oldest first. */
  audit(): readonly MemoryAuditRow[];
}

export function createMemoryIncidentLogStore(): MemoryIncidentLogStore {
  const entries = new Map<string, StoredIncidentVersion[]>();
  const trail: MemoryAuditRow[] = [];

  const latest = (entryId: string): StoredIncidentVersion | null => {
    const versions = entries.get(entryId);
    return versions?.[versions.length - 1] ?? null;
  };

  return {
    findLatest(entryId) {
      return Promise.resolve(latest(entryId));
    },

    listPublished(entryId) {
      return Promise.resolve(
        (entries.get(entryId) ?? []).filter((row) => row.version.status === 'published'),
      );
    },

    write(input: IncidentVersionWrite) {
      const current = latest(input.next.entryId);
      const { at } = input.context;
      const publishedAt = input.next.status === 'published' ? at : null;
      if (input.expected === null) {
        if (current !== null || input.content === undefined || input.next.version !== 1) {
          return Promise.resolve({ kind: 'conflict' as const });
        }
        entries.set(input.next.entryId, [
          { version: input.next, content: input.content, editSeq: 0, updatedAt: at, publishedAt },
        ]);
      } else {
        if (
          current === null ||
          current.version.version !== input.expected.version ||
          current.version.status !== input.expected.status ||
          current.editSeq !== input.expected.editSeq
        ) {
          return Promise.resolve({ kind: 'conflict' as const });
        }
        const versions = entries.get(input.next.entryId) ?? [];
        if (current.version.status === 'published') {
          // A revision: version N+1 beside the frozen published row.
          if (input.next.version !== current.version.version + 1 || input.content === undefined) {
            return Promise.resolve({ kind: 'conflict' as const });
          }
          versions.push({
            version: input.next,
            content: input.content,
            editSeq: 0,
            updatedAt: at,
            publishedAt,
          });
        } else {
          if (input.next.version !== current.version.version) {
            return Promise.resolve({ kind: 'conflict' as const });
          }
          versions[versions.length - 1] = {
            version: input.next,
            content: input.content ?? current.content,
            editSeq: current.editSeq + 1,
            updatedAt: at,
            publishedAt,
          };
        }
      }
      trail.push({
        actorId: input.context.actorId,
        action: input.action,
        entityId: input.next.entryId,
        version: input.next.version,
        status: input.next.status,
        atIso: isoFromEpochMs(at),
      });
      return Promise.resolve({ kind: 'written' as const });
    },

    audit() {
      return [...trail];
    },
  };
}
