/**
 * Ports for the staff plane's storage (TASKS I1; 05 C3, C4, §5.4.3; migration 026).
 *
 * Two stores, because they hold two kinds of thing: {@link StaffStore} keeps the people
 * (members, roles, second factors) and the audit trail; {@link IncidentLogStore} keeps the
 * incident log's versions. Every write that changes state appends its audit row in the
 * same transaction, so an action that took effect is always on the trail and an action on
 * the trail always took effect.
 *
 * Secrets cross these ports only as hashes (recovery codes) or sealed bytes (the TOTP
 * secret); the stores never see a code or a key.
 */

import type { IncidentEntryStatus, IncidentEntryVersion } from '../staff/incident-log-workflow.js';
import type { StaffAuditAction, StaffAuditRecord } from '../staff/staff-audit.js';
import type { StaffRole } from '../staff/staff-policy.js';
import type { EpochMs } from './clock.js';

/** Who did it, from where, and when — the audit row's context for a store write. */
export interface StaffActionContext {
  readonly actorId: string;
  readonly ip?: string;
  readonly at: EpochMs;
}

export interface StaffMember {
  readonly staffId: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly StaffRole[];
  readonly disabled: boolean;
}

/** Sealed outside the database; `keyId` names the key, never holds it. */
export interface SealedSecret {
  readonly ciphertext: Uint8Array;
  readonly keyId: string;
}

export type StoredTotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface StoredTotpFactor {
  readonly sealed: SealedSecret;
  readonly algorithm: StoredTotpAlgorithm;
  /** The highest step accepted so far; null before the first use. */
  readonly lastUsedStep: number | null;
}

export interface StaffStore {
  /**
   * Adds a member with their roles. `context.actorId` is the admin doing it; `null` is the
   * bootstrap of the very first member (a CLI on the host), recorded as the member's own
   * action because the trail has no actor outside the staff table.
   */
  createMember(
    member: {
      readonly email: string;
      readonly displayName: string;
      readonly roles: readonly StaffRole[];
    },
    context: Omit<StaffActionContext, 'actorId'> & { readonly actorId: string | null },
  ): Promise<
    { readonly kind: 'created'; readonly staffId: string } | { readonly kind: 'email_taken' }
  >;

  findMember(staffId: string): Promise<StaffMember | null>;

  /**
   * Enrolls (or re-enrolls) the TOTP factor and replaces the recovery-code set in one
   * transaction: a member never holds codes printed for an older enrollment.
   */
  enrollTotp(
    staffId: string,
    factor: { readonly sealed: SealedSecret; readonly algorithm: StoredTotpAlgorithm },
    recoveryCodeHashes: readonly Uint8Array[],
    context: StaffActionContext,
  ): Promise<void>;

  /** Null when the member has no factor or is disabled. */
  findTotpFactor(staffId: string): Promise<StoredTotpFactor | null>;

  /**
   * The replay guard's write: moves `lastUsedStep` to `step` only if it is still below it.
   * False when another request already used this step or a later one, or the member is
   * disabled — the caller must then refuse the code, whatever `verifyTotp` said.
   */
  advanceTotpStep(staffId: string, step: number): Promise<boolean>;

  /** Marks one unused code used and audits it. False for an unknown, used or disabled one. */
  consumeRecoveryCode(
    staffId: string,
    codeHash: Uint8Array,
    context: Omit<StaffActionContext, 'actorId'>,
  ): Promise<boolean>;

  appendAudit(record: StaffAuditRecord): Promise<void>;
}

export interface StoredIncidentVersion {
  readonly version: IncidentEntryVersion;
  readonly content: Readonly<Record<string, unknown>>;
  readonly updatedAt: EpochMs;
  readonly publishedAt: EpochMs | null;
}

export interface IncidentVersionWrite {
  /**
   * The latest version the caller decided from, or null for a new entry. The write is a
   * compare-and-set on it: if the entry has moved on, nothing is written.
   */
  readonly expected: { readonly version: number; readonly status: IncidentEntryStatus } | null;
  /** The workflow's `next` (`incident-log-workflow.ts`). */
  readonly next: IncidentEntryVersion;
  /** Required when a version row is created; omitted keeps the stored text. */
  readonly content?: Readonly<Record<string, unknown>>;
  readonly action: StaffAuditAction;
  readonly context: StaffActionContext;
}

export interface IncidentLogStore {
  /** The entry's newest version, published or not. */
  findLatest(entryId: string): Promise<StoredIncidentVersion | null>;
  /** The public history: published versions, oldest first. */
  listPublished(entryId: string): Promise<readonly StoredIncidentVersion[]>;
  write(input: IncidentVersionWrite): Promise<{ readonly kind: 'written' | 'conflict' }>;
}
