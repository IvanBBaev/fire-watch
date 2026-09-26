/**
 * Status model → one self-contained HTML page per language (TASKS J5; OPERATIONS §10).
 *
 * The page has to work in exactly the situation where everything else of ours does not,
 * so it depends on nothing: no framework, no web font, no CDN, no external stylesheet, no
 * image. It is a single string with inline CSS and a ten-line inline script whose only job
 * is to notice that *the page itself* has not been refreshed — the status page's own
 * "stale" banner, for when the off-infra probe has stopped (GitHub cron is best-effort).
 * With scripting off, the checked-at time is still printed in plain text.
 *
 * Every interpolated value goes through {@link escapeHtml}. Most of it is our own copy, but
 * `muteReason` is operator-written text relayed verbatim and notice text is founder-
 * written; neither is trusted to be markup-free.
 *
 * Times are shown in UTC with the zone printed next to them. A reader in Sofia has to add
 * two or three hours, which is worse than local time — but a static page cannot know the
 * reader's zone without a script, and a time that silently changes meaning when scripting
 * is off is worse still. (Founder question in the README.)
 */

import type { Notice } from './notices.js';
import type { ComponentLevel, StatusModel } from './status-model.js';
import { CATALOG, format, sourceLabel, type Locale, type Messages } from './strings.js';

export interface RenderOptions {
  readonly model: StatusModel;
  /** Already filtered and ordered — see `visibleNotices`. */
  readonly notices: readonly Notice[];
  readonly locale: Locale;
  /** Relative link to the same page in the other language. */
  readonly otherLocaleHref: string;
  /** After this many minutes without a new probe run, the page warns about itself. */
  readonly staleAfterMinutes: number;
  /** §10.2's second announcement channel, shown as text (and linked when it is https). */
  readonly announceChannel: string | null;
  /** Seconds between automatic reloads. */
  readonly refreshSeconds: number;
}

export const DEFAULT_STALE_AFTER_MINUTES = 45;
export const DEFAULT_REFRESH_SECONDS = 300;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** `2026-09-25 14:05 UTC`, or the input unchanged when it is not a readable instant. */
export function formatUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} UTC`;
}

export function formatAge(seconds: number, messages: Messages): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return format(messages.seconds, { n: String(s) });
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return format(messages.minutes, { n: String(minutes) });
  return format(messages.hours, { n: String(Math.floor(minutes / 60)), m: String(minutes % 60) });
}

const LEVEL_MARK: Readonly<Record<ComponentLevel, string>> = {
  operational: '●',
  unknown: '?',
  degraded: '▲',
  outage: '■',
};

function badge(level: ComponentLevel, messages: Messages): string {
  // Shape + word + colour: never colour alone (the CI-14 colour-vision rule, applied here too).
  return (
    `<span class="badge ${level}"><span aria-hidden="true">${LEVEL_MARK[level]}</span> ` +
    `${escapeHtml(messages.level[level])}</span>`
  );
}

function renderComponents(model: StatusModel, m: Messages): string {
  const items = model.components.map((c) => {
    const lines: string[] = [escapeHtml(m.reason[c.reason])];
    if (c.unconfirmed) lines.push(escapeHtml(m.unconfirmed));
    if (c.id === 'map' || c.id === 'map-backup') {
      if (c.dataGeneratedAt !== null && c.ageSeconds !== null) {
        lines.push(
          escapeHtml(
            format(m.dataAge, {
              time: formatUtc(c.dataGeneratedAt),
              age: formatAge(c.ageSeconds, m),
            }),
          ),
        );
      } else if (c.reason !== 'not_configured') {
        lines.push(escapeHtml(m.dataAgeUnknown));
      }
    }
    if (c.level !== 'operational' && c.reason !== 'not_configured') {
      lines.push(escapeHtml(format(m.since, { time: formatUtc(c.since) })));
    }
    return (
      `<li class="component" data-component="${escapeHtml(c.id)}">` +
      `<div class="row"><span class="name">${escapeHtml(m.component[c.id])}</span>` +
      `${badge(c.level, m)}</div>` +
      `<p class="detail">${lines.join('<br>')}</p></li>`
    );
  });
  return `<ul class="list">${items.join('')}</ul>`;
}

function renderSources(model: StatusModel, m: Messages): string {
  if (model.sources.length === 0) return `<p class="muted">${escapeHtml(m.sourcesUnavailable)}</p>`;
  const rows = model.sources.map((s) => {
    const details: string[] = [];
    if (s.ageSeconds !== null && s.level !== 'no_data') {
      details.push(escapeHtml(format(m.sourceLastSuccess, { age: formatAge(s.ageSeconds, m) })));
    }
    if (s.level === 'muted') {
      if (s.muteReason !== null && s.muteReason.trim().length > 0) {
        details.push(escapeHtml(s.muteReason));
      }
      if (s.mutedUntil !== null) {
        details.push(escapeHtml(format(m.mutedUntil, { time: formatUtc(s.mutedUntil) })));
      }
    }
    return (
      `<tr data-source="${escapeHtml(s.row)}"><th scope="row">${escapeHtml(sourceLabel(m, s.row))}</th>` +
      `<td class="src ${s.level}">${escapeHtml(m.sourceLevel[s.level])}</td>` +
      `<td class="muted">${details.join(' · ')}</td></tr>`
    );
  });
  return `<table class="sources"><tbody>${rows.join('')}</tbody></table>`;
}

function renderNotices(notices: readonly Notice[], locale: Locale, m: Messages): string {
  if (notices.length === 0) return `<p class="muted">${escapeHtml(m.noNotices)}</p>`;
  const items = notices.map((n) => {
    const kind = n.kind === 'incident' ? m.noticeIncident : m.noticeMaintenance;
    const when =
      formatUtc(n.startedAt) +
      (n.resolvedAt === null
        ? ''
        : ` · ${format(m.noticeResolved, { time: formatUtc(n.resolvedAt) })}`);
    const postmortem =
      n.postmortemUrl === null
        ? ''
        : ` <a href="${escapeHtml(n.postmortemUrl)}" rel="noopener">${escapeHtml(n.postmortemUrl)}</a>`;
    return (
      `<li class="notice ${n.resolvedAt === null ? 'ongoing' : 'resolved'}" data-notice="${escapeHtml(n.id)}">` +
      `<div class="row"><strong>${escapeHtml(kind)}</strong><span class="muted">${escapeHtml(when)}</span></div>` +
      `<p class="detail">${escapeHtml(locale === 'bg' ? n.bg : n.en)}${postmortem}</p></li>`
    );
  });
  return `<ul class="list">${items.join('')}</ul>`;
}

function renderChannel(channel: string | null, m: Messages): string {
  if (channel === null || channel.trim().length === 0) return '';
  let shown = escapeHtml(channel);
  try {
    if (new URL(channel).protocol === 'https:') {
      shown = `<a href="${escapeHtml(channel)}" rel="noopener">${escapeHtml(channel)}</a>`;
    }
  } catch {
    // Not a URL (e.g. "@handle"): shown as text.
  }
  // Split around the placeholder so the link survives escaping of the sentence.
  const [before = '', after = ''] = m.secondChannel.split('{channel}');
  return `<p>${escapeHtml(before)}${shown}${escapeHtml(after)}</p>`;
}

const STYLE = `
:root{--bg:#fff;--fg:#1b1b1f;--muted:#5d5d66;--line:#dcdce2;--ok:#1e6b3a;--warn:#8a5a00;--down:#4b2a82;--unk:#55555e;--banner:#fff3cd}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#ececf1;--muted:#a3a3ad;--line:#33333a;--ok:#6fd08f;--warn:#f0bf5a;--down:#c3a6ff;--unk:#b0b0ba;--banner:#3a3016}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:2rem 0 .5rem}
a{color:inherit}
.lang{float:right;font-size:.9rem}
.overall{border:1px solid var(--line);border-radius:.5rem;padding:1rem;margin:1rem 0;font-weight:600}
.list{list-style:none;margin:0;padding:0}
.list li{border-bottom:1px solid var(--line);padding:.75rem 0}
.row{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.detail{margin:.25rem 0 0;color:var(--muted);font-size:.95rem;overflow-wrap:anywhere}
.muted{color:var(--muted)}
.badge{font-weight:600;white-space:nowrap}
.operational,.on_time{color:var(--ok)}.degraded,.delayed{color:var(--warn)}
.outage,.severely_delayed{color:var(--down)}.unknown,.no_data{color:var(--unk)}
.sources{width:100%;border-collapse:collapse;font-size:.95rem}
.sources th,.sources td{text-align:left;padding:.4rem .5rem .4rem 0;border-bottom:1px solid var(--line);vertical-align:top}
.sources th{font-weight:500}
.src{white-space:nowrap;font-weight:600}
#page-stale{display:none;background:var(--banner);border-radius:.5rem;padding:.75rem 1rem;margin:1rem 0}
footer{margin-top:2.5rem;font-size:.9rem;color:var(--muted)}
@media (max-width:30rem){.sources td.muted{display:block;padding-top:0}}
`
  .trim()
  .replace(/\n/g, '');

/**
 * The page's own staleness check. Reads the generation time from the document, compares
 * it with the reader's clock, and reveals a banner — nothing else. No network, no storage.
 */
const STALE_SCRIPT =
  "(function(){var r=document.documentElement,g=Date.parse(r.getAttribute('data-generated-at')||'')," +
  "l=Number(r.getAttribute('data-stale-after-minutes'))*60000,b=document.getElementById('page-stale');" +
  'function c(){if(b&&isFinite(g)&&Date.now()-g>l){b.style.display="block";}}c();setInterval(c,60000);})();';

export function renderPage(options: RenderOptions): string {
  const { model, notices, locale, otherLocaleHref, staleAfterMinutes, announceChannel } = options;
  const m = CATALOG[locale];
  const other = locale === 'bg' ? CATALOG.en : CATALOG.bg;
  const checked = escapeHtml(format(m.checkedAt, { time: formatUtc(model.generatedAt) }));
  const stale = escapeHtml(format(m.pageStale, { minutes: String(staleAfterMinutes) }));
  return [
    '<!doctype html>',
    `<html lang="${locale}" data-generated-at="${escapeHtml(model.generatedAt)}" data-stale-after-minutes="${String(staleAfterMinutes)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta http-equiv="refresh" content="${String(options.refreshSeconds)}">`,
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(m.pageTitle)}</title>`,
    `<link rel="alternate" hreflang="${locale === 'bg' ? 'en' : 'bg'}" href="${escapeHtml(otherLocaleHref)}">`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<a class="lang" href="${escapeHtml(otherLocaleHref)}" lang="${locale === 'bg' ? 'en' : 'bg'}">${escapeHtml(other.languageName)}</a>`,
    `<h1>${escapeHtml(m.heading)}</h1>`,
    `<p class="muted">${checked} ${escapeHtml(m.timeZoneNote)}</p>`,
    `<div id="page-stale" role="alert">${stale}</div>`,
    `<div class="overall ${model.overall}" role="status">${badge(model.overall, m)}<br>${escapeHtml(m.overall[model.overall])}</div>`,
    `<h2>${escapeHtml(m.noticesHeading)}</h2>`,
    renderNotices(notices, locale, m),
    `<h2>${escapeHtml(m.componentsHeading)}</h2>`,
    renderComponents(model, m),
    `<h2>${escapeHtml(m.sourcesHeading)}</h2>`,
    renderSources(model, m),
    '<footer>',
    `<p>${escapeHtml(m.scope)}</p>`,
    renderChannel(announceChannel, m),
    `<p>${escapeHtml(m.refreshHint)}</p>`,
    '</footer>',
    '</main>',
    `<script>${STALE_SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
