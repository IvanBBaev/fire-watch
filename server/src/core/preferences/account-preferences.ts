/**
 * Reading and writing a signed-in account's synced preferences (TASKS V2-C5).
 *
 * The server's part of cross-device sync is deliberately small: it keeps one validated
 * document per account and refuses a write that was based on a revision that is no longer
 * the stored one. It never merges — merging needs to know what the reader changed on this
 * device since the last sync, which only the device knows (`web/src/core/preferences`).
 *
 * **Validation is the contract's.** `parseAccountPreferencesDocument` decides what a
 * document is, on the way in and again on the way out: a stored row that no longer parses
 * (a later schema written by a newer build, then a rollback) is served as "nothing
 * stored" with its revision kept, so the client's next write still has to name it and
 * cannot silently clobber what the newer build wrote without a conflict first.
 */

import {
  EMPTY_ACCOUNT_PREFERENCES,
  parseAccountPreferencesDocument,
  type AccountPreferencesIssue,
  type AccountPreferencesState,
} from '@fire-watch/contracts';

import type { AccountPreferencesStore } from '../ports/account-preferences-store.js';

export async function readAccountPreferences(
  accountId: string,
  store: Pick<AccountPreferencesStore, 'read'>,
): Promise<AccountPreferencesState> {
  const stored = await store.read(accountId);
  if (stored === null) return { revision: 0, document: EMPTY_ACCOUNT_PREFERENCES };
  const parsed = parseAccountPreferencesDocument(stored.document);
  return {
    revision: stored.revision,
    document: parsed.ok ? parsed.document : EMPTY_ACCOUNT_PREFERENCES,
  };
}

export interface WriteAccountPreferencesRequest {
  readonly accountId: string;
  /** The revision the client based this write on; `0` when it read nothing stored. */
  readonly expectedRevision: number;
  /** The untrusted request body. */
  readonly body: unknown;
}

export type WriteAccountPreferencesOutcome =
  | { readonly kind: 'written'; readonly state: AccountPreferencesState }
  | { readonly kind: 'invalid'; readonly issue: AccountPreferencesIssue }
  | { readonly kind: 'conflict' };

export async function writeAccountPreferences(
  request: WriteAccountPreferencesRequest,
  atIso: string,
  store: Pick<AccountPreferencesStore, 'write'>,
): Promise<WriteAccountPreferencesOutcome> {
  const parsed = parseAccountPreferencesDocument(request.body);
  if (!parsed.ok) return { kind: 'invalid', issue: parsed.issue };
  const revision = await store.write(
    request.accountId,
    parsed.document,
    request.expectedRevision,
    atIso,
  );
  if (revision === null) return { kind: 'conflict' };
  return { kind: 'written', state: { revision, document: parsed.document } };
}
