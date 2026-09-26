/**
 * Sign-in state as signals (TASKS I1): the auth client boot constructed, the one-shot
 * token boot took out of the URL, and what the server last said about this browser's
 * session.
 *
 * A module holder rather than `AppServices` fields, like `imagery.ts`: the auth surfaces
 * are lazy pages and one Settings section, and nothing else in the app needs them.
 *
 * **Absent by default.** Until `GET /api/v1/account` answers 200 or 401, every sign-in
 * entry point stays hidden; a deployment with auth off (the route answers 404) shows no
 * control, no banner and no error — the feature is simply not there.
 */

import { computed, signal } from '@preact/signals';

import type {
  AuthAvailability,
  AuthClient,
  SessionState,
  TakenToken,
} from '../core/auth/sign-in.js';
import { availabilityOf } from '../core/auth/sign-in.js';

let client: AuthClient | null = null;
let heldToken: TakenToken = { kind: 'none' };

/** The session as last seen; `unknown` until a surface that needs it has asked. */
export const authSession = signal<SessionState>('unknown');

/** Whether to show sign-in controls at all: only once the server answered 200 or 401. */
export const authAvailability = computed<AuthAvailability>(() => availabilityOf(authSession.value));

/** Boot's sink: the only place the client is constructed. */
export function setAuthClient(next: AuthClient | null): void {
  client = next;
}

export function authClient(): AuthClient | null {
  return client;
}

/** Boot's sink for what `takeSignInToken` read before anything else ran. */
export function holdSignInToken(taken: TakenToken): void {
  heldToken = taken;
}

/**
 * Hand the held token to the landing page, once. A second read (a re-mount, a back
 * navigation) gets `none`: the token is not kept anywhere a later render could reach it.
 */
export function consumeSignInToken(): TakenToken {
  const taken = heldToken;
  heldToken = { kind: 'none' };
  return taken;
}

/** Ask the server whether this browser is signed in; `unavailable` when no client was wired. */
export async function refreshSession(): Promise<SessionState> {
  const state = client === null ? 'unavailable' : await client.session();
  authSession.value = state;
  return state;
}

/** Record what a sign-in or sign-out just did, without asking the server again. */
export function noteSession(state: 'signed-in' | 'signed-out'): void {
  authSession.value = state;
}
