/**
 * Settings: language and theme. Language switches load the other message catalog
 * (code-split, review 08 §5.2.7); theme writes 'fw:theme' and toggles `data-theme` on
 * <html>, with 'auto' following prefers-color-scheme live. Also hosts the alert-settings
 * disclaimer layer (TASKS I5) ahead of the alert settings themselves.
 */

import { useEffect, useState } from 'preact/hooks';

import { SIGN_IN_PATH } from '../../core/auth/sign-in.js';
import type { Locale } from '../../core/types.js';
import type { ThemePreference } from '../logic/theme.js';
import { setThemePreference, themePreference } from '../theme.js';
import { authClient, authSession, noteSession, refreshSession } from '../auth.js';
import { useApp } from '../context.js';

/**
 * The account section (TASKS I1): the signed-in indicator and sign-out, or the way to
 * sign in. Hidden until `GET /api/v1/account` answers 200 or 401: with auth off (404), or
 * with no answer at all, Settings looks exactly as it did before sign-in existed.
 */
function AccountSection() {
  const { messages } = useApp();
  const [signOutFailed, setSignOutFailed] = useState(false);
  useEffect(() => {
    void refreshSession();
  }, []);
  const session = authSession.value;
  if (session !== 'signed-in' && session !== 'signed-out') return null;

  const onSignOut = (): void => {
    const client = authClient();
    if (client === null) return;
    void client.signOut().then((outcome) => {
      setSignOutFailed(outcome.kind !== 'signed-out');
      if (outcome.kind === 'signed-out') noteSession('signed-out');
    });
  };

  return (
    <section class="settings-group settings-account" aria-labelledby="settings-account">
      <h2 id="settings-account">{messages.signIn.accountTitle}</h2>
      {session === 'signed-in' ? (
        <>
          <p class="auth-status" role="status">
            {signOutFailed ? messages.signIn.failed : messages.signIn.signedIn}
          </p>
          <button type="button" class="button-secondary" onClick={onSignOut}>
            {messages.signIn.signOut}
          </button>
        </>
      ) : (
        <>
          <p>{messages.signIn.accountNote}</p>
          <a class="back-link" href={SIGN_IN_PATH}>
            {messages.signIn.title}
          </a>
        </>
      )}
    </section>
  );
}

/**
 * Language options are labeled with their autonyms — a language's own name is a proper
 * noun, never translated, which is why these two words are data rather than catalog
 * copy. (A Messages field for them is requested as a contract change.)
 */
const LOCALE_OPTIONS: readonly { readonly locale: Locale; readonly autonym: string }[] = [
  { locale: 'bg', autonym: 'Български' },
  { locale: 'en', autonym: 'English' },
];

export function SettingsPage() {
  const { messages, locale, setLocale } = useApp();
  const currentTheme = themePreference.value;

  const themeOptions: readonly { readonly value: ThemePreference; readonly label: string }[] = [
    { value: 'light', label: messages.settings.themeLight },
    { value: 'dark', label: messages.settings.themeDark },
    { value: 'auto', label: messages.settings.themeAuto },
  ];

  return (
    <div class="page settings-page">
      <h1>{messages.nav.settings}</h1>
      <fieldset class="settings-group">
        <legend>{messages.settings.language}</legend>
        {LOCALE_OPTIONS.map((option) => (
          <label class="settings-option" key={option.locale}>
            <input
              type="radio"
              name="language"
              checked={locale === option.locale}
              onChange={() => {
                setLocale(option.locale);
              }}
            />
            <span>{option.autonym}</span>
          </label>
        ))}
      </fieldset>
      <fieldset class="settings-group">
        <legend>{messages.settings.theme}</legend>
        {themeOptions.map((option) => (
          <label class="settings-option" key={option.value}>
            <input
              type="radio"
              name="theme"
              checked={currentTheme === option.value}
              onChange={() => {
                setThemePreference(option.value);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      {/* The alert-settings disclaimer layer (07 §5.5.4, 09 §3.4 — TASKS I5). There are no
          alert settings yet, so it stands alone and says so; when the I-track adds them,
          it belongs directly above their controls. */}
      <section class="settings-group settings-alerts" aria-labelledby="settings-alerts">
        <h2 id="settings-alerts">{messages.disclaimer.alertsTitle}</h2>
        <p>{messages.disclaimer.alertsNote}</p>
        <a class="disclaimer-link" href="/privacy#disclaimer">
          {messages.disclaimer.linkLabel}
        </a>
      </section>
      <AccountSection />
    </div>
  );
}
