/**
 * The sign-in state holder: controls stay hidden until the server answers 200 or 401, the
 * landing token is handed out exactly once, and a missing client reads as `unavailable`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient, SessionState } from '../core/auth/sign-in.js';
import {
  authAvailability,
  authClient,
  authSession,
  consumeSignInToken,
  holdSignInToken,
  noteSession,
  refreshSession,
  setAuthClient,
} from './auth.js';

function clientAnswering(state: SessionState): AuthClient {
  return {
    session: vi.fn(() => Promise.resolve(state)),
    requestLink: vi.fn(),
    continueSignIn: vi.fn(),
    signOut: vi.fn(),
  };
}

afterEach(() => {
  setAuthClient(null);
  holdSignInToken({ kind: 'none' });
  authSession.value = 'unknown';
});

describe('auth session', () => {
  it('hides sign-in until the server has answered', () => {
    expect(authSession.value).toBe('unknown');
    expect(authAvailability.value).toBe('unavailable');
  });

  it('shows sign-in for signed-in and signed-out, hides it for the rest', () => {
    noteSession('signed-in');
    expect(authAvailability.value).toBe('available');
    noteSession('signed-out');
    expect(authAvailability.value).toBe('available');
    authSession.value = 'unavailable';
    expect(authAvailability.value).toBe('unavailable');
  });

  it('refreshSession reads the wired client and records its answer', async () => {
    const client = clientAnswering('signed-out');
    setAuthClient(client);
    expect(authClient()).toBe(client);
    await expect(refreshSession()).resolves.toBe('signed-out');
    expect(authSession.value).toBe('signed-out');
    expect(authAvailability.value).toBe('available');
  });

  it('refreshSession is unavailable when no client was wired', async () => {
    await expect(refreshSession()).resolves.toBe('unavailable');
    expect(authSession.value).toBe('unavailable');
  });
});

describe('held sign-in token', () => {
  it('is none until boot holds one', () => {
    expect(consumeSignInToken()).toEqual({ kind: 'none' });
  });

  it('is handed out once, then gone', () => {
    holdSignInToken({ kind: 'token', token: 'abc' });
    expect(consumeSignInToken()).toEqual({ kind: 'token', token: 'abc' });
    expect(consumeSignInToken()).toEqual({ kind: 'none' });
  });

  it('keeps a malformed marker the same way', () => {
    holdSignInToken({ kind: 'malformed' });
    expect(consumeSignInToken()).toEqual({ kind: 'malformed' });
    expect(consumeSignInToken()).toEqual({ kind: 'none' });
  });
});
