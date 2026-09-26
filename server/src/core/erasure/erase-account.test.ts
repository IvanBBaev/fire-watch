import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import type {
  AccountErasureStore,
  ErasureRecord,
  LockedAccount,
} from '../ports/account-erasure-store.js';
import { eraseAccount } from './erase-account.js';
import { ERASURE_HORIZON } from './erasure-horizon.js';
import { ERASURE_PLAN_VERSION } from './erasure-plan.js';

const AT = epochMsFromIso('2026-09-23T10:00:00Z');
const ACCOUNT = '88888888-0000-4000-8000-000000000001';
const ZONES = ['88888888-0000-4000-8000-0000000000a1', '88888888-0000-4000-8000-0000000000a2'];

/** Records every call in order; answers with fixed counts. */
function recordingStore(account: LockedAccount, zoneIds: readonly string[] = ZONES) {
  const calls: string[] = [];
  const args: Record<string, unknown[]> = {};
  const note = (name: string, ...values: unknown[]) => {
    calls.push(name);
    args[name] = values;
  };
  const records: ErasureRecord[] = [];
  const store: AccountErasureStore = {
    lockAccount: (id) => {
      note('lockAccount', id);
      return Promise.resolve(account);
    },
    lockZones: (id) => {
      note('lockZones', id);
      return Promise.resolve(zoneIds);
    },
    cancelAndPseudonymizeOutbox: (ids, atIso, keys) => {
      note('cancelAndPseudonymizeOutbox', ids, atIso, keys);
      return Promise.resolve({ cancelled: 2, pseudonymized: 5 });
    },
    deleteAlertStates: (ids) => {
      note('deleteAlertStates', ids);
      return Promise.resolve(3);
    },
    deleteZones: (ids) => {
      note('deleteZones', ids);
      return Promise.resolve({ zones: ids.length, shadowAlerts: 4, decisionLog: 6, digestLog: 5 });
    },
    deleteChannelConfirmations: (id) => {
      note('deleteChannelConfirmations', id);
      return Promise.resolve(7);
    },
    deleteSubscriptions: (id) => {
      note('deleteSubscriptions', id);
      return Promise.resolve(1);
    },
    deleteSessions: (id) => {
      note('deleteSessions', id);
      return Promise.resolve(2);
    },
    deleteLinkRequests: (email) => {
      note('deleteLinkRequests', email);
      return Promise.resolve(6);
    },
    tombstoneAccount: (id, atIso) => {
      note('tombstoneAccount', id, atIso);
      return Promise.resolve();
    },
    record: (entry) => {
      note('record');
      records.push(entry);
      return Promise.resolve();
    },
  };
  return { store, calls, args, records };
}

describe('eraseAccount', () => {
  it('runs the steps in the locking order the adapter relies on', async () => {
    const { store, calls } = recordingStore({ state: 'live', email: 'a@example.org' });
    await eraseAccount(ACCOUNT, AT, store);
    expect(calls).toEqual([
      'lockAccount',
      'lockZones',
      'cancelAndPseudonymizeOutbox',
      'deleteAlertStates',
      'deleteZones',
      'deleteChannelConfirmations',
      'deleteSubscriptions',
      'deleteSessions',
      'deleteLinkRequests',
      'tombstoneAccount',
      'record',
    ]);
  });

  it('reports every count, the deadline 30 days out, and records the same', async () => {
    const { store, records, args } = recordingStore({ state: 'live', email: 'a@example.org' });
    const outcome = await eraseAccount(ACCOUNT, AT, store);
    const counts = {
      outboxCancelled: 2,
      outboxPseudonymized: 5,
      alertStates: 3,
      shadowAlerts: 4,
      decisionLog: 6,
      digestLog: 5,
      zones: 2,
      channelConfirmations: 7,
      subscriptions: 1,
      sessions: 2,
      linkRequests: 6,
    };
    expect(outcome).toEqual({
      status: 'erased',
      erasedAt: AT,
      deadline: AT + ERASURE_HORIZON.horizonDays * 86_400_000,
      counts,
    });
    expect(records).toEqual([
      {
        accountId: ACCOUNT,
        erasedAtIso: '2026-09-23T10:00:00Z',
        deadlineIso: '2026-10-23T10:00:00Z',
        planVersion: ERASURE_PLAN_VERSION,
        counts,
      },
    ]);
    expect(args['cancelAndPseudonymizeOutbox']).toEqual([ZONES, '2026-09-23T10:00:00Z', []]);
    expect(args['deleteLinkRequests']).toEqual(['a@example.org']);
  });

  it('passes the retained template keys it is given', async () => {
    const { store, args } = recordingStore({ state: 'live', email: null });
    await eraseAccount(ACCOUNT, AT, store, { retainedParamKeys: ['band'] });
    expect(args['cancelAndPseudonymizeOutbox']?.[2]).toEqual(['band']);
  });

  it('skips the zone steps when the account has no zones', async () => {
    const { store, calls } = recordingStore({ state: 'live', email: 'a@example.org' }, []);
    const outcome = await eraseAccount(ACCOUNT, AT, store);
    expect(calls).not.toContain('cancelAndPseudonymizeOutbox');
    expect(calls).not.toContain('deleteAlertStates');
    expect(calls).not.toContain('deleteZones');
    expect(outcome).toMatchObject({
      status: 'erased',
      counts: {
        outboxCancelled: 0,
        outboxPseudonymized: 0,
        alertStates: 0,
        zones: 0,
        shadowAlerts: 0,
        decisionLog: 0,
        digestLog: 0,
      },
    });
  });

  it('skips the link requests when the account has no address', async () => {
    const { store, calls } = recordingStore({ state: 'live', email: null });
    const outcome = await eraseAccount(ACCOUNT, AT, store);
    expect(calls).not.toContain('deleteLinkRequests');
    expect(outcome).toMatchObject({ counts: { linkRequests: 0 } });
  });

  it('touches nothing for an account already erased', async () => {
    const { store, calls } = recordingStore({ state: 'erased' });
    expect(await eraseAccount(ACCOUNT, AT, store)).toEqual({ status: 'already_erased' });
    expect(calls).toEqual(['lockAccount']);
  });

  it('touches nothing for a missing account', async () => {
    const { store, calls } = recordingStore({ state: 'missing' });
    expect(await eraseAccount(ACCOUNT, AT, store)).toEqual({ status: 'missing' });
    expect(calls).toEqual(['lockAccount']);
  });

  it('stops at the first failing step and records nothing', async () => {
    const { store, calls, records } = recordingStore({ state: 'live', email: null });
    const failing: AccountErasureStore = {
      ...store,
      deleteZones: () => Promise.reject(new Error('fk violation')),
    };
    await expect(eraseAccount(ACCOUNT, AT, failing)).rejects.toThrow('fk violation');
    expect(calls).not.toContain('tombstoneAccount');
    expect(records).toEqual([]);
  });
});
