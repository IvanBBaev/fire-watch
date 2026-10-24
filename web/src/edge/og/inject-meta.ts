/**
 * Edge meta injection (TASKS V2-D4; 08-frontend §5.1.6): the static shell carries a block
 * of link-preview defaults between `<!-- og:begin -->` and `<!-- og:end -->`, and an event
 * permalink replaces that block with the event's own tags. Scrapers that run no
 * JavaScript read only what is in the HTML they were served, so this is the only place
 * their preview can come from.
 *
 * Pure string work. Every value is attribute-escaped: a place name is data, and a quote
 * in one must not be able to open a new attribute or a new element in the shell.
 */

import type { MetaTag } from '../../ui/share/share-meta.js';
import type { Locale } from '../../core/types.js';

export const OG_BEGIN = '<!-- og:begin -->';
export const OG_END = '<!-- og:end -->';

/** HTML attribute escaping — the five characters that can end or open markup. */
export function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function renderMetaTags(tags: readonly MetaTag[]): string {
  return tags
    .map(
      (tag) =>
        `<meta ${tag.attribute}="${escapeAttribute(tag.key)}" content="${escapeAttribute(tag.content)}" />`,
    )
    .join('\n    ');
}

/**
 * The shell with its og block replaced by `tags` and its `lang` set to the locale the tags
 * were written in. A shell without both markers is returned unchanged: serving the plain
 * app is always better than serving a page whose head was cut in the wrong place.
 */
export function injectOgMeta(shell: string, tags: readonly MetaTag[], locale: Locale): string {
  const begin = shell.indexOf(OG_BEGIN);
  const end = shell.indexOf(OG_END, begin + OG_BEGIN.length);
  if (begin === -1 || end === -1) return shell;
  const head = shell.slice(0, begin + OG_BEGIN.length);
  const tail = shell.slice(end);
  const injected = `${head}\n    ${renderMetaTags(tags)}\n    ${tail}`;
  return injected.replace(/<html lang="[^"]*"/u, `<html lang="${locale}"`);
}
