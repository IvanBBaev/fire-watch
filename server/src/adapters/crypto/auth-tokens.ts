/**
 * {@link AuthTokens} over `node:crypto` (TASKS I1; 05 §5.4.1).
 *
 * A token is 32 bytes from the CSPRNG, base64url without padding — 43 characters, safe in
 * a URL fragment and a cookie value without escaping. What is stored is its SHA-256.
 *
 * **Why a plain hash and not a salted, slow one.** A slow hash (argon2, bcrypt) protects a
 * *low-entropy* secret — a password — from offline guessing. A 256-bit random token has
 * nothing to guess; SHA-256 of it is as unrecoverable as the token is unguessable, and a
 * plain hash is what lets the lookup be a unique-index equality instead of a scan.
 *
 * `hash` refuses anything that is not exactly the shape `mint` produces, so a cookie
 * stuffed with a megabyte of junk is rejected before it is hashed or sent to Postgres.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AuthTokens, MintedToken } from '../../core/ports/auth-stores.js';

const TOKEN_BYTES = 32;

/** 32 bytes of base64url, unpadded. */
export const AUTH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function createAuthTokens(
  options: { readonly randomBytes?: (bytes: number) => Uint8Array } = {},
): AuthTokens {
  const random = options.randomBytes ?? randomBytes;
  const hash = (token: string): Uint8Array =>
    new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
  return {
    mint(): MintedToken {
      const token = Buffer.from(random(TOKEN_BYTES)).toString('base64url');
      return { token, hash: hash(token) };
    },
    hash(token: string): Uint8Array | null {
      return AUTH_TOKEN_RE.test(token) ? hash(token) : null;
    },
    newId: () => randomUUID(),
  };
}
