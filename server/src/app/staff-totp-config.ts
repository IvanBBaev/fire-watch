/**
 * The staff TOTP keyring, read from the environment (TASKS I1; 05 C3, §5.4.3).
 *
 * The key seals each staff member's TOTP secret (`aes-gcm-totp-sealer.ts`); the database
 * holds only the sealed bytes and the key's id (`staff_totp_factors.secret_key_id`,
 * migration 026; a pending enrollment's `staff_sessions.challenge_key_id`, migration 031).
 * In its own module, like the zone keyring, so that only the process serving the staff
 * plane is ever handed it.
 *
 *   * FIRE_WATCH_STAFF_TOTP_KEY_ID + FIRE_WATCH_STAFF_TOTP_KEY — the active key, set
 *     together or not at all: an id (`[A-Za-z0-9_.-]{1,64}`) and standard base64 of
 *     exactly 32 bytes.
 *   * FIRE_WATCH_STAFF_TOTP_KEYS_RETIRED — optional, `id:base64,id:base64`. Open-only keys
 *     for secrets sealed before a rotation; refused without an active key.
 *
 * Unset returns `null`: the staff plane then offers no TOTP (neither enrollment nor
 * sign-in) — it never stores a secret unsealed. Parsing and its never-quote-a-value
 * messages are `keyring-env.ts`'s, shared with the zone keyring.
 */

import type { StaffTotpKeyring } from '../adapters/crypto/aes-gcm-totp-sealer.js';
import type { Environment } from './config.js';
import { readKeyringEnv } from './keyring-env.js';

export function loadStaffTotpConfig(env: Environment): StaffTotpKeyring | null {
  return readKeyringEnv(env, {
    id: 'FIRE_WATCH_STAFF_TOTP_KEY_ID',
    key: 'FIRE_WATCH_STAFF_TOTP_KEY',
    retired: 'FIRE_WATCH_STAFF_TOTP_KEYS_RETIRED',
  });
}

/** Safe to print: key ids are labels; the keys themselves never leave the keyring. */
export function describeStaffTotpConfig(keyring: StaffTotpKeyring | null): Record<string, unknown> {
  if (keyring === null) return { staff_totp_keys: 'unset' };
  return {
    staff_totp_key_active: keyring.active.id,
    staff_totp_keys_retired: keyring.retired.map((key) => key.id),
  };
}
