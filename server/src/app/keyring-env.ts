/**
 * Reads an AES-256 keyring from three environment variables — an active key id, the active
 * key (standard base64 of exactly 32 bytes) and an optional `id:base64,id:base64` list of
 * decrypt-only retired keys. Shared by the zone-centre keyring (`zones-config.ts`, TASKS
 * I2) and the staff TOTP keyring (`staff-totp-config.ts`, TASKS I1); each module documents
 * its own variables and what an unset keyring means for its process.
 *
 * Unset returns `null`. Retired keys without an active key are refused: such a keyring
 * could open but never seal, which is a configuration nobody meant. Repeated ids are
 * refused: two keys under one id would make the stored key id meaningless.
 *
 * **No value ever reaches an error.** Every message names a variable, never its content —
 * not the key, and not a key id either, since a pasted secret in the wrong variable is
 * exactly the mistake these messages report.
 */

import { KEY_ID_RE } from '../adapters/crypto/aes-gcm-zone-cipher.js';
import type { Environment } from './config.js';
import { ConfigError } from './config.js';

export interface EnvKey {
  readonly id: string;
  readonly key: Uint8Array;
}

export interface EnvKeyring {
  readonly active: EnvKey;
  readonly retired: readonly EnvKey[];
}

export interface KeyringVariables {
  readonly id: string;
  readonly key: string;
  readonly retired: string;
}

const KEY_BYTES = 32;

/**
 * Canonical standard base64 with padding. Node's decoder silently skips characters outside
 * the alphabet, so a key with a stray character would decode to *some* 32 bytes that are
 * not the key: the shape is checked before decoding, and the length after.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function readKeyringEnv(env: Environment, names: KeyringVariables): EnvKeyring | null {
  const active = readGroup(env, [names.id, names.key] as const);
  const retiredText = env[names.retired]?.trim() ?? '';
  if (active === null) {
    if (retiredText !== '') {
      throw new ConfigError(`${names.retired} is set but ${names.id} is not`);
    }
    return null;
  }

  const activeKey = readKey(active[names.id] ?? '', active[names.key] ?? '', {
    id: names.id,
    key: names.key,
  });
  const retired = retiredText === '' ? [] : readRetired(retiredText, names.retired);

  const ids = new Set<string>([activeKey.id]);
  for (const key of retired) {
    if (ids.has(key.id)) {
      // Two keys under one id would make `open` pick one of them by position; the row's
      // key id would stop meaning anything.
      throw new ConfigError(`${names.retired} repeats a key id, or repeats the active one`);
    }
    ids.add(key.id);
  }
  return { active: activeKey, retired };
}

function readRetired(text: string, variable: string): EnvKey[] {
  return text.split(',').map((entry, index) => {
    const separator = entry.indexOf(':');
    if (separator < 0) {
      throw new ConfigError(`${variable} entry ${index + 1} is not <id>:<base64 key>`);
    }
    return readKey(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim(), {
      id: `${variable} entry ${index + 1} id`,
      key: `${variable} entry ${index + 1} key`,
    });
  });
}

function readKey(
  id: string,
  base64: string,
  names: { readonly id: string; readonly key: string },
): EnvKey {
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
