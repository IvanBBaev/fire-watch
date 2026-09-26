/**
 * Where a nightly backup artifact lives in the bucket (TASKS C6; OPERATIONS §6.2).
 *
 *   fw-main/daily/2026/09/23/fire-watch-main-20260923T022000Z.dump.age
 *   fw-main/weekly/2026/09/20/fire-watch-main-20260920T022000Z.dump.age
 *   fw-personal/daily/2026/09/23/fire-watch-personal-20260923T022000Z.dump.age
 *
 * One prefix per (set, tier), because retention is enforced by **R2 lifecycle rules**, not
 * by this job (§6.2: the backup token is write-only, so the VM cannot delete), and a
 * lifecycle rule selects by prefix. The date path is for the operator reading a listing;
 * the timestamp in the file name is the one the restore trusts.
 *
 * The two sets of one night share a timestamp: they come from one exported snapshot, and
 * the restore pairs them by it (a main artifact's personal companion is the key with the
 * set swapped). The prefix names are OPERATIONS §6.2's, verbatim.
 *
 * Pure: the instant arrives as a number; no clock is read here.
 */

import type { EpochMs } from '../ports/clock.js';

export const BACKUP_SETS = ['main', 'personal'] as const;
export type BackupSet = (typeof BACKUP_SETS)[number];

export const BACKUP_TIERS = ['daily', 'weekly', 'monthly'] as const;
export type BackupTierName = (typeof BACKUP_TIERS)[number];

/** The bucket prefix of each set, as OPERATIONS §6.2 and `ERASURE_HORIZON` name them. */
export const SET_PREFIX: Readonly<Record<BackupSet, string>> = {
  main: 'fw-main',
  personal: 'fw-personal',
};

export const ARTIFACT_SUFFIX = '.dump.age';

export interface BackupObjectKey {
  readonly set: BackupSet;
  readonly tier: BackupTierName;
  /** Second precision, UTC: the instant the snapshot was exported. */
  readonly takenAtMs: EpochMs;
  readonly key: string;
}

/** `YYYYMMDDTHHMMSSZ`, UTC — the shell job's `date -u +%Y%m%dT%H%M%SZ`, kept for continuity. */
export function backupTimestamp(ms: EpochMs): string {
  if (!Number.isFinite(ms)) {
    throw new RangeError(`backup instant must be finite, got ${String(ms)}`);
  }
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

export function parseBackupTimestamp(text: string): EpochMs | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  // Round-trip, so 20260231T… (a date Date.UTC would roll into March) is refused.
  return backupTimestamp(ms) === text ? ms : null;
}

export function backupObjectKey(
  set: BackupSet,
  tier: BackupTierName,
  takenAtMs: EpochMs,
): BackupObjectKey {
  const stamp = backupTimestamp(takenAtMs);
  const datePath = `${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/${stamp.slice(6, 8)}`;
  const takenAt = parseBackupTimestamp(stamp) ?? takenAtMs;
  return {
    set,
    tier,
    takenAtMs: takenAt,
    key: `${SET_PREFIX[set]}/${tier}/${datePath}/${artifactFileName(set, takenAt)}`,
  };
}

export function artifactFileName(set: BackupSet, takenAtMs: EpochMs): string {
  return `fire-watch-${set}-${backupTimestamp(takenAtMs)}${ARTIFACT_SUFFIX}`;
}

const KEY_RE =
  /^(fw-main|fw-personal)\/(daily|weekly|monthly)\/(\d{4})\/(\d{2})\/(\d{2})\/fire-watch-(main|personal)-(\d{8}T\d{6}Z)\.dump\.age$/;

/**
 * The inverse of {@link backupObjectKey}, strict: a key whose prefix, file name and date
 * path disagree is not ours, and `null` — the retention audit reports it rather than
 * guessing which half to believe.
 */
export function parseBackupObjectKey(key: string): BackupObjectKey | null {
  const match = KEY_RE.exec(key);
  if (match === null) return null;
  const [, prefix, tier, , , , set, stamp] = match;
  if (prefix === undefined || tier === undefined || set === undefined || stamp === undefined) {
    return null;
  }
  const takenAtMs = parseBackupTimestamp(stamp);
  if (takenAtMs === null) return null;
  const parsedSet = set as BackupSet;
  if (SET_PREFIX[parsedSet] !== prefix) return null;
  const rebuilt = backupObjectKey(parsedSet, tier as BackupTierName, takenAtMs);
  return rebuilt.key === key ? rebuilt : null;
}

/** The same night's artifact of the other set: one snapshot, two keys. */
export function companionKey(key: BackupObjectKey, set: BackupSet): BackupObjectKey {
  return backupObjectKey(set, key.tier, key.takenAtMs);
}

/** The listing prefix of one (set, tier), with the trailing slash a lifecycle rule needs. */
export function tierPrefix(set: BackupSet, tier: BackupTierName): string {
  return `${SET_PREFIX[set]}/${tier}/`;
}
