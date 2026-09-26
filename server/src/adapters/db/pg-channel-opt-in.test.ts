import { describe, expect, it } from 'vitest';

import {
  ChannelOptInRefusal,
  type ChannelOptInPolicy,
} from '../../core/channels/channel-opt-in.js';
import { CHANNEL_OPT_IN_POLICY } from '../../core/channels/opt-in-policy.js';
import type {
  ChannelConfirmationMailer,
  TelegramBotApi,
  TelegramLinkAck,
} from '../../core/ports/channel-opt-in-store.js';
import { epochMsFromIso } from '../../core/ports/clock.js';
import { createAuthTokens } from '../crypto/auth-tokens.js';
import {
  createPgChannelConfirmationStore,
  createPgChannelOptInFlows,
  OPT_IN_LOCK_CLASS,
  OPT_IN_SQL,
  type PgOptInClient,
} from './pg-channel-opt-in.js';

const AT = epochMsFromIso('2026-09-23T08:00:00Z');
const ACCOUNT = '12121212-0000-4000-8000-000000000001';
const SUBSCRIPTION = '12121212-0000-4000-8000-0000000000a1';
const CONFIRMATION = '12121212-0000-4000-8000-0000000000c1';
const HOUR = 3_600_000;
const ARMED: ChannelOptInPolicy = {
  ...CHANNEL_OPT_IN_POLICY,
  telegram: { pendingTtlMs: HOUR, issuesPerWindow: 5, issueWindowMs: 24 * HOUR },
};

type Answer = { rows: Record<string, unknown>[]; rowCount: number } | Error;

/** A stub pool answering by statement; anything unlisted gets no rows and rowCount 1. */
function stubPool(answers: Partial<Record<keyof typeof OPT_IN_SQL, Answer>> = {}) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  let released = 0;
  const byText = new Map<string, Answer>();
  for (const [key, answer] of Object.entries(answers)) {
    byText.set(OPT_IN_SQL[key as keyof typeof OPT_IN_SQL], answer);
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
  const client: PgOptInClient = {
    query,
    release() {
      released += 1;
    },
  };
  const keyOf = new Map<string, string>(
    Object.entries(OPT_IN_SQL).map(([key, text]) => [text, key]),
  );
  return {
    queries,
    /** Statement names in order; transaction verbs as themselves. */
    trace: () => queries.map((q) => keyOf.get(q.text) ?? q.text),
    released: () => released,
    pool: { query, connect: () => Promise.resolve(client) },
  };
}

function recordingMailer(fail = false) {
  const sent: { to: string; token: string; expiresAtIso: string }[] = [];
  const mailer: ChannelConfirmationMailer = {
    sendConfirmation(message) {
      if (fail) return Promise.reject(new Error('smtp down'));
      sent.push({ ...message });
      return Promise.resolve();
    },
  };
  return { sent, mailer };
}

function recordingBot(fail = false) {
  const acks: { chatId: string; outcome: TelegramLinkAck }[] = [];
  const bot: TelegramBotApi = {
    acknowledgeLink(chatId, outcome) {
      if (fail) return Promise.reject(new Error('bot api down'));
      acks.push({ chatId, outcome });
      return Promise.resolve();
    },
  };
  return { acks, bot };
}

function confirmationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONFIRMATION,
    account_id: ACCOUNT,
    channel: 'email',
    channel_subscription_id: SUBSCRIPTION,
    issued_at: new Date(AT - HOUR),
    expires_at: new Date(AT + 47 * HOUR),
    consumed_at: null,
    superseded_at: null,
    revoked_at: null,
    account_deleted: false,
    ...overrides,
  };
}

describe('requesting an email confirmation', () => {
  it('locks, counts, inserts the pending subscription and the token, mails, then commits', async () => {
    const stub = stubPool();
    const { sent, mailer } = recordingMailer();
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer,
      bot: recordingBot().bot,
    });
    const result = await flows.requestEmail(
      { accountId: ACCOUNT, email: ' Person@Example.org ' },
      AT,
    );

    expect(result.status).toBe('pending');
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockScope',
      'findLiveSubscription',
      'issuedSinceEmail',
      'insertSubscription',
      'insertConfirmation',
      'COMMIT',
    ]);
    expect(stub.queries[1]?.values).toEqual(['email:person@example.org']);
    expect(OPT_IN_SQL.lockScope).toContain(`pg_advisory_xact_lock(${OPT_IN_LOCK_CLASS},`);
    const [, , , , subscription, confirmation] = stub.queries;
    expect(subscription?.values.slice(1)).toEqual([
      ACCOUNT,
      'email',
      'person@example.org',
      '2026-09-23T08:00:00Z',
      null,
    ]);
    // Hashed at rest: the stored value is 32 bytes and is not the mailed token.
    const stored = confirmation?.values[4];
    expect(Buffer.isBuffer(stored)).toBe(true);
    expect((stored as Buffer).length).toBe(32);
    expect(sent).toHaveLength(1);
    expect((stored as Buffer).toString('utf8')).not.toContain(sent[0]?.token ?? '');
    expect(sent[0]?.expiresAtIso).toBe('2026-09-25T08:00:00Z');
    expect(stub.released()).toBe(1);
  });

  it('rolls the rows back when the mailer fails, so the attempt does not count', async () => {
    const stub = stubPool();
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer(true).mailer,
      bot: recordingBot().bot,
    });
    await expect(
      flows.requestEmail({ accountId: ACCOUNT, email: 'person@example.org' }, AT),
    ).rejects.toThrow('smtp down');
    expect(stub.trace().at(-1)).toBe('ROLLBACK');
    expect(stub.trace()).not.toContain('COMMIT');
    expect(stub.released()).toBe(1);
  });

  it('refuses a fourth mail to the address within the day and writes nothing', async () => {
    const stub = stubPool({
      issuedSinceEmail: {
        rows: [1, 2, 3].map((h) => ({ issued_at: new Date(AT - h * HOUR) })),
        rowCount: 3,
      },
    });
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot: recordingBot().bot,
    });
    const refused = await flows
      .requestEmail({ accountId: ACCOUNT, email: 'person@example.org' }, AT)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ChannelOptInRefusal);
    expect((refused as ChannelOptInRefusal).code).toBe('rate_limited');
    expect(stub.trace()).not.toContain('insertConfirmation');
    expect(stub.trace().at(-1)).toBe('ROLLBACK');
  });

  it('supersedes the open token of an existing pending subscription instead of inserting one', async () => {
    const stub = stubPool({
      findLiveSubscription: { rows: [{ id: SUBSCRIPTION, confirmed_at: null }], rowCount: 1 },
    });
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot: recordingBot().bot,
    });
    await flows.requestEmail({ accountId: ACCOUNT, email: 'person@example.org' }, AT);
    expect(stub.trace()).toContain('supersedeForSubscription');
    expect(stub.trace()).not.toContain('insertSubscription');
  });
});

describe('confirming an email token', () => {
  it('consumes then confirms, in one transaction', async () => {
    const tokens = createAuthTokens();
    const minted = tokens.mint();
    const stub = stubPool({ findConfirmation: { rows: [confirmationRow()], rowCount: 1 } });
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens,
      mailer: recordingMailer().mailer,
      bot: recordingBot().bot,
    });
    await expect(flows.confirmEmail({ token: minted.token }, AT)).resolves.toEqual({
      subscriptionId: SUBSCRIPTION,
    });
    expect(stub.trace()).toEqual([
      'BEGIN',
      'findConfirmation',
      'consumeConfirmation',
      'confirmSubscription',
      'COMMIT',
    ]);
    expect(Buffer.from(stub.queries[1]?.values[0] as Buffer)).toEqual(Buffer.from(minted.hash));
  });

  it('refuses `used` when the conditional consume loses the race', async () => {
    const stub = stubPool({
      findConfirmation: { rows: [confirmationRow()], rowCount: 1 },
      consumeConfirmation: { rows: [], rowCount: 0 },
    });
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot: recordingBot().bot,
    });
    await expect(
      flows.confirmEmail({ token: createAuthTokens().mint().token }, AT),
    ).rejects.toMatchObject({ code: 'used' });
    expect(stub.trace().at(-1)).toBe('ROLLBACK');
  });

  it('rolls the consume back when the subscription was unlinked meanwhile', async () => {
    const stub = stubPool({
      findConfirmation: { rows: [confirmationRow()], rowCount: 1 },
      confirmSubscription: { rows: [], rowCount: 0 },
    });
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot: recordingBot().bot,
    });
    await expect(
      flows.confirmEmail({ token: createAuthTokens().mint().token }, AT),
    ).rejects.toMatchObject({ code: 'revoked' });
    expect(stub.trace()).toContain('consumeConfirmation');
    expect(stub.trace().at(-1)).toBe('ROLLBACK');
  });

  it('decodes the account-deleted flag and refuses on it', async () => {
    const stub = stubPool({
      findConfirmation: { rows: [confirmationRow({ account_deleted: true })], rowCount: 1 },
    });
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot: recordingBot().bot,
    });
    await expect(
      flows.confirmEmail({ token: createAuthTokens().mint().token }, AT),
    ).rejects.toMatchObject({ code: 'account_deleted' });
    expect(stub.trace()).not.toContain('consumeConfirmation');
  });
});

describe('Telegram', () => {
  it('refuses to issue a link while the Telegram rule is unarmed, before any count', async () => {
    const stub = stubPool();
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot: recordingBot().bot,
    });
    await expect(flows.requestTelegramLink({ accountId: ACCOUNT }, AT)).rejects.toMatchObject({
      code: 'unarmed',
    });
    expect(stub.trace()).not.toContain('insertConfirmation');
  });

  it('issues under an armed policy: supersedes the account’s open links, inserts with no subscription', async () => {
    const stub = stubPool();
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot: recordingBot().bot,
      policy: ARMED,
    });
    const issued = await flows.requestTelegramLink({ accountId: ACCOUNT }, AT);
    expect(issued.expiresAt).toBe(AT + HOUR);
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockScope',
      'issuedSinceTelegram',
      'supersedeTelegramForAccount',
      'insertConfirmation',
      'COMMIT',
    ]);
    expect(stub.queries[1]?.values).toEqual([`telegram:${ACCOUNT}`]);
    expect(stub.queries[4]?.values[3]).toBeNull();
  });

  it('links a chat: inserts a confirmed subscription holding only the chat id, then acknowledges after commit', async () => {
    const stub = stubPool({
      findConfirmation: {
        rows: [confirmationRow({ channel: 'telegram', channel_subscription_id: null })],
        rowCount: 1,
      },
    });
    const { acks, bot } = recordingBot();
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot,
    });
    const handled = await flows.handleTelegramStart(
      { chatId: '424242', token: createAuthTokens().mint().token },
      AT,
    );
    expect(handled).toEqual({ outcome: 'linked', refusal: null, acknowledged: true });
    expect(stub.trace()).toEqual([
      'BEGIN',
      'findConfirmation',
      'findLiveSubscription',
      'insertSubscription',
      'consumeConfirmation',
      'COMMIT',
    ]);
    const inserted = stub.queries[3]?.values ?? [];
    expect(inserted.slice(1)).toEqual([
      ACCOUNT,
      'telegram',
      '424242',
      '2026-09-23T08:00:00Z',
      '2026-09-23T08:00:00Z',
    ]);
    expect(stub.queries[4]?.values[2]).toBe(inserted[0]);
    expect(acks).toEqual([{ chatId: '424242', outcome: 'linked' }]);
  });

  it('answers a refused /start with a bare `refused` and keeps the reason for the log only', async () => {
    const stub = stubPool();
    const { acks, bot } = recordingBot();
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot,
    });
    const handled = await flows.handleTelegramStart(
      { chatId: '424242', token: createAuthTokens().mint().token },
      AT,
    );
    expect(handled).toEqual({ outcome: 'refused', refusal: 'unknown', acknowledged: true });
    expect(acks).toEqual([{ chatId: '424242', outcome: 'refused' }]);
    expect(stub.trace().at(-1)).toBe('ROLLBACK');
  });

  it('keeps a committed link when the Bot API is down', async () => {
    const stub = stubPool({
      findConfirmation: {
        rows: [confirmationRow({ channel: 'telegram', channel_subscription_id: null })],
        rowCount: 1,
      },
    });
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot: recordingBot(true).bot,
    });
    const handled = await flows.handleTelegramStart(
      { chatId: '424242', token: createAuthTokens().mint().token },
      AT,
    );
    expect(handled).toEqual({ outcome: 'linked', refusal: null, acknowledged: false });
    expect(stub.trace()).toContain('COMMIT');
  });

  it('rethrows a database failure rather than acknowledging it as a refusal', async () => {
    const stub = stubPool({ findConfirmation: new Error('connection reset') });
    const { acks, bot } = recordingBot();
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot,
    });
    await expect(
      flows.handleTelegramStart({ chatId: '424242', token: createAuthTokens().mint().token }, AT),
    ).rejects.toThrow('connection reset');
    expect(acks).toEqual([]);
  });
});

describe('unlinking', () => {
  it('revokes the subscription and its open confirmations together', async () => {
    const stub = stubPool();
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot: recordingBot().bot,
    });
    await expect(
      flows.unlink({ accountId: ACCOUNT, subscriptionId: SUBSCRIPTION }, AT),
    ).resolves.toBe(true);
    expect(stub.trace()).toEqual([
      'BEGIN',
      'revokeSubscription',
      'revokeOpenForSubscription',
      'COMMIT',
    ]);
    expect(OPT_IN_SQL.revokeSubscription).toContain("endpoint = ''");
  });

  it('is false, and touches no confirmation, when the account owns no such live channel', async () => {
    const stub = stubPool({ revokeSubscription: { rows: [], rowCount: 0 } });
    const flows = createPgChannelOptInFlows(stub.pool, {
      tokens: createAuthTokens(),
      mailer: recordingMailer().mailer,
      bot: recordingBot().bot,
    });
    await expect(
      flows.unlink({ accountId: ACCOUNT, subscriptionId: SUBSCRIPTION }, AT),
    ).resolves.toBe(false);
    expect(stub.trace()).not.toContain('revokeOpenForSubscription');
  });
});

describe('the store in isolation', () => {
  it('reads null timestamps as null and refuses an unknown channel value', async () => {
    const stub = stubPool({
      findConfirmation: { rows: [confirmationRow({ channel: 'sms' })], rowCount: 1 },
    });
    const store = createPgChannelConfirmationStore(stub.pool);
    await expect(store.findByTokenHash(new Uint8Array(32))).rejects.toThrow('known channel');
  });

  it('returns null for an unknown hash', async () => {
    const store = createPgChannelConfirmationStore(stubPool().pool);
    await expect(store.findByTokenHash(new Uint8Array(32))).resolves.toBeNull();
  });
});
