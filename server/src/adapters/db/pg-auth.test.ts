import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import type { AuthMailer } from '../../core/ports/auth-stores.js';
import { AuthRefusal } from '../../core/auth/sign-in.js';
import { createAuthTokens } from '../crypto/auth-tokens.js';
import {
  AUTH_SQL,
  createPgAuthLinkStore,
  createPgSessionStore,
  createPgSignInFlows,
  type PgAuthClient,
} from './pg-auth.js';

const AT = epochMsFromIso('2026-08-20T05:20:00Z');
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const ACCOUNT = '66666666-0000-4000-8000-000000000001';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

type Answer = { rows: Record<string, unknown>[]; rowCount: number } | Error;

/**
 * A stub pool whose one client answers by statement. Anything not listed gets an empty
 * result with rowCount 1, which is what every single-row write expects.
 */
function stubPool(answers: Partial<Record<keyof typeof AUTH_SQL, Answer>> = {}) {
  const queries: RecordedQuery[] = [];
  let released = 0;
  const byText = new Map<string, Answer>();
  for (const [key, answer] of Object.entries(answers)) {
    byText.set(AUTH_SQL[key as keyof typeof AUTH_SQL], answer);
  }
  const query = <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) => {
    queries.push({ text, values });
    const answer = byText.get(text);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      rows: (answer?.rows ?? []) as Row[],
      rowCount: answer?.rowCount ?? 1,
    });
  };
  const client: PgAuthClient = {
    query,
    release() {
      released += 1;
    },
  };
  return {
    queries,
    texts: () => queries.map((q) => q.text),
    released: () => released,
    pool: { query, connect: () => Promise.resolve(client) },
  };
}

function recordingMailer(fail = false) {
  const sent: { to: string; token: string }[] = [];
  const mailer: AuthMailer = {
    sendSignInLink(message) {
      if (fail) return Promise.reject(new Error('smtp down'));
      sent.push({ to: message.to, token: message.token });
      return Promise.resolve();
    },
  };
  return { sent, mailer };
}

describe('requesting a link runs lock, count, supersede, insert inside one transaction', () => {
  it('in that order, and commits', async () => {
    const stub = stubPool();
    const { sent, mailer } = recordingMailer();
    const flows = createPgSignInFlows(stub.pool, { tokens: createAuthTokens(), mailer });

    await flows.requestLink({ email: ' Ivan@Example.BG ', userAgent: FIREFOX }, AT);

    expect(stub.texts()).toEqual([
      'BEGIN',
      AUTH_SQL.lockAddress,
      AUTH_SQL.issuedSince,
      AUTH_SQL.supersedeOpen,
      AUTH_SQL.insertLink,
      'COMMIT',
    ]);
    expect(stub.released()).toBe(1);
    expect(sent).toHaveLength(1);
    // The stored hash is 32 bytes and is not the mailed token.
    const insert = stub.queries.find((q) => q.text === AUTH_SQL.insertLink);
    const storedHash = insert?.values[2] as Buffer;
    expect(storedHash).toHaveLength(32);
    expect(storedHash.toString('utf8')).not.toContain(sent[0]?.token ?? '');
    expect(insert?.values.slice(1, 2)).toEqual(['ivan@example.bg']);
    expect(insert?.values[3]).toBe('firefox');
  });

  it('rolls back when the mail fails, so the attempt does not count', async () => {
    const stub = stubPool();
    const flows = createPgSignInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer(true).mailer,
    });

    await expect(
      flows.requestLink({ email: 'a@example.bg', userAgent: FIREFOX }, AT),
    ).rejects.toThrow('smtp down');
    expect(stub.texts().at(-1)).toBe('ROLLBACK');
    expect(stub.texts()).not.toContain('COMMIT');
    expect(stub.released()).toBe(1);
  });

  it('refuses the fourth in an hour without superseding anything', async () => {
    const stub = stubPool({
      issuedSince: {
        rows: [
          { requested_at: new Date(AT - 50 * 60_000) },
          { requested_at: new Date(AT - 20 * 60_000) },
          { requested_at: new Date(AT - 60_000) },
        ],
        rowCount: 3,
      },
    });
    const flows = createPgSignInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
    });

    const refusal = await flows
      .requestLink({ email: 'a@example.bg', userAgent: FIREFOX }, AT)
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AuthRefusal);
    expect((refusal as AuthRefusal).code).toBe('rate_limited');
    expect((refusal as AuthRefusal).retryAfterSeconds).toBe(600);
    expect(stub.texts()).not.toContain(AUTH_SQL.supersedeOpen);
    expect(stub.texts().at(-1)).toBe('ROLLBACK');
  });
});

describe('continuing a link', () => {
  const tokens = createAuthTokens();
  const minted = tokens.mint();
  const openLink = {
    id: '66666666-0000-4000-8000-0000000000aa',
    email: 'a@example.bg',
    ua_family: 'firefox',
    requested_at: new Date(AT - 60_000),
    expires_at: new Date(AT + 14 * 60_000),
    consumed_at: null,
    superseded_at: null,
  };

  it('consumes, upserts the account and inserts the session in one transaction', async () => {
    const stub = stubPool({
      findLink: { rows: [openLink], rowCount: 1 },
      upsertVerifiedAccount: { rows: [{ id: ACCOUNT, created: true }], rowCount: 1 },
    });
    const flows = createPgSignInFlows(stub.pool, { tokens, mailer: recordingMailer().mailer });

    const started = await flows.continueLink({ token: minted.token, userAgent: FIREFOX }, AT);

    expect(started.accountId).toBe(ACCOUNT);
    expect(started.accountCreated).toBe(true);
    expect(stub.texts()).toEqual([
      'BEGIN',
      AUTH_SQL.findLink,
      AUTH_SQL.consumeLink,
      AUTH_SQL.upsertVerifiedAccount,
      AUTH_SQL.insertSession,
      'COMMIT',
    ]);
    const session = stub.queries.find((q) => q.text === AUTH_SQL.insertSession);
    expect(Buffer.from(session?.values[1] as Buffer)).toEqual(
      Buffer.from(tokens.hash(started.sessionToken) ?? []),
    );
  });

  it('turns a lost consume race into `used` and rolls back', async () => {
    const stub = stubPool({
      findLink: { rows: [openLink], rowCount: 1 },
      consumeLink: { rows: [], rowCount: 0 },
    });
    const flows = createPgSignInFlows(stub.pool, { tokens, mailer: recordingMailer().mailer });

    const refusal = await flows
      .continueLink({ token: minted.token, userAgent: FIREFOX }, AT)
      .catch((e: unknown) => e);
    expect((refusal as AuthRefusal).code).toBe('used');
    expect(stub.texts()).not.toContain(AUTH_SQL.insertSession);
    expect(stub.texts().at(-1)).toBe('ROLLBACK');
  });

  it('the consume statement re-checks open and unexpired itself', () => {
    expect(AUTH_SQL.consumeLink).toMatch(
      /consumed_at IS NULL AND superseded_at IS NULL AND expires_at > \$2/,
    );
  });

  it('the upsert targets only live accounts, so a deleted account is never resurrected', () => {
    expect(AUTH_SQL.upsertVerifiedAccount).toMatch(
      /ON CONFLICT \(email\) WHERE deleted_at IS NULL AND email IS NOT NULL/,
    );
  });
});

describe('the stores decode rows as pg hands them over', () => {
  it('a link with null endings', async () => {
    const stub = stubPool({
      findLink: {
        rows: [
          {
            id: 'L',
            email: 'a@example.bg',
            ua_family: 'chrome',
            requested_at: new Date(AT),
            expires_at: new Date(AT + 900_000),
            consumed_at: null,
            superseded_at: null,
          },
        ],
        rowCount: 1,
      },
    });
    const link = await createPgAuthLinkStore(stub.pool).findByTokenHash(new Uint8Array(32));
    expect(link).toEqual({
      id: 'L',
      email: 'a@example.bg',
      uaFamily: 'chrome',
      requestedAt: AT,
      expiresAt: AT + 900_000,
      consumedAt: null,
      supersededAt: null,
    });
  });

  it('a session joined to a deleted account', async () => {
    const stub = stubPool({
      findSession: {
        rows: [
          {
            id: 'S',
            account_id: ACCOUNT,
            expires_at: new Date(AT + 1),
            revoked_at: new Date(AT - 1),
            account_deleted: true,
          },
        ],
        rowCount: 1,
      },
    });
    const session = await createPgSessionStore(stub.pool).findByTokenHash(new Uint8Array(32));
    expect(session).toEqual({
      id: 'S',
      accountId: ACCOUNT,
      expiresAt: AT + 1,
      revokedAt: AT - 1,
      accountDeleted: true,
    });
  });

  it('nothing for an unknown hash', async () => {
    const stub = stubPool({ findSession: { rows: [], rowCount: 0 } });
    expect(await createPgSessionStore(stub.pool).findByTokenHash(new Uint8Array(32))).toBeNull();
  });

  it('the touch can only move the expiry forward', () => {
    expect(AUTH_SQL.touchSession).toMatch(/expires_at = GREATEST\(expires_at, \$3::timestamptz\)/);
  });

  it('revoke-all reports how many live sessions it ended', async () => {
    const stub = stubPool({ revokeAllForAccount: { rows: [], rowCount: 4 } });
    expect(
      await createPgSessionStore(stub.pool).revokeAllForAccount(ACCOUNT, '2026-08-20T05:20:00Z'),
    ).toBe(4);
  });
});

describe('authenticate and sign out run on the pool, outside a transaction', () => {
  it('authenticate touches a live session', async () => {
    const tokens = createAuthTokens();
    const minted = tokens.mint();
    const stub = stubPool({
      findSession: {
        rows: [
          {
            id: 'S',
            account_id: ACCOUNT,
            expires_at: new Date(AT + 1),
            revoked_at: null,
            account_deleted: false,
          },
        ],
        rowCount: 1,
      },
    });
    const flows = createPgSignInFlows(stub.pool, { tokens, mailer: recordingMailer().mailer });

    const session = await flows.authenticate(minted.token, AT);
    expect(session?.accountId).toBe(ACCOUNT);
    expect(stub.texts()).toEqual([AUTH_SQL.findSession, AUTH_SQL.touchSession]);
    expect(stub.released()).toBe(0);
  });
});
