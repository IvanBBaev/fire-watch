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
 * prints key ids only, which are labels, not secrets.
 */

import {
  KEY_ID_RE,
  type ZoneKey,
  type ZoneKeyring,
} from '../adapters/crypto/aes-gcm-zone-cipher.js';
import type { Environment } from './config.js';
import { ConfigError } from './config.js';

const KEY_BYTES = 32;

/**
 * Canonical standard base64 with padding. Node's decoder silently skips characters outside
 * the alphabet, so a key with a stray character would decode to *some* 32 bytes that are
 * not the key: the shape is checked before decoding, and the length after.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const ACTIVE_GROUP = ['FIRE_WATCH_ZONE_KEY_ID', 'FIRE_WATCH_ZONE_KEY'] as const;
const RETIRED = 'FIRE_WATCH_ZONE_KEYS_RETIRED';

export function loadZonesConfig(env: Environment): ZoneKeyring | null {
  const active = readGroup(env, ACTIVE_GROUP);
  const retiredText = env[RETIRED]?.trim() ?? '';
  if (active === null) {
    if (retiredText !== '') {
      throw new ConfigError(`${RETIRED} is set but FIRE_WATCH_ZONE_KEY_ID is not`);
    }
    return null;
  }

  const activeKey = readKey(active.FIRE_WATCH_ZONE_KEY_ID, active.FIRE_WATCH_ZONE_KEY, {
    id: 'FIRE_WATCH_ZONE_KEY_ID',
    key: 'FIRE_WATCH_ZONE_KEY',
  });
  const retired = retiredText === '' ? [] : readRetired(retiredText);

  const ids = new Set<string>([activeKey.id]);
  for (const key of retired) {
    if (ids.has(key.id)) {
      // Two keys under one id would make `open` pick one of them by position; the row's
      // key id would stop meaning anything.
      throw new ConfigError(`${RETIRED} repeats a key id, or repeats the active one`);
    }
    ids.add(key.id);
  }
  return { active: activeKey, retired };
}

/** Safe to print: key ids are labels; the keys themselves never leave the keyring. */
export function describeZonesConfig(keyring: ZoneKeyring | null): Record<string, unknown> {
  if (keyring === null) return { zone_keys: 'unset' };
  return {
    zone_key_active: keyring.active.id,
    zone_keys_retired: keyring.retired.map((key) => key.id),
  };
}

function readRetired(text: string): ZoneKey[] {
  return text.split(',').map((entry, index) => {
    const separator = entry.indexOf(':');
    if (separator < 0) {
      throw new ConfigError(`${RETIRED} entry ${index + 1} is not <id>:<base64 key>`);
    }
    return readKey(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim(), {
      id: `${RETIRED} entry ${index + 1} id`,
      key: `${RETIRED} entry ${index + 1} key`,
    });
  });
}

function readKey(
  id: string,
  base64: string,
  names: { readonly id: string; readonly key: string },
): ZoneKey {
  if (!KEY_ID_RE.test(id)) {
    throw new ConfigError(`${names.id} must be 1-64 of letters, digits, '_', '.', '-'`);
  }
  if (!BASE64_RE.test(base64) || base64.length % 4 !== 0) {
    throw new ConfigError(`${names.key} must be standard padded base64`);
  }
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new ConfigError(`${names.key} must decode to exactly ${KEY_BYTES} bytes`);
  }
  return { id, key: new Uint8Array(key) };
}

// Local copy of app/config.ts's unexported helper (same behavior, verbatim rules): a group
// is all present or all absent, and a partial group names only the variables missing.
function readGroup<const Names extends readonly string[]>(
  env: Environment,
  names: Names,
): Readonly<Record<Names[number], string>> | null {
  const present: Partial<Record<Names[number], string>> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value === undefined || value === '') missing.push(name);
    else present[name as Names[number]] = value;
  }
  if (missing.length === names.length) return null;
  if (missing.length > 0) {
    throw new ConfigError(
      `${names.join(', ')} are configured together or not at all; missing: ${missing.join(', ')}`,
    );
  }
  return present as Readonly<Record<Names[number], string>>;
}
