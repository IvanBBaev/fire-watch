/**
 * Reading MeteoAlarm's legacy Atom feeds and CAP alerts down to the warnings V2-B3 relays
 * (DATA-SOURCES-EXTENDED §J11): **forest-fire** warnings, with **high-temperature**
 * warnings as context. Everything else MeteoAlarm carries — fog, rain, wind, thunderstorms —
 * is out of scope and dropped here.
 *
 * ## Two documents, because the Atom entry does not carry the type code
 *
 * An Atom entry (`feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-<country>`, keyless,
 * CC BY 4.0-equivalent) has the region, the validity and the CAP fields MeteoAlarm copies
 * up — but not the `awareness_type` parameter that says what the warning is about. Its
 * `<title>` does say it, in MeteoAlarm's own generated grammar,
 * `"<Colour> <Type> Warning issued for <Country> - <Region>"` (e.g. `"Yellow Fog Warning
 * issued for Greece - Epirus"`, recorded 2026-10-24). So:
 *
 *   * a title naming a known **non-fire** type is dropped without another request — the
 *     common case, and the one that keeps the poller polite;
 *   * a title naming **forest fire** or **high temperature**, or one this reader cannot
 *     place, is a *candidate*: its linked CAP alert is fetched once and classified from
 *     the authoritative `awareness_type` parameter (`8` forest-fire, `5` high-temperature)
 *     and, for national services that tag fire with an OET event code instead
 *     (OET-087 Forest Fire, OET-095 Grass Fire, OET-079 Fire, OET-220 Forest Fire), from
 *     `<eventCode>`.
 *
 * When a candidate's CAP alert cannot be had, a title that already names forest fire or
 * high temperature is classified from the title (MeteoAlarm generates it from the same
 * `awareness_type`); an unplaceable title is dropped and the cycle reports it.
 *
 * ## Levels
 *
 * MeteoAlarm's awareness levels are 2 (yellow), 3 (orange) and 4 (red); 1 (green, "no
 * particular awareness") is not a warning and is dropped. The product does **not** show
 * MeteoAlarm's colours — fire owns red on this map (CI-14) — it shows the level word.
 */

import { isoFromEpochMs } from '../ports/clock.js';
import { childElements, childText, firstChild, parseXml, textOf, type XmlElement } from './xml.js';

/** One national feed. `slug` is MeteoAlarm's, `code` the ISO 3166-1 alpha-2 we label with. */
export interface MeteoalarmCountry {
  readonly code: string;
  readonly slug: string;
}

/**
 * The countries polled: Bulgaria and its neighbours inside the polled box. Turkey is
 * absent because MeteoAlarm's `meteoalarm-legacy-atom-turkey` answers 404 (checked
 * 2026-10-24).
 */
export const METEOALARM_COUNTRIES: readonly MeteoalarmCountry[] = [
  { code: 'BG', slug: 'bulgaria' },
  { code: 'GR', slug: 'greece' },
  { code: 'MK', slug: 'republic-of-north-macedonia' },
  { code: 'RS', slug: 'serbia' },
  { code: 'RO', slug: 'romania' },
];

export type WarningKind = 'forest-fire' | 'high-temperature';

export type WarningLevel = 2 | 3 | 4;

/** The awareness_type codes relayed (MeteoAlarm's list, DATA-SOURCES-EXTENDED §J11). */
export const AWARENESS_TYPE_FOREST_FIRE = 8;
export const AWARENESS_TYPE_HIGH_TEMPERATURE = 5;

/** CAP `<eventCode>` values that mean fire (OET, per national service). */
export const FIRE_EVENT_CODES: ReadonlySet<string> = new Set([
  'OET-087',
  'OET-095',
  'OET-079',
  'OET-220',
]);

/** The only origin a CAP link from the feed may point at — nothing else is ever fetched. */
export const METEOALARM_CAP_ORIGIN = 'https://feeds.meteoalarm.org';

const LEVEL_WORDS: Readonly<Record<string, WarningLevel>> = { yellow: 2, orange: 3, red: 4 };

/** Title type words MeteoAlarm generates, normalised (lower case, separators as spaces). */
const NON_FIRE_TYPES: ReadonlySet<string> = new Set([
  'wind',
  'snow ice',
  'snow',
  'ice',
  'thunderstorm',
  'thunderstorms',
  'fog',
  'low temperature',
  'coastal event',
  'coastalevent',
  'avalanche',
  'avalanches',
  'rain',
  'flooding',
  'flood',
  'rain flood',
]);

const FIRE_TYPES: ReadonlySet<string> = new Set(['forest fire', 'forestfire', 'fire']);
const HEAT_TYPES: ReadonlySet<string> = new Set(['high temperature', 'hightemperature', 'heat']);

export type TitleClass =
  | { readonly kind: 'not-relayed' }
  | { readonly kind: 'candidate'; readonly guess: WarningKind | null; readonly level: WarningLevel }
  | { readonly kind: 'unplaceable' };

/** What a title says, before any CAP alert is read. */
export function classifyTitle(title: string): TitleClass {
  const match = /^(\w+)\s+(.+?)\s+warning\s+issued\s+for\s+/i.exec(title.trim());
  if (match === null) return { kind: 'unplaceable' };
  const colour = (match[1] ?? '').toLowerCase();
  if (colour === 'green') return { kind: 'not-relayed' };
  const level = LEVEL_WORDS[colour];
  if (level === undefined) return { kind: 'unplaceable' };
  const type = normaliseType(match[2] ?? '');
  if (NON_FIRE_TYPES.has(type)) return { kind: 'not-relayed' };
  if (FIRE_TYPES.has(type)) return { kind: 'candidate', guess: 'forest-fire', level };
  if (HEAT_TYPES.has(type)) return { kind: 'candidate', guess: 'high-temperature', level };
  return { kind: 'candidate', guess: null, level };
}

function normaliseType(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One Atom entry, with only what the relay needs. */
export interface AtomEntry {
  /** The Atom `<id>`; unique per CAP alert × info × area. */
  readonly id: string;
  readonly title: string;
  readonly region: string;
  /** The EMMA_ID geocode MeteoAlarm uses for the region (e.g. `GR014`), when given. */
  readonly emmaId: string | null;
  readonly event: string | null;
  readonly onset: string | null;
  readonly effective: string | null;
  readonly expires: string;
  readonly sent: string | null;
  readonly severity: string | null;
  /** The linked CAP alert, only when it is on {@link METEOALARM_CAP_ORIGIN}. */
  readonly capUrl: string | null;
  /** MeteoAlarm's page for the region (`https://meteoalarm.org?geocode=EMMA_ID:…`). */
  readonly regionUrl: string | null;
}

export interface ParsedAtomFeed {
  /** The feed's `<updated>`, as given. */
  readonly updated: string | null;
  readonly entries: readonly AtomEntry[];
  /** Entries dropped as malformed, cancelled, or not an actual alert. */
  readonly skipped: number;
}

/** Parses one national Atom feed, or `null` when the body is not one. */
export function parseAtomFeed(body: string): ParsedAtomFeed | null {
  const root = parseXml(body);
  if (root?.name !== 'feed') return null;
  const entries: AtomEntry[] = [];
  let skipped = 0;
  for (const entry of childElements(root, 'entry')) {
    const parsed = parseAtomEntry(entry);
    if (parsed === null) skipped += 1;
    else entries.push(parsed);
  }
  return { updated: childText(root, 'updated'), entries, skipped };
}

function parseAtomEntry(entry: XmlElement): AtomEntry | null {
  const id = childText(entry, 'id');
  const title = childText(entry, 'title');
  const expires = isoOrNull(childText(entry, 'cap:expires'));
  if (id === null || title === null || expires === null) return null;
  const status = childText(entry, 'cap:status');
  const messageType = childText(entry, 'cap:message_type');
  if (status !== null && status !== 'Actual') return null;
  if (messageType !== null && messageType !== 'Alert' && messageType !== 'Update') return null;

  let capUrl: string | null = null;
  let regionUrl: string | null = null;
  for (const link of childElements(entry, 'link')) {
    const href = link.attributes['href'] ?? '';
    if (link.attributes['type'] === 'application/cap+xml') {
      capUrl = isCapUrl(href) ? href : null;
    } else if (link.attributes['rel'] === undefined && isMeteoalarmPage(href)) {
      regionUrl = href;
    }
  }
  const geocode = firstChild(entry, 'cap:geocode');
  const emmaId =
    geocode !== undefined && childText(geocode, 'valueName') === 'EMMA_ID'
      ? childText(geocode, 'value')
      : null;

  return {
    id,
    title,
    region: childText(entry, 'cap:areaDesc') ?? regionFromTitle(title) ?? '',
    emmaId: emmaId !== null && /^[A-Z]{2}[0-9A-Z]{1,8}$/.test(emmaId) ? emmaId : null,
    event: childText(entry, 'cap:event'),
    onset: isoOrNull(childText(entry, 'cap:onset')),
    effective: isoOrNull(childText(entry, 'cap:effective')),
    expires,
    sent: isoOrNull(childText(entry, 'cap:sent')),
    severity: childText(entry, 'cap:severity'),
    capUrl,
    regionUrl,
  };
}

function regionFromTitle(title: string): string | null {
  const dash = title.lastIndexOf(' - ');
  return dash === -1 ? null : title.slice(dash + 3).trim() || null;
}

/** A CAP link the poller may follow: https on MeteoAlarm's feed host, nothing else. */
export function isCapUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return url.origin === METEOALARM_CAP_ORIGIN && url.protocol === 'https:' && url.username === '';
  } catch {
    return false;
  }
}

function isMeteoalarmPage(href: string): boolean {
  try {
    const url = new URL(href);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'meteoalarm.org' || url.hostname === 'www.meteoalarm.org')
    );
  } catch {
    return false;
  }
}

/** What one CAP alert says about the warning type and level. */
export interface CapClassification {
  readonly awarenessType: number | null;
  readonly awarenessLevel: number | null;
  readonly fireEventCode: string | null;
  /** The English headline when there is one, else the first. */
  readonly headline: string | null;
  /** The issuing national service's page (`<web>`), https only. */
  readonly issuerUrl: string | null;
}

/** Parses a CAP 1.2 alert's classification, or `null` when the body is not one. */
export function parseCapAlert(body: string): CapClassification | null {
  const root = parseXml(body);
  if (root?.name !== 'alert') return null;
  const infos = childElements(root, 'info');
  if (infos.length === 0) return null;
  const english = infos.find((info) =>
    (childText(info, 'language') ?? '').toLowerCase().startsWith('en'),
  );
  const primary = english ?? infos[0];
  if (primary === undefined) return null;

  let fireEventCode: string | null = null;
  for (const info of infos) {
    for (const code of childElements(info, 'eventCode')) {
      const value = (childText(code, 'value') ?? '').toUpperCase();
      if (fireEventCode === null && FIRE_EVENT_CODES.has(value)) fireEventCode = value;
    }
  }
  const web = childText(primary, 'web');
  return {
    awarenessType: leadingCode(parameter(primary, 'awareness_type')),
    awarenessLevel: leadingCode(parameter(primary, 'awareness_level')),
    fireEventCode,
    headline: childText(primary, 'headline'),
    issuerUrl: web !== null && isHttps(web) ? web : null,
  };
}

function parameter(info: XmlElement, name: string): string | null {
  for (const entry of childElements(info, 'parameter')) {
    if (childText(entry, 'valueName') === name) return textOf(firstChild(entry, 'value'));
  }
  return null;
}

/** `"8; forest-fire"` → 8. */
function leadingCode(value: string | null): number | null {
  if (value === null) return null;
  const match = /^\s*(\d{1,2})\s*(;|$)/.exec(value);
  return match === null ? null : Number(match[1]);
}

/** The relayed kind of a CAP alert, or `null` when it is neither fire nor heat. */
export function kindOfCap(cap: CapClassification): WarningKind | null {
  if (cap.awarenessType === AWARENESS_TYPE_FOREST_FIRE || cap.fireEventCode !== null) {
    return 'forest-fire';
  }
  if (cap.awarenessType === AWARENESS_TYPE_HIGH_TEMPERATURE) return 'high-temperature';
  return null;
}

export function warningLevel(code: number | null): WarningLevel | null {
  return code === 2 || code === 3 || code === 4 ? code : null;
}

function isHttps(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** An instant with an explicit zone (`Z` or `±hh:mm`) as UTC ISO; a naive one is refused. */
function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? isoFromEpochMs(ms) : null;
}
