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
 * secret); the stores never see a code or a key. WebAuthn credentials (migration 027) are
 * public keys and cross as the authenticator's own COSE bytes.
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

/** COSE algorithm of a stored credential: ES256, EdDSA or RS256 (`webauthn.ts`). */
export type StoredWebAuthnAlgorithm = -7 | -8 | -257;

/** A registered authenticator, as `verifyRegistration` accepted it. */
export interface NewWebAuthnCredential {
  readonly credentialId: Uint8Array;
  readonly publicKeyCose: Uint8Array;
  readonly algorithm: StoredWebAuthnAlgorithm;
  readonly signCount: number;
  readonly backupEligible: boolean;
  /** The member's own name for the key, shown when choosing one. */
  readonly label: string;
}

export interface StoredWebAuthnCredential extends NewWebAuthnCredential {
  readonly staffId: string;
  readonly enrolledAt: EpochMs;
  readonly lastUsedAt: EpochMs | null;
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

  /**
   * Registers a WebAuthn credential and audits it in one transaction. `recoveryCodeHashes`
   * replaces the member's recovery-code set when given (a member whose first factor is a
   * passkey still gets codes printed at enrollment); null keeps the current set.
   * `credential_taken` when the credential id is already registered to anyone.
   */
  enrollWebAuthnCredential(
    staffId: string,
    credential: NewWebAuthnCredential,
    recoveryCodeHashes: readonly Uint8Array[] | null,
    context: StaffActionContext,
  ): Promise<{ readonly kind: 'enrolled' | 'credential_taken' }>;

  /** A live member's credentials, oldest first; empty for a disabled member. */
  listWebAuthnCredentials(staffId: string): Promise<readonly StoredWebAuthnCredential[]>;

  /** The credential an assertion names, or null when unknown or its member is disabled. */
  findWebAuthnCredential(credentialId: Uint8Array): Promise<StoredWebAuthnCredential | null>;

  /**
   * The clone guard's write: stores `signCount` and the use time only if the counter still
   * advances (`signCountAdvances`). False when another assertion got there first, the
   * counter went backwards, or the member is disabled — the caller must refuse then.
   */
  advanceWebAuthnSignCount(
    credentialId: Uint8Array,
    signCount: number,
    at: EpochMs,
  ): Promise<boolean>;

  appendAudit(record: StaffAuditRecord): Promise<void>;
}

export interface StoredIncidentVersion {
  readonly version: IncidentEntryVersion;
  readonly content: Readonly<Record<string, unknown>>;
  /**
   * How many times this version row was updated in place (migration 028). An edit that
   * keeps a draft a draft changes neither number nor status, so the CAS needs this too.
   */
  readonly editSeq: number;
  readonly updatedAt: EpochMs;
  readonly publishedAt: EpochMs | null;
}

export interface IncidentVersionWrite {
  /**
   * The latest version the caller decided from, or null for a new entry. The write is a
   * compare-and-set on it (number, status and `editSeq`, all as `findLatest` returned
   * them): if the entry has moved on, nothing is written.
   */
  readonly expected: {
    readonly version: number;
    readonly status: IncidentEntryStatus;
    readonly editSeq: number;
  } | null;
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
