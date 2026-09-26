/**
 * The share card (TASKS F6; IMPLEMENTATION-PLAN WP4, "OG / share cards per event with the
 * observation timestamp baked into the image"; 07-product-ux P14/U13, §5.4.2).
 *
 * A card is the event page's key facts as one 1200×630 image — the Open Graph shape — that
 * a reader can post anywhere. Once it leaves the app nothing on it can update, so it obeys
 * one rule the live page does not have to: **every stamp is absolute.** The last satellite
 * observation is written out as a full Europe/Sofia date and time (07 §5.2.2: relative-only
 * labels fail in screenshots), the lifecycle line uses the same absolute stamp, and the
 * card says when it was made, which is the anchor any age a reader works out has to start
 * from. No relative age is baked in: "12 min ago" is false by the time anyone reads it.
 *
 * Two pure steps, so the tests can read exactly what the image will say:
 * - {@link buildShareCard} decides the copy — every word from the catalog, every time
 *   through `core/i18n/format.ts`, "now" from the caller's `serverNow()`;
 * - {@link renderShareCardSvg} lays it out as an SVG string, deterministically: the same
 *   card renders to the same bytes on every machine.
 *
 * Rasterizing is the only step that needs a browser, and it lives in `share-image.ts`.
 *
 * What the card deliberately does not show:
 * - **No map, no pin.** GLOSSARY §5.2 allows an OG card the event's footprint, never a
 *   pinned coordinate; the text-only card shows neither, so it owes no tile attribution
 *   either (the credits registry has no share-card surface). A footprint thumbnail is the
 *   v2 server-rendered og:image, not this.
 * - **No fire colour.** The palette is the app's dark chrome, all neutral: red is owned by
 *   fire on the map (CI-14), and a card is not a map.
 * - **No webfont.** Text is set in the system sans-serif stack the app itself uses (CI-12
 *   forbids webfonts), and wrapping budgets width conservatively for that reason.
 */

import { formatDateTimeSofia } from '../../core/i18n/format.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { FireEvent, Locale } from '../../core/types.js';
import { lifecycleLine } from '../logic/lifecycle-line.js';
import { placeName } from '../logic/place.js';

/** The Open Graph image shape (1.91:1). */
export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

const PADDING = 64;
const CONTENT_WIDTH = SHARE_CARD_WIDTH - 2 * PADDING;
const LINE_HEIGHT = 1.25;

/**
 * Average advance of a glyph, in ems, used to wrap text without measuring it. Wide on
 * purpose: the card is rasterized with whatever sans-serif the device has, and Cyrillic
 * and capitals run wider than Latin lowercase. A line that wraps early costs a little
 * space; a line that runs off the edge loses words.
 */
const GLYPH_EM = 0.58;

/**
 * How far the body text may shrink to fit the card before the card grows instead. Copy is
 * never truncated — a frozen line cut short (§3's "this does not mean the fire is out")
 * would say something the glossary does not — so a card that cannot fit at the smallest
 * scale is made taller, and the image is merely not the OG ratio.
 */
const MIN_SCALE = 0.7;
const SCALE_STEP = 0.05;

/** The app's dark chrome (styles.css), neutral throughout — see the module comment. */
const PALETTE = {
  background: '#16191c',
  border: '#3a4046',
  text: '#e8e6e3',
  muted: '#a3a9af',
  bannerBackground: '#3a3000',
  bannerBorder: '#d9a900',
  bannerText: '#f4dfa0',
} as const;

/** The system sans-serif stack — no webfont is ever fetched for the card. */
const FONT_FAMILY =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Helvetica Neue', Arial, sans-serif";

export type ShareCardRole =
  | 'title'
  | 'observed'
  | 'lifecycle'
  | 'note'
  | 'stale'
  | 'facts'
  | 'safety'
  | 'disclaimer'
  | 'madeAt'
  | 'permalink';

export interface ShareCardBlock {
  readonly role: ShareCardRole;
  readonly text: string;
}

/** Everything the card says, in reading order — the model the SVG is drawn from. */
export interface ShareCard {
  readonly locale: Locale;
  /** Product name, top left. */
  readonly brand: string;
  /** "SATELLITE-DETECTED · Likely", top right. */
  readonly tier: string;
  /** Reading order; ends with when the image was made and where the live page is. */
  readonly blocks: readonly ShareCardBlock[];
  /** The observation stamp as baked in — the one fact the card exists to carry. */
  readonly observedStamp: string;
}

export interface ShareCardInput {
  readonly event: FireEvent;
  readonly messages: Messages;
  readonly locale: Locale;
  /** Server-corrected epoch ms, from `serverNow()` — the card's "made at". */
  readonly nowMs: number;
  /**
   * The instant data stopped, when the §3b stale banner is up (`pickBanner`), else `null`.
   * A card made while data is delayed must carry the delay: it is the one fact that turns
   * "no new detections" from reassurance into what it is.
   */
  readonly staleSinceIso: string | null;
  /** Absolute URL of the event's canonical permalink. */
  readonly permalinkUrl: string;
}

/** A separator between composed values. Punctuation, not copy (as on the event page). */
const DOT = ' · ';

const NO_BREAK_SPACE = '\u00a0';

/**
 * A stamp is one fact and must not be split across lines — "09.08.2026 г.," at the end of
 * one line and "14:14" at the start of the next reads as two things. Its spaces become
 * no-break spaces, which {@link wrapText} does not break at and which render as spaces.
 */
function unbroken(stamp: string): string {
  return stamp.replaceAll(' ', NO_BREAK_SPACE);
}

/** The permalink as printed: no scheme, which a reader types and a scanner infers. */
function printableUrl(url: string): string {
  return url.replace(/^https?:\/\//u, '');
}

export function buildShareCard(input: ShareCardInput): ShareCard {
  const { event, messages, locale, nowMs, staleSinceIso, permalinkUrl } = input;
  const observedStamp = formatDateTimeSofia(event.lastObservedAt, locale);

  const blocks: ShareCardBlock[] = [
    { role: 'title', text: messages.eventNearPlace(placeName(event, locale)) },
    { role: 'observed', text: messages.shareCard.observedAt(unbroken(observedStamp)) },
    { role: 'lifecycle', text: lifecycleLine(event, messages, locale, nowMs, 'card') },
  ];
  if (event.scoreBucket === 'unverified') {
    blocks.push({ role: 'note', text: messages.unverifiedNote });
  }
  if (staleSinceIso !== null) {
    blocks.push({
      role: 'stale',
      text: messages.status.staleSources(unbroken(formatDateTimeSofia(staleSinceIso, locale))),
    });
  }
  const facts = [
    ...(event.areaHa === null ? [] : [messages.areaBothUnits(event.areaHa)]),
    messages.detectionCount(event.detectionCount),
  ];
  blocks.push(
    { role: 'facts', text: facts.join(DOT) },
    { role: 'safety', text: `${messages.safetyNoTravel} ${messages.emergencyLine}` },
    { role: 'disclaimer', text: messages.panelFooterDisclaimer },
    {
      role: 'madeAt',
      text: messages.shareCard.madeAt(
        unbroken(formatDateTimeSofia(new Date(nowMs).toISOString(), locale)),
      ),
    },
    { role: 'permalink', text: printableUrl(permalinkUrl) },
  );

  return {
    locale,
    brand: messages.appTitle,
    tier: `${messages.satelliteDetected}${DOT}${messages.tierLabel[event.scoreBucket]}`,
    blocks,
    observedStamp,
  };
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

interface BlockStyle {
  readonly size: number;
  readonly weight: 400 | 700;
  readonly fill: string;
  /** Space above the block, in px at scale 1. */
  readonly gap: number;
}

const STYLE: Readonly<Record<ShareCardRole, BlockStyle>> = {
  title: { size: 60, weight: 700, fill: PALETTE.text, gap: 0 },
  observed: { size: 34, weight: 700, fill: PALETTE.text, gap: 20 },
  lifecycle: { size: 25, weight: 400, fill: PALETTE.text, gap: 18 },
  note: { size: 23, weight: 400, fill: PALETTE.muted, gap: 14 },
  stale: { size: 23, weight: 700, fill: PALETTE.bannerText, gap: 22 },
  facts: { size: 25, weight: 400, fill: PALETTE.text, gap: 18 },
  safety: { size: 25, weight: 700, fill: PALETTE.text, gap: 18 },
  disclaimer: { size: 21, weight: 400, fill: PALETTE.muted, gap: 14 },
  madeAt: { size: 20, weight: 400, fill: PALETTE.muted, gap: 22 },
  permalink: { size: 20, weight: 700, fill: PALETTE.muted, gap: 4 },
};

/** The stale block sits in a banner box; this is its inner padding. */
const BANNER_PAD = 14;

const HEADER_SIZE = 28;
const HEADER_BASELINE = PADDING + HEADER_SIZE;
const BODY_TOP = HEADER_BASELINE + 44;
/** The lowest the text may reach: the bottom padding, halved — the card has no footer bar. */
const BODY_LIMIT = SHARE_CARD_HEIGHT - PADDING / 2;

/**
 * Greedy word wrap to at most `maxChars` per line. A word longer than a line — a URL, a
 * long place name — is broken hard rather than allowed to run off the card. Breaks happen
 * at whitespace other than the no-break space, which is how a stamp stays on one line.
 */
export function wrapText(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/[^\S\u00a0]+/u).filter((w) => w !== '')) {
    let rest = word;
    while ([...rest].length > limit) {
      if (current !== '') {
        lines.push(current);
        current = '';
      }
      const chars = [...rest];
      lines.push(chars.slice(0, limit).join(''));
      rest = chars.slice(limit).join('');
    }
    if (current === '') current = rest;
    else if ([...current].length + 1 + [...rest].length <= limit) current = `${current} ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

function charsPerLine(size: number, width: number): number {
  return width / (size * GLYPH_EM);
}

interface PlacedLine {
  readonly role: ShareCardRole;
  readonly text: string;
  readonly baseline: number;
  readonly size: number;
}

interface Layout {
  readonly height: number;
  readonly lines: readonly PlacedLine[];
  readonly banner: { readonly top: number; readonly bottom: number } | null;
}

function layoutAt(
  card: ShareCard,
  scale: number,
): { readonly bottom: number } & Omit<Layout, 'height'> {
  const lines: PlacedLine[] = [];
  let banner: Layout['banner'] = null;
  let cursor = BODY_TOP;
  for (const block of card.blocks) {
    const style = STYLE[block.role];
    const size = Math.round(style.size * scale);
    const inset = block.role === 'stale' ? BANNER_PAD : 0;
    const wrapped = wrapText(block.text, charsPerLine(size, CONTENT_WIDTH - 2 * inset));
    cursor += Math.round(style.gap * scale);
    const top = cursor;
    cursor += inset;
    for (const text of wrapped) {
      cursor += Math.round(size * LINE_HEIGHT);
      // Baseline sits a fifth of the line box above its bottom — descenders fit below it.
      lines.push({ role: block.role, text, baseline: cursor - Math.round(size * 0.25), size });
    }
    cursor += inset;
    if (block.role === 'stale') banner = { top, bottom: cursor };
  }
  return { lines, banner, bottom: cursor };
}

/**
 * The largest body scale in [{@link MIN_SCALE}, 1] at which the card fits the OG frame,
 * or the minimum scale on a card grown tall enough to hold it all.
 */
export function layoutShareCard(card: ShareCard): Layout {
  const steps = Math.round((1 - MIN_SCALE) / SCALE_STEP);
  for (let step = 0; step <= steps; step += 1) {
    const scale = 1 - step * SCALE_STEP;
    const laid = layoutAt(card, scale);
    if (laid.bottom <= BODY_LIMIT) {
      return { height: SHARE_CARD_HEIGHT, lines: laid.lines, banner: laid.banner };
    }
  }
  const laid = layoutAt(card, MIN_SCALE);
  return {
    height: laid.bottom + PADDING / 2,
    lines: laid.lines,
    banner: laid.banner,
  };
}

/* -------------------------------------------------------------------------- */
/* SVG                                                                         */
/* -------------------------------------------------------------------------- */

/** XML text/attribute escaping — place names and URLs are data, not markup. */
export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function textElement(
  x: number,
  y: number,
  size: number,
  weight: number,
  fill: string,
  text: string,
  anchor: 'start' | 'end' = 'start',
): string {
  const anchorAttr = anchor === 'end' ? ' text-anchor="end"' : '';
  return `<text x="${String(x)}" y="${String(y)}" font-size="${String(size)}" font-weight="${String(weight)}" fill="${fill}"${anchorAttr}>${escapeXml(text)}</text>`;
}

/** A rendered card: the SVG document and the pixel size it is drawn at. */
export interface ShareCardImage {
  readonly svg: string;
  readonly width: number;
  /** {@link SHARE_CARD_HEIGHT}, unless the copy needed more room (see {@link MIN_SCALE}). */
  readonly height: number;
}

/**
 * The card as a standalone SVG document. Deterministic: no ids, no randomness, no clock —
 * the same {@link ShareCard} renders to the same string.
 */
export function renderShareCardSvg(card: ShareCard): ShareCardImage {
  const layout = layoutShareCard(card);
  const width = SHARE_CARD_WIDTH;
  const height = layout.height;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" xml:lang="${card.locale}" font-family="${escapeXml(FONT_FAMILY)}">`,
    `<title>${escapeXml(card.blocks[0]?.text ?? card.brand)}</title>`,
    `<rect width="${String(width)}" height="${String(height)}" fill="${PALETTE.background}"/>`,
    textElement(PADDING, HEADER_BASELINE, HEADER_SIZE, 700, PALETTE.text, card.brand),
    textElement(width - PADDING, HEADER_BASELINE, 22, 700, PALETTE.muted, card.tier, 'end'),
    `<rect x="${String(PADDING)}" y="${String(HEADER_BASELINE + 18)}" width="${String(CONTENT_WIDTH)}" height="2" fill="${PALETTE.border}"/>`,
  ];
  if (layout.banner !== null) {
    parts.push(
      `<rect x="${String(PADDING)}" y="${String(layout.banner.top)}" width="${String(CONTENT_WIDTH)}" height="${String(layout.banner.bottom - layout.banner.top)}" rx="8" fill="${PALETTE.bannerBackground}" stroke="${PALETTE.bannerBorder}" stroke-width="2"/>`,
    );
  }
  for (const line of layout.lines) {
    const style = STYLE[line.role];
    const x = line.role === 'stale' ? PADDING + BANNER_PAD : PADDING;
    parts.push(textElement(x, line.baseline, line.size, style.weight, style.fill, line.text));
  }
  parts.push('</svg>');
  return { svg: parts.join(''), width, height };
}
