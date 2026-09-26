import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import {
  clearedSessionCookie,
  readSessionCookie,
  SESSION_COOKIE_NAME,
  sessionCookie,
} from './session-cookie.js';

const AT = epochMsFromIso('2026-08-20T05:20:00Z');
const TOKEN = 'A'.repeat(43);

describe('the session cookie', () => {
  it('carries every C1 attribute, under a __Host- name', () => {
    const cookie = sessionCookie(TOKEN, AT + 30 * 86_400_000, AT);
    expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(cookie).toBe(
      `${SESSION_COOKIE_NAME}=${TOKEN}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
    );
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('never has a negative Max-Age', () => {
    expect(sessionCookie(TOKEN, AT - 1000, AT)).toMatch(/Max-Age=0$/);
  });

  it('clears with an empty value and Max-Age=0', () => {
    expect(clearedSessionCookie()).toBe(
      `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    );
  });

  it.each([
    [undefined, undefined],
    ['', undefined],
    ['other=1', undefined],
    [`${SESSION_COOKIE_NAME}=`, undefined],
    [`${SESSION_COOKIE_NAME}=${TOKEN}`, TOKEN],
    [`a=1; ${SESSION_COOKIE_NAME}=${TOKEN}; b=2`, TOKEN],
    [`x${SESSION_COOKIE_NAME}=nope; ${SESSION_COOKIE_NAME}=${TOKEN}`, TOKEN],
    [`${SESSION_COOKIE_NAME}=first; ${SESSION_COOKIE_NAME}=second`, 'first'],
  ])('reads %j as %j', (header, expected) => {
    expect(readSessionCookie(header)).toBe(expected);
  });
});
