import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AUTH_TOKEN_RE, createAuthTokens } from './auth-tokens.js';

describe('createAuthTokens', () => {
  it('mints a 256-bit base64url token and stores only its SHA-256', () => {
    const tokens = createAuthTokens();
    const minted = tokens.mint();
    expect(minted.token).toMatch(AUTH_TOKEN_RE);
    expect(minted.hash).toHaveLength(32);
    expect(
      Buffer.from(minted.hash).equals(createHash('sha256').update(minted.token).digest()),
    ).toBe(true);
    expect(Buffer.from(minted.hash).toString('utf8')).not.toContain(minted.token);
  });

  it('hashes a presented token to the same bytes it minted', () => {
    const tokens = createAuthTokens();
    const minted = tokens.mint();
    expect(tokens.hash(minted.token)).toEqual(minted.hash);
  });

  it('never mints the same token twice', () => {
    const tokens = createAuthTokens();
    const seen = new Set(Array.from({ length: 1000 }, () => tokens.mint().token));
    expect(seen.size).toBe(1000);
  });

  it.each(['', 'short', `${'a'.repeat(43)}=`, `${'a'.repeat(42)}+`, 'a'.repeat(10_000)])(
    'refuses to hash a value that is not a token: %j',
    (value) => {
      expect(createAuthTokens().hash(value)).toBeNull();
    },
  );

  it('uses the injected randomness', () => {
    const tokens = createAuthTokens({ randomBytes: (n) => new Uint8Array(n).fill(0) });
    expect(tokens.mint().token).toBe('A'.repeat(43));
  });

  it('mints UUIDs for row ids', () => {
    expect(createAuthTokens().newId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
