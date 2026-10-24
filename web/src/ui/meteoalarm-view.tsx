/** @jsxRuntime classic */
/** @jsx _h */
/** @jsxFrag _Fragment */
/**
 * The V2-B3 official-warnings section's markup: the forest-fire warnings (and
 * high-temperature warnings, as context) that the national weather services of Bulgaria
 * and its neighbours have in force, relayed through MeteoAlarm.
 *
 * This module, with the document parser it re-exports, is its own chunk, fetched the first
 * time the Layers panel opens (`meteoalarm-warnings.tsx`), so it is on neither the
 * first-render nor the map path (CI-12, `LAZY_ROLES`). It therefore takes what it needs
 * from the shell as props — the status, the stamp formatter, the rendered credit — rather
 * than importing shell modules: the bundler would split any shell module this chunk imports
 * out of its shell chunk into one of its own, and every such split cost the critical path a
 * few hundred bytes. For the same reason even Preact's `h` and `Fragment` are handed in
 * ({@link createMeteoalarmView}), with the classic JSX runtime compiling to them.
 *
 * Every row is someone else's warning, shown with its level, region, validity and a link to
 * the official page; Fire Watch issues none and never rewords one (`meteoalarm.note`). The
 * level chip is coloured from the violet `--warning-level-*` ramp — never the red–orange
 * band fire owns (CI-14) — and always carries the level's name, so the colour is never the
 * only cue. A country whose feed could not be read is named, so its silence is not read as
 * calm.
 */

// The classic runtime compiles the markup to `_h` and `_Fragment`, the factory's parameters;
// this type-only `_h` is what types it (through its `_h.JSX` namespace).
import type { Fragment as PreactFragment, h as _h } from 'preact';

import type { Messages } from '../core/i18n/messages.js';
import {
  officialLinkOf,
  parseMeteoalarmDocument,
  uncheckedCountries,
  type MeteoalarmDoc,
  type MeteoalarmWarning,
  type WarningCountry,
  type WarningKind,
  type WarningLevel,
} from '../core/meteoalarm.js';
import type { Locale } from '../core/types.js';
import type { MeteoalarmCreditText, MeteoalarmStatus } from './meteoalarm.js';

/**
 * Fetch and read the document. Every failure — the network, a stale feed (503), a body we
 * cannot read — is `null`, never a throw. Never with credentials: the request carries
 * nothing about the reader.
 */
export async function fetchMeteoalarmDocument(
  url: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<MeteoalarmDoc | null> {
  try {
    const response = await fetchImpl(url, { credentials: 'omit' });
    return response.ok ? parseMeteoalarmDocument(await response.json()) : null;
  } catch {
    return null;
  }
}

type PreactH = typeof _h;

const TITLE_ID = 'fw-meteoalarm-title';

type Copy = Messages['meteoalarm'];

/**
 * A country's name in the reader's language, from the platform's own locale data rather than
 * the catalogs: these are reference names, not Fire Watch's copy, and leaving them out of the
 * catalogs keeps them off the critical path (CI-12).
 */
export function countryLabel(locale: Locale, country: WarningCountry): string {
  return new Intl.DisplayNames([locale], { type: 'region' }).of(country) ?? country;
}

function kindLabel(t: Copy, kind: WarningKind): string {
  return kind === 'forest-fire' ? t.forestFire : t.highTemperature;
}

function levelLabel(t: Copy, level: WarningLevel): string {
  return level === 4 ? t.level4 : level === 3 ? t.level3 : t.level2;
}

export interface MeteoalarmViewProps {
  readonly status: MeteoalarmStatus;
  readonly messages: Messages;
  readonly locale: Locale;
  /** Renders an ISO instant for the reader, relative to the ticking server-corrected now. */
  readonly stamp: (iso: string) => string;
  readonly credit: MeteoalarmCreditText | null;
}

/**
 * The section's components, built over the shell's own Preact. Called once, when the chunk
 * arrives.
 */
export function createMeteoalarmView(_h: PreactH, _Fragment: typeof PreactFragment) {
  function MeteoalarmView({ status, messages, locale, stamp, credit }: MeteoalarmViewProps) {
    const t = messages.meteoalarm;

    let body;
    if (status.kind === 'ready') {
      body = <WarningsList doc={status.doc} t={t} locale={locale} stamp={stamp} />;
    } else if (status.kind === 'unavailable') {
      body = <p class="meteoalarm-status">{messages.layers.unavailable}</p>;
    } else {
      body = <p class="meteoalarm-status">{messages.layers.loading}</p>;
    }

    return (
      <section class="meteoalarm" aria-labelledby={TITLE_ID}>
        <h3 id={TITLE_ID} class="meteoalarm-title">
          {t.title}
        </h3>
        <p class="meteoalarm-note">{t.note}</p>
        <div aria-live="polite">{body}</div>
        {credit !== null ? (
          <p class="meteoalarm-credit">
            {credit.href === undefined ? (
              credit.text
            ) : (
              <a href={credit.href} rel="noopener noreferrer">
                {credit.text}
              </a>
            )}
          </p>
        ) : null}
      </section>
    );
  }

  function WarningsList({
    doc,
    t,
    locale,
    stamp,
  }: {
    readonly doc: MeteoalarmDoc;
    readonly t: Copy;
    readonly locale: Locale;
    readonly stamp: (iso: string) => string;
  }) {
    const unchecked = uncheckedCountries(doc);
    return (
      <>
        <p class="meteoalarm-checked">{t.checkedAt(stamp(doc.generated_at))}</p>
        {unchecked.length > 0 ? (
          <p class="meteoalarm-caveat">
            {t.notChecked(unchecked.map((country) => countryLabel(locale, country)).join(', '))}
          </p>
        ) : null}
        {doc.warnings.length === 0 ? (
          <p class="meteoalarm-status">{t.noneInForce}</p>
        ) : (
          <ul class="meteoalarm-list">
            {doc.warnings.map((warning) => (
              <WarningRow key={warning.id} warning={warning} t={t} locale={locale} stamp={stamp} />
            ))}
          </ul>
        )}
      </>
    );
  }

  function WarningRow({
    warning,
    t,
    locale,
    stamp,
  }: {
    readonly warning: MeteoalarmWarning;
    readonly t: Copy;
    readonly locale: Locale;
    readonly stamp: (iso: string) => string;
  }) {
    const link = officialLinkOf(warning);
    return (
      <li class="meteoalarm-warning" data-kind={warning.kind} data-level={String(warning.level)}>
        <p class="meteoalarm-head">
          <span class="meteoalarm-level" data-level={String(warning.level)}>
            {levelLabel(t, warning.level)}
          </span>{' '}
          <span class="meteoalarm-kind">{kindLabel(t, warning.kind)}</span>
        </p>
        <p class="meteoalarm-region">{`${warning.region} · ${countryLabel(locale, warning.country)}`}</p>
        <p class="meteoalarm-validity">
          {warning.onset === null
            ? t.validUntil(stamp(warning.expires))
            : t.validFromTo(stamp(warning.onset), stamp(warning.expires))}
        </p>
        {link !== null ? (
          <a class="meteoalarm-link" href={link} rel="noopener noreferrer" target="_blank">
            {t.officialLink}
          </a>
        ) : null}
      </li>
    );
  }

  return MeteoalarmView;
}
