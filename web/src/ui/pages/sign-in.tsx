/**
 * Sign-in by email link (TASKS I1; review 05 §5.4.1 C1–C2): the request form at
 * `/sign-in`, and the landing page at `/sign-in/continue` that finishes signing in.
 *
 * Lazy: both pages are one chunk (CI-12 lazy role `page`), loaded only when a reader opens
 * one of these routes.
 *
 * Both pages ask the server first whether it serves sign-in at all. Where it does not
 * (auth off: the routes answer 404) they say so in one neutral line and offer nothing
 * else — no error banner, no form, and a held token is dropped unsent.
 *
 * The landing page never exchanges the token on load. The reader presses Continue: mail
 * scanners prefetch links, and one that ran this page would otherwise burn the link (C2).
 * The token itself was taken out of the URL by `boot()` before this chunk was requested;
 * the page reads it once from `ui/auth.ts` and hands it to the continue call and nowhere
 * else.
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type {
  ContinueOutcome,
  LinkRefusal,
  RequestLinkOutcome,
  TakenToken,
} from '../../core/auth/sign-in.js';
import { SIGN_IN_PATH } from '../../core/auth/sign-in.js';
import type { Messages } from '../../core/i18n/messages.js';
import { authClient, consumeSignInToken, noteSession, refreshSession } from '../auth.js';
import { useApp } from '../context.js';

/** Maximum address length the server accepts (`MAX_EMAIL_INPUT`). */
const MAX_EMAIL_LENGTH = 320;

/**
 * While an auth page is mounted, links out of it send at most the origin. The token is
 * already gone from the URL, and fetches set their own policy; this covers a reader who
 * follows a link from here. `strict-origin`, not `no-referrer` — see `core/auth/sign-in.ts`.
 */
function useReferrerPolicy(): void {
  useEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
    const meta = existing ?? document.createElement('meta');
    const previous = existing?.content ?? null;
    meta.name = 'referrer';
    meta.content = 'strict-origin';
    if (existing === null) document.head.appendChild(meta);
    return () => {
      if (previous === null) meta.remove();
      else meta.content = previous;
    };
  }, []);
}

/**
 * `probing` until `GET /api/v1/account` answers; then whether sign-in is served here and,
 * if so, whether this browser is already signed in. No answer at all reads as unavailable.
 */
type Probe = 'probing' | 'unavailable' | 'signed-in' | 'signed-out';

function useProbe(): Probe {
  const [probe, setProbe] = useState<Probe>('probing');
  useEffect(() => {
    let live = true;
    void refreshSession().then((state) => {
      if (!live) return;
      setProbe(state === 'signed-in' || state === 'signed-out' ? state : 'unavailable');
    });
    return () => {
      live = false;
    };
  }, []);
  return probe;
}

function Unavailable({ messages }: { readonly messages: Messages }) {
  return <p class="auth-status">{messages.signIn.unavailable}</p>;
}

/** The signed-in indicator and sign-out, shared by both pages. */
function SignedIn({
  messages,
  created,
}: {
  readonly messages: Messages;
  readonly created: boolean;
}) {
  const [state, setState] = useState<'in' | 'out' | 'failed'>('in');
  const onSignOut = (): void => {
    const client = authClient();
    if (client === null) return;
    void client.signOut().then((outcome) => {
      if (outcome.kind === 'signed-out') noteSession('signed-out');
      setState(outcome.kind === 'signed-out' ? 'out' : 'failed');
    });
  };
  if (state === 'out') {
    return (
      <p class="auth-status" role="status">
        {messages.signIn.signedOut}
      </p>
    );
  }
  return (
    <>
      <h2>{messages.signIn.signedInTitle}</h2>
      <p class="auth-status" role="status">
        {state === 'failed'
          ? messages.signIn.failed
          : created
            ? messages.signIn.accountCreated
            : messages.signIn.signedIn}
      </p>
      <button type="button" class="button-secondary" onClick={onSignOut}>
        {messages.signIn.signOut}
      </button>
    </>
  );
}

function requestLine(messages: Messages, outcome: RequestLinkOutcome): string {
  switch (outcome.kind) {
    case 'sent':
      return messages.signIn.sent;
    case 'rate-limited':
      return messages.signIn.rateLimited;
    case 'invalid-email':
      return messages.signIn.invalidEmail;
    case 'unavailable':
      return messages.signIn.unavailable;
    case 'failed':
      return messages.signIn.failed;
  }
}

type RequestState = { readonly kind: 'idle' } | { readonly kind: 'sending' } | RequestLinkOutcome;

export function SignInPage() {
  const { messages } = useApp();
  useReferrerPolicy();
  const probe = useProbe();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<RequestState>({ kind: 'idle' });

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    const client = authClient();
    if (client === null || state.kind === 'sending') return;
    setState({ kind: 'sending' });
    void client.requestLink(email.trim()).then(setState);
  };

  const ready = probe !== 'probing' && state.kind !== 'sending';
  return (
    <article class="page auth-page" {...(ready ? { 'data-ready': '' } : {})}>
      <h1>{messages.signIn.title}</h1>
      {probe === 'unavailable' || state.kind === 'unavailable' ? (
        <Unavailable messages={messages} />
      ) : probe === 'signed-in' ? (
        <SignedIn messages={messages} created={false} />
      ) : probe === 'signed-out' && state.kind === 'sent' ? (
        <p class="auth-status" role="status">
          {messages.signIn.sent}
        </p>
      ) : probe === 'signed-out' ? (
        <form class="auth-form" onSubmit={onSubmit}>
          <p>{messages.signIn.accountNote}</p>
          <label for="auth-email">{messages.signIn.emailLabel}</label>
          <input
            id="auth-email"
            type="email"
            name="email"
            autocomplete="email"
            inputMode="email"
            required
            maxLength={MAX_EMAIL_LENGTH}
            value={email}
            onInput={(event) => {
              setEmail(event.currentTarget.value);
            }}
          />
          <button type="submit" class="button-primary" disabled={state.kind === 'sending'}>
            {state.kind === 'sending' ? messages.signIn.sending : messages.signIn.send}
          </button>
          <p class="auth-status" role="status">
            {state.kind === 'idle' || state.kind === 'sending' ? '' : requestLine(messages, state)}
          </p>
        </form>
      ) : null}
    </article>
  );
}

function refusalLine(messages: Messages, reason: LinkRefusal): string {
  switch (reason) {
    case 'expired':
      return messages.signIn.expired;
    case 'used':
      return messages.signIn.used;
    case 'invalid':
      return messages.signIn.invalid;
    case 'superseded':
      return messages.signIn.superseded;
    case 'other-browser':
      return messages.signIn.otherBrowser;
  }
}

type ContinueState = { readonly kind: 'ready' } | { readonly kind: 'working' } | ContinueOutcome;

export function SignInContinuePage() {
  const { messages } = useApp();
  useReferrerPolicy();
  const probe = useProbe();
  // Read once, on first render: a later mount (a back navigation) finds nothing, so the
  // token lives in this component's state and nowhere a later render could reach.
  const [taken] = useState<TakenToken>(consumeSignInToken);
  const [state, setState] = useState<ContinueState>({ kind: 'ready' });

  const onContinue = (): void => {
    const client = authClient();
    if (client === null || taken.kind !== 'token' || state.kind !== 'ready') return;
    setState({ kind: 'working' });
    void client.continueSignIn(taken.token).then((outcome) => {
      if (outcome.kind === 'signed-in') noteSession('signed-in');
      setState(outcome);
    });
  };

  const requestNew = (
    <a class="back-link" href={SIGN_IN_PATH}>
      {messages.signIn.requestNew}
    </a>
  );

  let body: ComponentChildren = null;
  if (probe === 'unavailable' || state.kind === 'unavailable') {
    body = <Unavailable messages={messages} />;
  } else if (probe !== 'probing') {
    switch (state.kind) {
      case 'ready':
        // A held link wins over an existing session: it may be for another account.
        body =
          taken.kind === 'token' ? (
            <>
              <p>{messages.signIn.continueIntro}</p>
              <button type="button" class="button-primary" onClick={onContinue}>
                {messages.signIn.continue}
              </button>
            </>
          ) : probe === 'signed-in' ? (
            <SignedIn messages={messages} created={false} />
          ) : (
            <>
              <p class="auth-status">{messages.signIn.noLink}</p>
              {requestNew}
            </>
          );
        break;
      case 'working':
        body = (
          <p class="auth-status" role="status">
            {messages.signIn.working}
          </p>
        );
        break;
      case 'refused':
        body = (
          <>
            <p class="auth-status" role="status">
              {refusalLine(messages, state.reason)}
            </p>
            {requestNew}
          </>
        );
        break;
      case 'failed':
        body = (
          <p class="auth-status" role="status">
            {messages.signIn.failed}
          </p>
        );
        break;
      case 'signed-in':
        body = <SignedIn messages={messages} created={state.accountCreated} />;
        break;
    }
  }

  const ready = probe !== 'probing' && state.kind !== 'working';
  return (
    <article class="page auth-page" {...(ready ? { 'data-ready': '' } : {})}>
      <h1>{messages.signIn.continueTitle}</h1>
      {body}
    </article>
  );
}
