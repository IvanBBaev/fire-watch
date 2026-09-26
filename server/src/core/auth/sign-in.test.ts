import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import type {
  AccountIdentityStore,
  AuthLinkStore,
  AuthMailer,
  AuthTokens,
  NewAuthLink,
  NewSession,
  SessionStore,
  StoredAuthLink,
  StoredSession,
} from '../ports/auth-stores.js';
import {
  authenticateSession,
  AuthRefusal,
  continueSignIn,
  requestSignInLink,
  signOut,
} from './sign-in.js';

const AT = epochMsFromIso('2026-08-20T05:20:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * One in-memory world behind every port. Tokens are `tok-N` and their "hash" is the token's
 * bytes: transparent on purpose, since what this suite checks is which hash reaches which
 * store — the real SHA-256 is `adapters/crypto/auth-tokens.test.ts`'s business.
 */
function world() {
  let counter = 0;
  const links: (StoredAuthLink & { tokenHash: string })[] = [];
  const sessions: (StoredSession & { tokenHash: string; lastSeenIso: string | null })[] = [];
  const accounts = new Map<string, { id: string; deleted: boolean }>();
  const mails: { to: string; token: string; expiresAtIso: string }[] = [];
  const log: string[] = [];
  const decode = (hash: Uint8Array): string => Buffer.from(hash).toString('utf8');

  const tokens: AuthTokens = {
    mint() {
      counter += 1;
      const token = `tok-${counter}`;
      return { token, hash: new Uint8Array(Buffer.from(token)) };
    },
    hash: (token) => (token.startsWith('tok-') ? new Uint8Array(Buffer.from(token)) : null),
    newId: () => `id-${(counter += 1)}`,
  };

  const linkStore: AuthLinkStore = {
    lockAddress(email) {
      log.push(`lock ${email}`);
      return Promise.resolve();
    },
    issuedSince(email, sinceIso) {
      const since = epochMsFromIso(sinceIso);
      return Promise.resolve(
        links.filter((l) => l.email === email && l.requestedAt >= since).map((l) => l.requestedAt),
      );
    },
    supersedeOpen(email, atIso) {
      log.push('supersede');
      for (const [index, link] of links.entries()) {
        if (link.email === email && link.consumedAt === null && link.supersededAt === null) {
          links[index] = { ...link, supersededAt: epochMsFromIso(atIso) };
        }
      }
      return Promise.resolve();
    },
    insert(link: NewAuthLink) {
      log.push('insert link');
      links.push({
        id: link.id,
        email: link.email,
        uaFamily: link.uaFamily,
        requestedAt: epochMsFromIso(link.requestedAtIso),
        expiresAt: epochMsFromIso(link.expiresAtIso),
        consumedAt: null,
        supersededAt: null,
        tokenHash: decode(link.tokenHash),
      });
      return Promise.resolve();
    },
    findByTokenHash(hash) {
      return Promise.resolve(links.find((l) => l.tokenHash === decode(hash)) ?? null);
    },
    consume(id, atIso) {
      const index = links.findIndex((l) => l.id === id);
      const link = links[index];
      if (link === undefined || link.consumedAt !== null || link.supersededAt !== null) {
        return Promise.resolve(false);
      }
      links[index] = { ...link, consumedAt: epochMsFromIso(atIso) };
      return Promise.resolve(true);
    },
  };

  const accountStore: AccountIdentityStore = {
    upsertVerified(email) {
      const existing = accounts.get(email);
      if (existing !== undefined)
        return Promise.resolve({ accountId: existing.id, created: false });
      const id = `acct-${email}`;
      accounts.set(email, { id, deleted: false });
      return Promise.resolve({ accountId: id, created: true });
    },
  };

  const sessionStore: SessionStore = {
    insert(session: NewSession) {
      sessions.push({
        id: session.id,
        accountId: session.accountId,
        expiresAt: epochMsFromIso(session.expiresAtIso),
        revokedAt: null,
        accountDeleted: false,
        tokenHash: decode(session.tokenHash),
        lastSeenIso: null,
      });
      return Promise.resolve();
    },
    findByTokenHash(hash) {
      const found = sessions.find((s) => s.tokenHash === decode(hash));
      if (found === undefined) return Promise.resolve(null);
      const deleted = [...accounts.values()].some((a) => a.id === found.accountId && a.deleted);
      return Promise.resolve({ ...found, accountDeleted: deleted });
    },
    touch(id, lastSeenIso, expiresAtIso) {
      const index = sessions.findIndex((s) => s.id === id);
      const session = sessions[index];
      if (session !== undefined) {
        sessions[index] = { ...session, lastSeenIso, expiresAt: epochMsFromIso(expiresAtIso) };
      }
      return Promise.resolve();
    },
    revoke(id, atIso) {
      const index = sessions.findIndex((s) => s.id === id);
      const session = sessions[index];
      if (session !== undefined) sessions[index] = { ...session, revokedAt: epochMsFromIso(atIso) };
      return Promise.resolve();
    },
    revokeAllForAccount() {
      return Promise.resolve(0);
    },
  };

  const mailer: AuthMailer = {
    sendSignInLink(message) {
      log.push('mail');
      mails.push(message);
      return Promise.resolve();
    },
  };

  return {
    links,
    sessions,
    accounts,
    mails,
    log,
    requestDeps: { links: linkStore, tokens, mailer },
    continueDeps: { links: linkStore, accounts: accountStore, sessions: sessionStore, tokens },
    sessionDeps: { sessions: sessionStore, tokens },
  };
}

async function refusal(promise: Promise<unknown>): Promise<AuthRefusal> {
  const failure = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AuthRefusal);
  return failure as AuthRefusal;
}

describe('requesting a link', () => {
  it('locks, supersedes, inserts, and only then mails the token — stored only as its hash', async () => {
    const w = world();
    await requestSignInLink({ email: ' Ivan@Example.BG ', userAgent: FIREFOX }, AT, w.requestDeps);
    expect(w.log).toEqual(['lock ivan@example.bg', 'supersede', 'insert link', 'mail']);
    expect(w.mails).toEqual([
      { to: 'ivan@example.bg', token: 'tok-1', expiresAtIso: '2026-08-20T05:35:00Z' },
    ]);
    expect(w.links[0]).toMatchObject({ email: 'ivan@example.bg', uaFamily: 'firefox' });
  });

  it('refuses a malformed address before touching any store', async () => {
    const w = world();
    expect(
      (await refusal(requestSignInLink({ email: 'nope', userAgent: FIREFOX }, AT, w.requestDeps)))
        .code,
    ).toBe('invalid_email');
    expect(w.log).toEqual([]);
  });

  it('refuses the fourth link inside an hour, with a Retry-After, and mails nothing', async () => {
    const w = world();
    for (const offset of [0, 10, 20]) {
      await requestSignInLink(
        { email: 'a@example.bg', userAgent: FIREFOX },
        AT + offset * MINUTE,
        w.requestDeps,
      );
    }
    const refused = await refusal(
      requestSignInLink(
        { email: 'a@example.bg', userAgent: FIREFOX },
        AT + 30 * MINUTE,
        w.requestDeps,
      ),
    );
    expect(refused.code).toBe('rate_limited');
    expect(refused.retryAfterSeconds).toBe(30 * 60);
    expect(w.mails).toHaveLength(3);
  });

  it('counts per address, not globally', async () => {
    const w = world();
    for (const offset of [0, 1, 2]) {
      await requestSignInLink(
        { email: 'a@example.bg', userAgent: FIREFOX },
        AT + offset,
        w.requestDeps,
      );
    }
    await requestSignInLink({ email: 'b@example.bg', userAgent: FIREFOX }, AT + 3, w.requestDeps);
    expect(w.mails.map((m) => m.to)).toEqual([
      'a@example.bg',
      'a@example.bg',
      'a@example.bg',
      'b@example.bg',
    ]);
  });
});

describe('continuing a link', () => {
  async function issued(w: ReturnType<typeof world>, userAgent = FIREFOX): Promise<string> {
    await requestSignInLink({ email: 'ivan@example.bg', userAgent }, AT, w.requestDeps);
    const token = w.mails.at(-1)?.token;
    if (token === undefined) throw new Error('no mail');
    return token;
  }

  it('consumes the link, creates the account, and starts a 30-day session', async () => {
    const w = world();
    const token = await issued(w);
    const started = await continueSignIn(
      { token, userAgent: FIREFOX },
      AT + 5 * MINUTE,
      w.continueDeps,
    );
    expect(started).toMatchObject({ accountId: 'acct-ivan@example.bg', accountCreated: true });
    expect(started.expiresAt).toBe(AT + 5 * MINUTE + 30 * DAY);
    expect(w.links[0]?.consumedAt).toBe(AT + 5 * MINUTE);
    // The cookie value is never what was stored: only its hash reached the session store.
    expect(w.sessions[0]?.tokenHash).toBe(started.sessionToken);
    expect(started.sessionToken).not.toBe(token);
  });

  it('signs an existing account in without creating another', async () => {
    const w = world();
    const first = await issued(w);
    await continueSignIn({ token: first, userAgent: FIREFOX }, AT + MINUTE, w.continueDeps);
    const second = await issued(w);
    const again = await continueSignIn(
      { token: second, userAgent: FIREFOX },
      AT + 2 * MINUTE,
      w.continueDeps,
    );
    expect(again.accountCreated).toBe(false);
    expect(w.accounts.size).toBe(1);
  });

  it('is single-use', async () => {
    const w = world();
    const token = await issued(w);
    await continueSignIn({ token, userAgent: FIREFOX }, AT + MINUTE, w.continueDeps);
    expect(
      (
        await refusal(
          continueSignIn({ token, userAgent: FIREFOX }, AT + 2 * MINUTE, w.continueDeps),
        )
      ).code,
    ).toBe('used');
    expect(w.sessions).toHaveLength(1);
  });

  it('expires after 15 minutes', async () => {
    const w = world();
    const token = await issued(w);
    expect(
      (
        await refusal(
          continueSignIn({ token, userAgent: FIREFOX }, AT + 15 * MINUTE, w.continueDeps),
        )
      ).code,
    ).toBe('expired');
    expect(w.sessions).toEqual([]);
  });

  it('is invalidated by a newer issuance to the same address', async () => {
    const w = world();
    const older = await issued(w);
    const newer = await issued(w);
    expect(
      (
        await refusal(
          continueSignIn({ token: older, userAgent: FIREFOX }, AT + MINUTE, w.continueDeps),
        )
      ).code,
    ).toBe('superseded');
    await expect(
      continueSignIn({ token: newer, userAgent: FIREFOX }, AT + MINUTE, w.continueDeps),
    ).resolves.toBeDefined();
  });

  it('is honoured only by the UA family that requested it, and is not burned by another', async () => {
    const w = world();
    const token = await issued(w);
    expect(
      (await refusal(continueSignIn({ token, userAgent: CHROME }, AT + MINUTE, w.continueDeps)))
        .code,
    ).toBe('other_browser');
    expect(w.links[0]?.consumedAt).toBeNull();
    await expect(
      continueSignIn({ token, userAgent: FIREFOX }, AT + 2 * MINUTE, w.continueDeps),
    ).resolves.toBeDefined();
  });

  it('refuses a token it has never issued, or one that is not a token at all', async () => {
    const w = world();
    expect(
      (await refusal(continueSignIn({ token: 'tok-999', userAgent: FIREFOX }, AT, w.continueDeps)))
        .code,
    ).toBe('unknown');
    expect(
      (await refusal(continueSignIn({ token: '../etc', userAgent: FIREFOX }, AT, w.continueDeps)))
        .code,
    ).toBe('unknown');
  });

  it('never quotes the address or the token in a refusal', async () => {
    const w = world();
    const token = await issued(w);
    const failure = await refusal(continueSignIn({ token, userAgent: CHROME }, AT, w.continueDeps));
    expect(String(failure)).not.toContain(token);
    expect(String(failure)).not.toContain('ivan@');
  });
});

describe('sessions', () => {
  async function signedIn(w: ReturnType<typeof world>): Promise<string> {
    await requestSignInLink({ email: 'ivan@example.bg', userAgent: FIREFOX }, AT, w.requestDeps);
    const token = w.mails.at(-1)?.token ?? '';
    return (await continueSignIn({ token, userAgent: FIREFOX }, AT, w.continueDeps)).sessionToken;
  }

  it('authenticates a live session and slides its expiry', async () => {
    const w = world();
    const cookie = await signedIn(w);
    const later = AT + 20 * DAY;
    const session = await authenticateSession(cookie, later, w.sessionDeps);
    expect(session).toMatchObject({
      accountId: 'acct-ivan@example.bg',
      expiresAt: later + 30 * DAY,
    });
    expect(w.sessions[0]?.expiresAt).toBe(later + 30 * DAY);
  });

  it('does not authenticate past the sliding window', async () => {
    const w = world();
    const cookie = await signedIn(w);
    expect(await authenticateSession(cookie, AT + 30 * DAY, w.sessionDeps)).toBeNull();
  });

  it('does not authenticate a revoked session — sign-out is revoking the row', async () => {
    const w = world();
    const cookie = await signedIn(w);
    await signOut(cookie, AT + MINUTE, w.sessionDeps);
    expect(w.sessions[0]?.revokedAt).toBe(AT + MINUTE);
    expect(await authenticateSession(cookie, AT + 2 * MINUTE, w.sessionDeps)).toBeNull();
  });

  it('does not authenticate a session whose account was deleted', async () => {
    const w = world();
    const cookie = await signedIn(w);
    for (const account of w.accounts.values()) account.deleted = true;
    expect(await authenticateSession(cookie, AT + MINUTE, w.sessionDeps)).toBeNull();
  });

  it('answers null for no cookie, a malformed one, or an unknown one', async () => {
    const w = world();
    for (const cookie of [undefined, 'garbage', 'tok-404']) {
      expect(await authenticateSession(cookie, AT, w.sessionDeps)).toBeNull();
    }
    await expect(signOut('garbage', AT, w.sessionDeps)).resolves.toBeUndefined();
  });
});
