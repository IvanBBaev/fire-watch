/**
 * The web side of `GET|PUT /api/v1/account/preferences` (TASKS V2-C5): one read, one
 * conditional write, each reduced to an outcome the sync loop can act on. Never throws;
 * a network failure is an outcome like any other, because sync is a nicety and nothing
 * on screen may wait for it or break on it.
 *
 * Request shape as `sign-in.ts`: same-origin, the session cookie included, nothing
 * cached. The PUT carries `If-Match` with the revision the write was based on; the
 * browser adds the `Origin` the server checks.
 */

import type { AccountPreferences, AccountPreferencesState } from '@fire-watch/contracts';
import {
  ACCOUNT_PREFERENCES_SCHEMA,
  parseAccountPreferencesDocument,
  preferencesEtag,
} from '@fire-watch/contracts';

export const ACCOUNT_PREFERENCES_URL = '/api/v1/account/preferences';

/** A state the server answered, reduced to what the web keeps: revision and preferences. */
export interface RemotePreferences {
  readonly revision: number;
  readonly preferences: AccountPreferences;
}

export type ReadPreferencesOutcome =
  | { readonly kind: 'read'; readonly remote: RemotePreferences }
  /** 401: no session (any more). */
  | { readonly kind: 'signed-out' }
  /** 404/405: the route is not served here — sync does not exist on this deployment. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

export type WritePreferencesOutcome =
  | { readonly kind: 'written'; readonly remote: RemotePreferences }
  /** 409, or 428: another device wrote first; read again, merge, retry. */
  | { readonly kind: 'conflict' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unavailable' }
  /** 422/413 or anything else: this write will not succeed as it is. */
  | { readonly kind: 'failed' };

export interface PreferencesClient {
  read(): Promise<ReadPreferencesOutcome>;
  write(preferences: AccountPreferences, basedOn: number): Promise<WritePreferencesOutcome>;
}

export interface PreferencesClientDeps {
  readonly fetchFn: (input: string, init: RequestInit) => Promise<Response>;
}

const BASE_INIT: RequestInit = {
  credentials: 'same-origin',
  cache: 'no-store',
  referrerPolicy: 'strict-origin',
};

/** A body the server answered 200 with, or `null` when it is not a state. */
export function remoteFromBody(body: unknown): RemotePreferences | null {
  if (typeof body !== 'object' || body === null) return null;
  const { revision, document } = body as Partial<AccountPreferencesState>;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return null;
  }
  const parsed = parseAccountPreferencesDocument(document);
  return parsed.ok ? { revision, preferences: parsed.document.preferences } : null;
}

async function remoteOf(response: Response): Promise<RemotePreferences | null> {
  try {
    return remoteFromBody(await response.json());
  } catch {
    return null;
  }
}

function isAbsent(status: number): boolean {
  return status === 404 || status === 405;
}

export function createPreferencesClient({ fetchFn }: PreferencesClientDeps): PreferencesClient {
  return {
    async read() {
      try {
        const response = await fetchFn(ACCOUNT_PREFERENCES_URL, {
          ...BASE_INIT,
          method: 'GET',
          headers: { accept: 'application/json' },
        });
        if (response.status === 401) return { kind: 'signed-out' };
        if (isAbsent(response.status)) return { kind: 'unavailable' };
        const remote = response.ok ? await remoteOf(response) : null;
        return remote === null ? { kind: 'failed' } : { kind: 'read', remote };
      } catch {
        return { kind: 'failed' };
      }
    },

    async write(preferences, basedOn) {
      try {
        const response = await fetchFn(ACCOUNT_PREFERENCES_URL, {
          ...BASE_INIT,
          method: 'PUT',
          headers: {
            accept: 'application/json, application/problem+json',
            'content-type': 'application/json',
            'if-match': preferencesEtag(basedOn),
          },
          body: JSON.stringify({ schema: ACCOUNT_PREFERENCES_SCHEMA, preferences }),
        });
        if (response.status === 409 || response.status === 428) return { kind: 'conflict' };
        if (response.status === 401) return { kind: 'signed-out' };
        if (isAbsent(response.status)) return { kind: 'unavailable' };
        const remote = response.ok ? await remoteOf(response) : null;
        return remote === null ? { kind: 'failed' } : { kind: 'written', remote };
      } catch {
        return { kind: 'failed' };
      }
    },
  };
}
