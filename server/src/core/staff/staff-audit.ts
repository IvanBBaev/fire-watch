/**
 * The staff audit record (TASKS I1; 05 §5.4.3, C4, T2/T7).
 *
 * 05 fixes the columns: actor, action, entity, before/after hash, IP, time. This module
 * builds that row from the action's inputs so every staff route records the same shape,
 * and so the hashes are reproducible: a state is hashed as its canonical JSON (ADR-002 D7),
 * so the same entity state always yields the same hash regardless of how the code that
 * built it ordered its keys. That is what makes the trail tamper-*evident* — a later
 * reader can re-hash the version a public page shows and compare it with the `after_hash`
 * recorded when it was published.
 *
 * The table is append-only; nothing here models an update or a delete of a record. SHA-256
 * is a port ({@link Sha256Hex}) because the core cannot import `node:crypto`.
 */

import { canonicalJson } from '../determinism/canonical-json.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import { STAFF_ACTIONS } from './staff-policy.js';

/** Lower-case hex SHA-256 of the UTF-8 bytes of `text`. */
export type Sha256Hex = (text: string) => string;

/**
 * What a staff action did, named for the trail. Superset of the permissioned
 * `StaffAction`s: signing in and enrolling a factor are audited too, and they are
 * not permissions.
 */
export const STAFF_AUDIT_ACTIONS = [
  ...STAFF_ACTIONS,
  'staff.sign_in',
  'staff.sign_out',
  'staff.second_factor_enrolled',
  'staff.second_factor_removed',
  'staff.recovery_code_used',
  'incident.edit',
  'incident.submit',
  'incident.reject',
] as const;
export type StaffAuditAction = (typeof STAFF_AUDIT_ACTIONS)[number];

export interface StaffAuditInput {
  readonly actorId: string;
  readonly action: StaffAuditAction;
  readonly entity: { readonly kind: string; readonly id: string };
  /** The entity's state before the action; absent for a creation. */
  readonly before?: unknown;
  /** The entity's state after the action; absent for a deletion. */
  readonly after?: unknown;
  /** The client address as the edge reported it; absent when the action has none (a CLI). */
  readonly ip?: string;
  readonly at: EpochMs;
}

export interface StaffAuditRecord {
  readonly actorId: string;
  readonly action: StaffAuditAction;
  readonly entityKind: string;
  readonly entityId: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly ip: string | null;
  readonly atIso: string;
}

export function hashEntityState(state: unknown, sha256Hex: Sha256Hex): string {
  return sha256Hex(canonicalJson(state));
}

export function buildStaffAuditRecord(
  input: StaffAuditInput,
  sha256Hex: Sha256Hex,
): StaffAuditRecord {
  if (input.actorId.length === 0) throw new TypeError('a staff audit record needs an actor');
  if (input.entity.kind.length === 0 || input.entity.id.length === 0) {
    throw new TypeError('a staff audit record needs an entity kind and id');
  }
  return {
    actorId: input.actorId,
    action: input.action,
    entityKind: input.entity.kind,
    entityId: input.entity.id,
    beforeHash: input.before === undefined ? null : hashEntityState(input.before, sha256Hex),
    afterHash: input.after === undefined ? null : hashEntityState(input.after, sha256Hex),
    ip: input.ip ?? null,
    atIso: isoFromEpochMs(input.at),
  };
}
