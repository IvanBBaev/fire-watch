import { lintAlertText } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import {
  renderSignInMail,
  SIGN_IN_MAIL_COPY,
  SIGN_IN_MAIL_COPY_KEYS,
  SIGN_IN_MAIL_COPY_PENDING_FOUNDER_REVIEW,
} from './sign-in-mail-copy.js';

const TOKEN = 'T'.repeat(43);
const LINK = `https://app.example.invalid/sign-in#token=${TOKEN}`;

describe('sign-in mail copy (I1)', () => {
  it('registers every entry as own-voice and pending founder review', () => {
    expect(SIGN_IN_MAIL_COPY_PENDING_FOUNDER_REVIEW).toEqual(SIGN_IN_MAIL_COPY_KEYS);
    for (const key of SIGN_IN_MAIL_COPY_KEYS) {
      expect(SIGN_IN_MAIL_COPY[key].origin).toMatch(/pending founder review/u);
    }
  });

  it('passes the never-send lint in every locale', () => {
    for (const key of SIGN_IN_MAIL_COPY_KEYS) {
      for (const text of Object.values(SIGN_IN_MAIL_COPY[key].text)) {
        expect(lintAlertText(text, { voice: 'own' })).toEqual([]);
      }
    }
  });

  it('renders both languages, Bulgarian first, with the link and the lifetime', () => {
    const mail = renderSignInMail({ link: LINK, ttlMinutes: 15 });
    expect(mail.subject).toBe('Fire Watch: линк за вход / Fire Watch: sign-in link');
    expect(mail.text.indexOf('Поискахте')).toBeLessThan(mail.text.indexOf('You asked'));
    expect(mail.text.split(LINK)).toHaveLength(3);
    expect(mail.text).toContain('15 минути');
    expect(mail.text).toContain('15 minutes');
    expect(mail.text).not.toMatch(/\{[a-z]+\}/u);
  });

  it('places a link holding `$` patterns verbatim', () => {
    const link = 'https://app.example.invalid/#token=a$&b$1';
    expect(renderSignInMail({ link, ttlMinutes: 15 }).text).toContain(link);
  });

  it('refuses a lifetime that is not a positive whole number of minutes', () => {
    for (const ttlMinutes of [0, -1, 1.5, Number.NaN]) {
      expect(() => renderSignInMail({ link: LINK, ttlMinutes })).toThrow(RangeError);
    }
  });
});
