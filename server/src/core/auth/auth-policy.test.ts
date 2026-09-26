import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import {
  AUTH_POLICY,
  decideLinkIssue,
  evaluateLink,
  isAllowedOrigin,
  isSessionLive,
  normalizeEmail,
  slidingExpiry,
  uaFamily,
  type PendingLink,
} from './auth-policy.js';

const AT = epochMsFromIso('2026-08-20T05:20:00Z');
const MINUTE = 60_000;

describe('the policy numbers are the ones 05 states', () => {
  it('15-minute links, 3 per address per hour, 30-day sliding sessions', () => {
    expect(AUTH_POLICY).toEqual({
      linkTtlMs: 15 * MINUTE,
      linkIssuesPerWindow: 3,
      linkIssueWindowMs: 60 * MINUTE,
      sessionSlidingMs: 30 * 24 * 60 * MINUTE,
    });
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases, and nothing more', () => {
    expect(normalizeEmail('  Ivan.B+fires@Example.BG ')).toBe('ivan.b+fires@example.bg');
  });

  it.each([
    '',
    'no-at-sign',
    'a@b',
    '@example.bg',
    'a@@example.bg',
    'a b@example.bg',
    'a@ex\nample.bg',
  ])('refuses %j', (raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });

  it('refuses an address longer than RFC 5321 allows', () => {
    expect(normalizeEmail(`${'a'.repeat(250)}@x.bg`)).toBeNull();
  });

  it('always yields what migration 007 CHECKs: lower(btrim(email)) = email', () => {
    fc.assert(
      fc.property(fc.emailAddress(), fc.constantFrom('', ' ', '\t'), (email, pad) => {
        const normalized = normalizeEmail(`${pad}${email.toUpperCase()}${pad}`);
        if (normalized !== null) expect(normalized).toBe(normalized.trim().toLowerCase());
      }),
    );
  });
});

describe('uaFamily', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'chrome',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
      'edge',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'firefox'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
      'safari',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      'safari-mobile',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      'samsung-mobile',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      'other-mobile',
    ],
    [undefined, 'other'],
  ])('%s -> %s', (ua, family) => {
    expect(uaFamily(ua)).toBe(family);
  });

  it('ignores versions, so a browser that updates between request and click still matches', () => {
    const before = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
    expect(uaFamily(before)).toBe(uaFamily(before.replaceAll('130.0', '131.0')));
  });
});

describe('isAllowedOrigin', () => {
  const allowed = ['https://fire-watch.example'];

  it('accepts exactly a configured origin', () => {
    expect(isAllowedOrigin('https://fire-watch.example', allowed)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'null',
    'https://evil.example',
    'https://fire-watch.example.evil',
    'http://fire-watch.example',
  ])('refuses %j', (origin) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(false);
  });
});

describe('decideLinkIssue', () => {
  it('allows three inside an hour and sets a 15-minute expiry', () => {
    expect(decideLinkIssue([AT - 50 * MINUTE, AT - 10 * MINUTE], AT)).toEqual({
      allowed: true,
      expiresAt: AT + 15 * MINUTE,
    });
  });

  it('refuses the fourth, until the oldest leaves the window', () => {
    expect(decideLinkIssue([AT - 50 * MINUTE, AT - 20 * MINUTE, AT - MINUTE], AT)).toEqual({
      allowed: false,
      retryAfterSeconds: 600,
    });
  });

  it('forgets an issuance exactly one hour old', () => {
    expect(decideLinkIssue([AT - 60 * MINUTE, AT - 2, AT - 1], AT).allowed).toBe(true);
  });

  it('never lets a fourth through inside any hour (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 * 60 * MINUTE }), { maxLength: 30 }),
        (offsets) => {
          // Replays a stream of requests through the rule, keeping only what it allowed.
          const issued: number[] = [];
          for (const at of [...offsets].sort((a, b) => a - b)) {
            if (decideLinkIssue(issued, at).allowed) issued.push(at);
          }
          for (const at of issued) {
            const inHour = issued.filter((other) => other > at - 60 * MINUTE && other <= at);
            expect(inHour.length).toBeLessThanOrEqual(3);
          }
        },
      ),
    );
  });
});

describe('evaluateLink', () => {
  const open: PendingLink = {
    uaFamily: 'firefox',
    expiresAt: AT + 15 * MINUTE,
    consumedAt: null,
    supersededAt: null,
  };

  it('honours an open, unexpired link from the same UA family', () => {
    expect(evaluateLink(open, 'firefox', AT)).toBeNull();
  });

  it.each([
    ['unknown', null, 'firefox', AT],
    ['used', { ...open, consumedAt: AT - MINUTE, expiresAt: AT - 1 }, 'firefox', AT],
    ['superseded', { ...open, supersededAt: AT - MINUTE }, 'firefox', AT],
    ['expired', open, 'firefox', AT + 15 * MINUTE],
    ['other_browser', open, 'chrome', AT],
  ] as const)('refuses as %s', (reason, link, family, at) => {
    expect(evaluateLink(link, family, at)).toBe(reason);
  });
});

describe('sessions', () => {
  it('slides thirty days from the last use', () => {
    expect(slidingExpiry(AT)).toBe(AT + 30 * 24 * 60 * MINUTE);
  });

  it('is live until expiry and never once revoked', () => {
    expect(isSessionLive({ expiresAt: AT + 1, revokedAt: null }, AT)).toBe(true);
    expect(isSessionLive({ expiresAt: AT, revokedAt: null }, AT)).toBe(false);
    expect(isSessionLive({ expiresAt: AT + 1, revokedAt: AT - 1 }, AT)).toBe(false);
  });
});
