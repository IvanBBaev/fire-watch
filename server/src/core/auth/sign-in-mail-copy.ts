/**
 * The magic-link mail, as copy (TASKS I1; 05 §5.4.1 C2).
 *
 * The same shape as the alert catalog (`../alerts/templates/alert-copy.ts`): plain strings
 * with `{slot}` markers, per locale, each with its governance and origin. Every entry here
 * is **own-voice and pending founder review** ({@link SIGN_IN_MAIL_COPY_PENDING_FOUNDER_REVIEW}):
 * an implementer drafted it and nobody has signed it off. Unlike an alert template, a
 * pending entry is still sent — sign-in cannot wait on a copy review — which is exactly why
 * the register exists and why the drafts say no more than the mechanics require.
 *
 * **Bilingual, Bulgarian first.** The request that mints a link carries no locale (the
 * route takes an address and nothing else, and 05 does not say where a locale would come
 * from), so one mail carries both languages. Choosing per recipient is a founder decision.
 *
 * **Linted like an alert.** A sign-in mail is not an alert, but it is text this product
 * sends in its own voice, and the never-send list is about what we must never say to
 * anyone. {@link renderSignInMail} runs {@link lintAlertText} over the subject and the
 * body before the link goes in, and refuses with {@link NeverSendError} — so the lint
 * never sees, and a finding never quotes, a token.
 */

import { lintAlertText, NeverSendError, type NeverSendViolation } from '@fire-watch/contracts';

import type { CopyEntry } from '../alerts/templates/alert-copy.js';
import { PRODUCT_NAME } from '../snapshot/snapshot-builder.js';

const DRAFTED = 'I1 draft, pending founder review';

export const SIGN_IN_MAIL_COPY = {
  subject: {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      bg: '{product}: линк за вход',
      en: '{product}: sign-in link',
    },
  },
  body: {
    governance: 'own-voice',
    origin: DRAFTED,
    text: {
      bg:
        'Поискахте вход в {product}. Отворете линка по-долу в същия браузър, от който го ' +
        'поискахте, и потвърдете входа:\n\n{link}\n\n' +
        'Линкът важи {minutes} минути и може да се използва само веднъж. Ако не сте ' +
        'поискали вход, не отваряйте линка — без него нищо не се променя.',
      en:
        'You asked to sign in to {product}. Open the link below in the same browser you ' +
        'asked from, then confirm the sign-in:\n\n{link}\n\n' +
        'The link works for {minutes} minutes and only once. If you did not ask to sign ' +
        'in, do not open the link — nothing changes without it.',
    },
  },
} as const satisfies Readonly<Record<string, CopyEntry>>;

export type SignInMailCopyKey = keyof typeof SIGN_IN_MAIL_COPY;

export const SIGN_IN_MAIL_COPY_KEYS = Object.keys(SIGN_IN_MAIL_COPY) as SignInMailCopyKey[];

/** Every own-voice entry nobody has reviewed yet — today, all of them. */
export const SIGN_IN_MAIL_COPY_PENDING_FOUNDER_REVIEW: readonly SignInMailCopyKey[] =
  SIGN_IN_MAIL_COPY_KEYS.filter((key) => SIGN_IN_MAIL_COPY[key].governance === 'own-voice');

/** The order the two languages appear in, and the rule between them. */
const LOCALE_ORDER = ['bg', 'en'] as const;
const LOCALE_SEPARATOR = '\n\n———\n\n';
const LINK_SLOT = '{link}';

export interface SignInMail {
  readonly subject: string;
  readonly text: string;
}

export interface SignInMailInput {
  /** The full link, token included. Never linted, never quoted in an error. */
  readonly link: string;
  readonly ttlMinutes: number;
}

/**
 * The subject and the plain-text body. Throws {@link NeverSendError} when the copy fails
 * the lint — the text is linted with the `{link}` marker still in place, so neither the
 * lint nor its error ever holds the token.
 */
export function renderSignInMail(input: SignInMailInput): SignInMail {
  if (!Number.isInteger(input.ttlMinutes) || input.ttlMinutes <= 0) {
    throw new RangeError('sign-in link lifetime must be a positive whole number of minutes');
  }
  const minutes = String(input.ttlMinutes);
  const subject = LOCALE_ORDER.map((locale) =>
    fill(SIGN_IN_MAIL_COPY.subject.text[locale], { product: PRODUCT_NAME }),
  ).join(' / ');
  const template = LOCALE_ORDER.map((locale) =>
    fill(SIGN_IN_MAIL_COPY.body.text[locale], { product: PRODUCT_NAME, minutes }),
  ).join(LOCALE_SEPARATOR);

  const violations: NeverSendViolation[] = [
    ...lintAlertText(subject, { voice: 'own' }),
    ...lintAlertText(template, { voice: 'own' }),
  ];
  if (violations.length > 0) throw new NeverSendError(violations);

  // `split`/`join`, not `replace`: a `$` in a replacement string is a pattern there.
  return { subject, text: template.split(LINK_SLOT).join(input.link) };
}

/** Fills every `{slot}` except `{link}`, which {@link renderSignInMail} places last. */
function fill(template: string, slots: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z]+)\}/gu, (marker, name: string) => {
    if (name === 'link') return marker;
    const value = slots[name];
    if (value === undefined) throw new Error(`sign-in mail copy needs slot {${name}}`);
    return value;
  });
}
