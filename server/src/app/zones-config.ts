/**
 * The zone-centre keyring, read from the environment (TASKS I2; 05 §5.3.2 "key not in the
 * DB").
 *
 * In its own module rather than in `app/config.ts` because the API is the only process
 * that seals or opens a zone centre: the worker, the backfill and every CLI must be able to
 * boot without a key, and must never be handed one they have no use for.
 *
 * Three environment variables:
 *
 *   * FIRE_WATCH_ZONE_KEY_ID + FIRE_WATCH_ZONE_KEY — the active key, configured together or
 *     not at all. The id is what each row's `centre_key_id` names (migration 007 CHECKs
 *     the same shape as {@link KEY_ID_RE}); the key is standard base64 of exactly 32 bytes.
 *   * FIRE_WATCH_ZONE_KEYS_RETIRED — optional, `id:base64,id:base64`. Decrypt-only keys,
 *     kept until the re-encryption job (`zone-key-rotation-cli.ts`) has moved every row
 *     off them. Refused without an active key: a retired-only keyring could open centres but never
 *     seal one, which is a configuration nobody meant.
 *
 * Unset returns `null`, and the caller decides what a process without a keyring may do —
 * for the API that is "do not register the zone routes", never "store zones in clear".
 *
 * **No value ever reaches an error or a log line.** Every message below names a variable,
 * never its content — not the key, and not a key id either, since a pasted secret in the
 * wrong variable is exactly the mistake these messages report. {@link describeZonesConfig}
 * prints key ids only, which are labels, not secrets. The parsing is shared with the
 * staff TOTP keyring (`staff-totp-config.ts`) in `keyring-env.ts`.
 */

import type { ZoneKeyring } from '../adapters/crypto/aes-gcm-zone-cipher.js';
import type { Environment } from './config.js';
import { readKeyringEnv } from './keyring-env.js';

export function loadZonesConfig(env: Environment): ZoneKeyring | null {
  return readKeyringEnv(env, {
    id: 'FIRE_WATCH_ZONE_KEY_ID',
    key: 'FIRE_WATCH_ZONE_KEY',
    retired: 'FIRE_WATCH_ZONE_KEYS_RETIRED',
  });
}

/** Safe to print: key ids are labels; the keys themselves never leave the keyring. */
export function describeZonesConfig(keyring: ZoneKeyring | null): Record<string, unknown> {
  if (keyring === null) return { zone_keys: 'unset' };
  return {
    zone_key_active: keyring.active.id,
    zone_keys_retired: keyring.retired.map((key) => key.id),
  };
}
