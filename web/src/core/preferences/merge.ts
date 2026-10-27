/**
 * The cross-device merge rule (TASKS V2-C5): how this browser's preferences and the
 * account's synced copy become one, field by field. Pure — no storage, no request, no
 * signal — so the rule is exactly what this file says and what its tests pin.
 *
 * Three inputs, per field of {@link AccountPreferences}:
 *
 *   * `local` — what this browser has remembered (absent: never chosen here);
 *   * `remote` — what the server holds for the account (absent: never chosen on any
 *     synced device);
 *   * `base` — the copy this browser last agreed with the server on, or `null` when it
 *     never has (a first sync, a different account, a cleared base).
 *
 * **The rule.**
 *
 *   1. With a base, a field this browser changed since the last sync (`local ≠ base`,
 *      local present)
 *      keeps the local value: the reader's newest choice on this device is not undone by
 *      an older one from another device it already knew about.
 *   2. Otherwise the remote value wins when there is one — another device's choice since
 *      the last sync, or simply the account's standing choice.
 *   3. Otherwise the local value stays (the account never had one; this browser fills it).
 *
 * On a **first sync** there is no base, so rule 1 never fires: the account's copy wins
 * wherever it has a value and this browser fills only what the account lacks. That is the
 * conservative reading of "I signed in on a new device": the settings the reader built up
 * elsewhere arrive, and nothing this browser happened to have overwrites them.
 *
 * When both devices changed the same field since the last sync, the device that syncs
 * second wins (rule 1 on its side, then its write). Last writer wins, per field — never
 * per document, so two devices changing different fields both keep their change.
 *
 * A field this browser has no value for never counts as a change, so a merge never drops
 * a value either copy has: storage that failed to write, or a key a reader removed by
 * hand, does not erase the account's choice (it arrives back instead).
 *
 * Overlays compare as sets: their order means nothing (`layers.ts` canonicalises it).
 */

import type { AccountPreferenceField, AccountPreferences } from '@fire-watch/contracts';
import { ACCOUNT_PREFERENCE_FIELDS } from '@fire-watch/contracts';

type Value = AccountPreferences[AccountPreferenceField];

/** Two field values are the same choice; `undefined` is "never chosen". */
export function samePreferenceValue(a: Value, b: Value): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const left: readonly string[] = a;
    const right: readonly string[] = b;
    return left.length === right.length && left.every((entry) => right.includes(entry));
  }
  return a === b;
}

/** Every field the same choice in both. */
export function samePreferences(a: AccountPreferences, b: AccountPreferences): boolean {
  return ACCOUNT_PREFERENCE_FIELDS.every((field) => samePreferenceValue(a[field], b[field]));
}

/** The merged preferences under the rule above. */
export function mergePreferences(
  local: AccountPreferences,
  remote: AccountPreferences,
  base: AccountPreferences | null,
): AccountPreferences {
  const merged: Record<string, Value> = {};
  for (const field of ACCOUNT_PREFERENCE_FIELDS) {
    const value = mergeField(local[field], remote[field], base === null ? null : base[field]);
    if (value !== undefined)
      merged[field] = Array.isArray(value) ? [...(value as readonly string[])] : value;
  }
  return merged;
}

function mergeField(local: Value, remote: Value, base: Value | null): Value {
  if (base !== null && local !== undefined && !samePreferenceValue(local, base)) return local;
  return remote ?? local;
}

/** The fields whose value differs between two copies — what applying a merge changes. */
export function changedFields(
  from: AccountPreferences,
  to: AccountPreferences,
): readonly AccountPreferenceField[] {
  return ACCOUNT_PREFERENCE_FIELDS.filter((field) => !samePreferenceValue(from[field], to[field]));
}
