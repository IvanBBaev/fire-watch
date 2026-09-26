import { describe, expect, it } from 'vitest';

import type { AuthTokens } from '../ports/auth-stores.js';
import type {
  ChannelConfirmationStore,
  ChannelSubscriptionWriter,
  NewChannelConfirmation,
  OptInChannel,
  StoredChannelConfirmation,
  TelegramBotApi,
} from '../ports/channel-opt-in-store.js';
import { epochMsFromIso } from '../ports/clock.js';
import {
  acknowledgeTelegramLink,
  ChannelOptInRefusal,
  completeTelegramLink,
  confirmEmailChannel,
  requestEmailChannel,
  requestTelegramLink,
  unlinkChannel,
  type ChannelOptInPolicy,
} from './channel-opt-in.js';
import { CHANNEL_OPT_IN_POLICY } from './opt-in-policy.js';

const AT = epochMsFromIso('2026-09-23T08:00:00Z');
const HOUR = 3_600_000;
const ACCOUNT = 'acc-1';
const OTHER = 'acc-2';

/** Telegram armed with test values only, to exercise the flow the shipped policy refuses. */
const ARMED: ChannelOptInPolicy = {
  ...CHANNEL_OPT_IN_POLICY,
  telegram: { pendingTtlMs: HOUR, issuesPerWindow: 5, issueWindowMs: 24 * HOUR },
};

interface Sub {
  id: string;
  accountId: string;
  channel: OptInChannel;
  endpoint: string;
  confirmedAt: number | null;
  revokedAt: number | null;
}

/** One in-memory world. The "hash" is the token's bytes: which hash reaches which store is the point. */
function world() {
  let counter = 0;
  const confirmations: (StoredChannelConfirmation & { tokenHash: string })[] = [];
  const subs: Sub[] = [];
  const mails: { to: string; token: string; expiresAtIso: string }[] = [];
  const log: string[] = [];
  const deleted = new Set<string>();
  const decode = (hash: Uint8Array): string => new TextDecoder().decode(hash);
  const encode = (token: string): Uint8Array => new TextEncoder().encode(token);

  const tokens: AuthTokens = {
    mint() {
      counter += 1;
      const token = `tok-${counter}`;
      return { token, hash: encode(token) };
    },
    hash: (token) => (token.startsWith('tok-') ? encode(token) : null),
    newId: () => `id-${(counter += 1)}`,
  };

  const endpointOf = (c: StoredChannelConfirmation): string | undefined =>
    subs.find((s) => s.id === c.channelSubscriptionId)?.endpoint;
  const isOpen = (c: StoredChannelConfirmation): boolean =>
    c.consumedAt === null && c.supersededAt === null && c.revokedAt === null;

  const confirmationStore: ChannelConfirmationStore = {
    lockScope(scope) {
      log.push(`lock ${scope.channel}`);
      return Promise.resolve();
    },
    issuedSince(scope, sinceIso) {
      const since = epochMsFromIso(sinceIso);
      return Promise.resolve(
        confirmations
          .filter((c) => c.channel === scope.channel && c.issuedAt >= since)
          .filter((c) =>
            scope.channel === 'email'
              ? c.accountId === scope.accountId || endpointOf(c) === scope.address
              : c.accountId === scope.accountId,
          )
          .map((c) => c.issuedAt),
      );
    },
    supersedeOpen(target, atIso) {
      log.push('supersede');
      for (const [i, c] of confirmations.entries()) {
        const hit =
          'channelSubscriptionId' in target
            ? c.channelSubscriptionId === target.channelSubscriptionId
            : c.accountId === target.accountId && c.channel === target.channel;
        if (hit && isOpen(c)) confirmations[i] = { ...c, supersededAt: epochMsFromIso(atIso) };
      }
      return Promise.resolve();
    },
    insert(c: NewChannelConfirmation) {
      log.push('insert confirmation');
      confirmations.push({
        id: c.id,
        accountId: c.accountId,
        channel: c.channel,
        channelSubscriptionId: c.channelSubscriptionId,
        issuedAt: epochMsFromIso(c.issuedAtIso),
        expiresAt: epochMsFromIso(c.expiresAtIso),
        consumedAt: null,
        supersededAt: null,
        revokedAt: null,
        accountDeleted: false,
        tokenHash: decode(c.tokenHash),
      });
      return Promise.resolve();
    },
    findByTokenHash(hash) {
      const found = confirmations.find((c) => c.tokenHash === decode(hash));
      return Promise.resolve(
        found === undefined ? null : { ...found, accountDeleted: deleted.has(found.accountId) },
      );
    },
    consume(id, atIso, subscriptionId) {
      log.push('consume');
      const at = epochMsFromIso(atIso);
      const i = confirmations.findIndex((c) => c.id === id && isOpen(c) && c.expiresAt > at);
      const c = confirmations[i];
      if (c === undefined) return Promise.resolve(false);
      confirmations[i] = {
        ...c,
        consumedAt: at,
        channelSubscriptionId: subscriptionId ?? c.channelSubscriptionId,
      };
      return Promise.resolve(true);
    },
    revokeOpenForSubscription(subscriptionId, atIso) {
      let n = 0;
      for (const [i, c] of confirmations.entries()) {
        if (c.channelSubscriptionId === subscriptionId && isOpen(c)) {
          confirmations[i] = { ...c, revokedAt: epochMsFromIso(atIso) };
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
  };

  const subscriptionWriter: ChannelSubscriptionWriter = {
    findLive(accountId, channel, endpoint) {
      const s = subs.find(
        (x) =>
          x.accountId === accountId &&
          x.channel === channel &&
          x.endpoint === endpoint &&
          x.revokedAt === null,
      );
      return Promise.resolve(s === undefined ? null : { id: s.id, confirmedAt: s.confirmedAt });
    },
    insert(s) {
      log.push(`insert subscription ${s.channel}`);
      subs.push({
        id: s.id,
        accountId: s.accountId,
        channel: s.channel,
        endpoint: s.endpoint,
        confirmedAt: s.confirmedAtIso === null ? null : epochMsFromIso(s.confirmedAtIso),
        revokedAt: null,
      });
      return Promise.resolve();
    },
    confirm(id, atIso) {
      log.push('confirm subscription');
      const s = subs.find((x) => x.id === id && x.confirmedAt === null && x.revokedAt === null);
      if (s === undefined) return Promise.resolve(false);
      s.confirmedAt = epochMsFromIso(atIso);
      return Promise.resolve(true);
    },
    revoke(id, accountId, atIso) {
      const s = subs.find((x) => x.id === id && x.accountId === accountId && x.revokedAt === null);
      if (s === undefined) return Promise.resolve(false);
      s.revokedAt = epochMsFromIso(atIso);
      s.endpoint = '';
      return Promise.resolve(true);
    },
  };

  const mailer = {
    sendConfirmation(message: { to: string; token: string; expiresAtIso: string }) {
      log.push('mail');
      mails.push(message);
      return Promise.resolve();
    },
  };

  return {
    confirmations,
    subs,
    mails,
    log,
    deleted,
    deps: { confirmations: confirmationStore, subscriptions: subscriptionWriter, tokens },
    mailer,
  };
}

async function refusal(promise: Promise<unknown>): Promise<ChannelOptInRefusal> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ChannelOptInRefusal)) throw new Error('expected a ChannelOptInRefusal');
  return error;
}

describe('requestEmailChannel', () => {
  it('inserts a pending subscription, stores only the hash, and mails last', async () => {
    const w = world();
    const result = await requestEmailChannel(
      { accountId: ACCOUNT, email: ' Person@Example.ORG ' },
      AT,
      { ...w.deps, mailer: w.mailer },
    );
    expect(result).toMatchObject({ status: 'pending', expiresAt: AT + 48 * HOUR });
    expect(w.subs).toEqual([
      expect.objectContaining({ endpoint: 'person@example.org', confirmedAt: null }),
    ]);
    expect(w.log).toEqual([
      'lock email',
      'insert subscription email',
      'insert confirmation',
      'mail',
    ]);
    expect(w.mails[0]?.to).toBe('person@example.org');
    expect(w.confirmations[0]?.tokenHash).toBe(w.mails[0]?.token);
  });

  it('refuses a malformed address before touching any store', async () => {
    const w = world();
    const error = await refusal(
      requestEmailChannel({ accountId: ACCOUNT, email: 'nope' }, AT, {
        ...w.deps,
        mailer: w.mailer,
      }),
    );
    expect(error.code).toBe('invalid_email');
    expect(w.log).toEqual([]);
  });

  it('re-sends on the same pending subscription and supersedes the older token', async () => {
    const w = world();
    const deps = { ...w.deps, mailer: w.mailer };
    const first = await requestEmailChannel({ accountId: ACCOUNT, email: 'a@b.org' }, AT, deps);
    const second = await requestEmailChannel(
      { accountId: ACCOUNT, email: 'a@b.org' },
      AT + 1,
      deps,
    );
    expect(second.subscriptionId).toBe(first.subscriptionId);
    expect(w.subs).toHaveLength(1);
    expect(w.confirmations.map((c) => c.supersededAt)).toEqual([AT + 1, null]);
    const stale = await refusal(
      confirmEmailChannel({ token: w.mails[0]?.token ?? '' }, AT + 2, w.deps),
    );
    expect(stale.code).toBe('superseded');
  });

  it('refuses the fourth mail to one address in a day, across accounts', async () => {
    const w = world();
    const deps = { ...w.deps, mailer: w.mailer };
    await requestEmailChannel({ accountId: ACCOUNT, email: 'a@b.org' }, AT, deps);
    await requestEmailChannel({ accountId: ACCOUNT, email: 'a@b.org' }, AT + HOUR, deps);
    await requestEmailChannel({ accountId: OTHER, email: 'a@b.org' }, AT + 2 * HOUR, deps);
    const error = await refusal(
      requestEmailChannel({ accountId: OTHER, email: 'a@b.org' }, AT + 3 * HOUR, deps),
    );
    expect(error.code).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(21 * 3600);
    expect(w.mails).toHaveLength(3);
  });

  it('keeps counting after an unlink scrubs the endpoint', async () => {
    const w = world();
    const deps = { ...w.deps, mailer: w.mailer };
    for (let i = 0; i < 3; i += 1) {
      const r = await requestEmailChannel({ accountId: ACCOUNT, email: 'a@b.org' }, AT + i, deps);
      await unlinkChannel({ accountId: ACCOUNT, subscriptionId: r.subscriptionId }, AT + i, w.deps);
    }
    const error = await refusal(
      requestEmailChannel({ accountId: ACCOUNT, email: 'a@b.org' }, AT + 10, deps),
    );
    expect(error.code).toBe('rate_limited');
  });

  it('answers already_confirmed without a mail for a confirmed address', async () => {
    const w = world();
    const deps = { ...w.deps, mailer: w.mailer };
    const r = await requestEmailChannel({ accountId: ACCOUNT, email: 'a@b.org' }, AT, deps);
    await confirmEmailChannel({ token: w.mails[0]?.token ?? '' }, AT + 1, w.deps);
    const again = await requestEmailChannel({ accountId: ACCOUNT, email: 'a@b.org' }, AT + 2, deps);
    expect(again).toEqual({ status: 'already_confirmed', subscriptionId: r.subscriptionId });
    expect(w.mails).toHaveLength(1);
  });
});

describe('confirmEmailChannel', () => {
  async function pending() {
    const w = world();
    const r = await requestEmailChannel({ accountId: ACCOUNT, email: 'a@b.org' }, AT, {
      ...w.deps,
      mailer: w.mailer,
    });
    return { w, subscriptionId: r.subscriptionId, token: w.mails[0]?.token ?? '' };
  }

  it('confirms the subscription once; the second presentation is "used"', async () => {
    const { w, subscriptionId, token } = await pending();
    expect(await confirmEmailChannel({ token }, AT + HOUR, w.deps)).toEqual({ subscriptionId });
    expect(w.subs[0]?.confirmedAt).toBe(AT + HOUR);
    expect((await refusal(confirmEmailChannel({ token }, AT + HOUR, w.deps))).code).toBe('used');
  });

  it('refuses an expired, malformed, unknown or deleted-account token', async () => {
    const { w, token } = await pending();
    expect((await refusal(confirmEmailChannel({ token }, AT + 48 * HOUR, w.deps))).code).toBe(
      'expired',
    );
    expect((await refusal(confirmEmailChannel({ token: 'x' }, AT, w.deps))).code).toBe('unknown');
    expect((await refusal(confirmEmailChannel({ token: 'tok-999' }, AT, w.deps))).code).toBe(
      'unknown',
    );
    w.deleted.add(ACCOUNT);
    expect((await refusal(confirmEmailChannel({ token }, AT, w.deps))).code).toBe(
      'account_deleted',
    );
    expect(w.subs[0]?.confirmedAt).toBeNull();
  });

  it('refuses a token whose channel was unlinked', async () => {
    const { w, subscriptionId, token } = await pending();
    expect(await unlinkChannel({ accountId: ACCOUNT, subscriptionId }, AT + 1, w.deps)).toBe(true);
    expect((await refusal(confirmEmailChannel({ token }, AT + 2, w.deps))).code).toBe('revoked');
    expect(w.subs[0]).toMatchObject({ endpoint: '', confirmedAt: null });
  });

  it('refuses a Telegram token on the email route', async () => {
    const w = world();
    const link = await requestTelegramLink({ accountId: ACCOUNT }, AT, w.deps, ARMED);
    expect((await refusal(confirmEmailChannel({ token: link.token }, AT, w.deps))).code).toBe(
      'wrong_channel',
    );
  });
});

describe('requestTelegramLink', () => {
  it('refuses while the shipped policy leaves Telegram unarmed', async () => {
    const w = world();
    expect((await refusal(requestTelegramLink({ accountId: ACCOUNT }, AT, w.deps))).code).toBe(
      'unarmed',
    );
    expect(w.confirmations).toEqual([]);
  });

  it('issues a link with no subscription and supersedes the previous one', async () => {
    const w = world();
    const first = await requestTelegramLink({ accountId: ACCOUNT }, AT, w.deps, ARMED);
    await requestTelegramLink({ accountId: ACCOUNT }, AT + 1, w.deps, ARMED);
    expect(first.expiresAt).toBe(AT + HOUR);
    expect(w.confirmations.map((c) => [c.channelSubscriptionId, c.supersededAt])).toEqual([
      [null, AT + 1],
      [null, null],
    ]);
  });
});

describe('completeTelegramLink', () => {
  it('stores the chat id as a confirmed endpoint and consumes the token pointing at it', async () => {
    const w = world();
    const { token } = await requestTelegramLink({ accountId: ACCOUNT }, AT, w.deps, ARMED);
    const done = await completeTelegramLink({ chatId: '123456789', token }, AT + 1, w.deps);
    expect(done.outcome).toBe('linked');
    expect(w.subs).toEqual([
      {
        id: done.subscriptionId,
        accountId: ACCOUNT,
        channel: 'telegram',
        endpoint: '123456789',
        confirmedAt: AT + 1,
        revokedAt: null,
      },
    ]);
    expect(w.confirmations[0]).toMatchObject({
      consumedAt: AT + 1,
      channelSubscriptionId: done.subscriptionId,
    });
    expect(
      (await refusal(completeTelegramLink({ chatId: '123456789', token }, AT + 2, w.deps))).code,
    ).toBe('used');
  });

  it('answers already_linked for a chat the account has confirmed, without a second row', async () => {
    const w = world();
    const a = await requestTelegramLink({ accountId: ACCOUNT }, AT, w.deps, ARMED);
    await completeTelegramLink({ chatId: '5', token: a.token }, AT + 1, w.deps);
    const b = await requestTelegramLink({ accountId: ACCOUNT }, AT + 2, w.deps, ARMED);
    const again = await completeTelegramLink({ chatId: '5', token: b.token }, AT + 3, w.deps);
    expect(again.outcome).toBe('already_linked');
    expect(w.subs).toHaveLength(1);
  });

  it('confirms a pre-012 pending row rather than duplicating it', async () => {
    const w = world();
    w.subs.push({
      id: 'legacy',
      accountId: ACCOUNT,
      channel: 'telegram',
      endpoint: '5',
      confirmedAt: null,
      revokedAt: null,
    });
    const { token } = await requestTelegramLink({ accountId: ACCOUNT }, AT, w.deps, ARMED);
    expect(await completeTelegramLink({ chatId: '5', token }, AT + 1, w.deps)).toEqual({
      outcome: 'linked',
      subscriptionId: 'legacy',
    });
    expect(w.subs).toHaveLength(1);
    expect(w.subs[0]?.confirmedAt).toBe(AT + 1);
  });

  it('refuses an expired link and an email token', async () => {
    const w = world();
    const { token } = await requestTelegramLink({ accountId: ACCOUNT }, AT, w.deps, ARMED);
    expect(
      (await refusal(completeTelegramLink({ chatId: '5', token }, AT + HOUR, w.deps))).code,
    ).toBe('expired');
    await requestEmailChannel({ accountId: ACCOUNT, email: 'a@b.org' }, AT, {
      ...w.deps,
      mailer: w.mailer,
    });
    const emailToken = w.mails[0]?.token ?? '';
    expect(
      (await refusal(completeTelegramLink({ chatId: '5', token: emailToken }, AT, w.deps))).code,
    ).toBe('wrong_channel');
    expect(w.subs.filter((s) => s.channel === 'telegram')).toEqual([]);
  });
});

describe('acknowledgeTelegramLink', () => {
  it('passes only the chat id and the outcome, and swallows a Bot API failure', async () => {
    const sent: unknown[][] = [];
    const bot: TelegramBotApi = {
      acknowledgeLink: (...args) => {
        sent.push(args);
        return Promise.resolve();
      },
    };
    expect(await acknowledgeTelegramLink(bot, '5', 'linked')).toBe(true);
    expect(sent).toEqual([['5', 'linked']]);
    const down: TelegramBotApi = { acknowledgeLink: () => Promise.reject(new Error('502')) };
    expect(await acknowledgeTelegramLink(down, '5', 'refused')).toBe(false);
  });
});

describe('unlinkChannel', () => {
  it('scrubs the endpoint, revokes open confirmations, and ignores another account', async () => {
    const w = world();
    const r = await requestEmailChannel({ accountId: ACCOUNT, email: 'a@b.org' }, AT, {
      ...w.deps,
      mailer: w.mailer,
    });
    expect(
      await unlinkChannel({ accountId: OTHER, subscriptionId: r.subscriptionId }, AT, w.deps),
    ).toBe(false);
    expect(w.subs[0]?.endpoint).toBe('a@b.org');
    expect(
      await unlinkChannel({ accountId: ACCOUNT, subscriptionId: r.subscriptionId }, AT, w.deps),
    ).toBe(true);
    expect(w.subs[0]).toMatchObject({ endpoint: '', revokedAt: AT });
    expect(w.confirmations[0]?.revokedAt).toBe(AT);
    expect(
      await unlinkChannel({ accountId: ACCOUNT, subscriptionId: r.subscriptionId }, AT, w.deps),
    ).toBe(false);
  });
});
