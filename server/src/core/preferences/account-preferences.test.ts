import { ACCOUNT_PREFERENCES_SCHEMA, EMPTY_ACCOUNT_PREFERENCES } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import type { AccountPreferencesStore } from '../ports/account-preferences-store.js';
import { readAccountPreferences, writeAccountPreferences } from './account-preferences.js';

const ACCOUNT = '66666666-0000-4000-8000-000000000001';
const AT = '2026-10-27T08:00:00.000Z';
const DARK = { schema: ACCOUNT_PREFERENCES_SCHEMA, preferences: { theme: 'dark' } };

function storeAnswering(revision: number | null) {
  const writes: unknown[][] = [];
  const store: Pick<AccountPreferencesStore, 'write'> = {
    write: (...args) => {
      writes.push(args);
      return Promise.resolve(revision);
    },
  };
  return { store, writes };
}

describe('readAccountPreferences', () => {
  it('answers revision 0 and the empty document when nothing is stored', async () => {
    await expect(
      readAccountPreferences(ACCOUNT, { read: () => Promise.resolve(null) }),
    ).resolves.toEqual({ revision: 0, document: EMPTY_ACCOUNT_PREFERENCES });
  });

  it('serves a stored document as it is', async () => {
    await expect(
      readAccountPreferences(ACCOUNT, {
        read: () => Promise.resolve({ revision: 3, document: DARK }),
      }),
    ).resolves.toEqual({ revision: 3, document: DARK });
  });

  it('serves a row that no longer parses as empty, keeping its revision', async () => {
    await expect(
      readAccountPreferences(ACCOUNT, {
        read: () => Promise.resolve({ revision: 9, document: { schema: 'later' } }),
      }),
    ).resolves.toEqual({ revision: 9, document: EMPTY_ACCOUNT_PREFERENCES });
  });
});

describe('writeAccountPreferences', () => {
  it('writes the parsed document from the expected revision', async () => {
    const { store, writes } = storeAnswering(4);
    await expect(
      writeAccountPreferences({ accountId: ACCOUNT, expectedRevision: 3, body: DARK }, AT, store),
    ).resolves.toEqual({ kind: 'written', state: { revision: 4, document: DARK } });
    expect(writes).toEqual([[ACCOUNT, DARK, 3, AT]]);
  });

  it('answers a conflict when the store moved nothing', async () => {
    const { store } = storeAnswering(null);
    await expect(
      writeAccountPreferences({ accountId: ACCOUNT, expectedRevision: 1, body: DARK }, AT, store),
    ).resolves.toEqual({ kind: 'conflict' });
  });

  it('refuses an invalid body without reaching the store', async () => {
    const { store, writes } = storeAnswering(1);
    const outcome = await writeAccountPreferences(
      { accountId: ACCOUNT, expectedRevision: 0, body: { ...DARK, extra: true } },
      AT,
      store,
    );
    expect(outcome.kind).toBe('invalid');
    expect(writes).toEqual([]);
  });
});
