/**
 * The V2-B3 official-warnings document, the pure half: what the server's (or the fixture's)
 * `/overlays/meteoalarm/warnings.json` body is, and how it is validated.
 *
 * Every warning in it was issued by a national weather service and relayed through
 * MeteoAlarm; Fire Watch selects (forest-fire, with high temperature as context) and never
 * rewords, upgrades or issues one. The server decides what is in force and refuses a stale
 * document with a 503, so the page shows what it is given and labels it with the body's own
 * `generated_at` — never the fetch time.
 */

export type WarningKind = 'forest-fire' | 'high-temperature';

/** MeteoAlarm's awareness levels kept: 2 yellow, 3 orange, 4 red (1 green is dropped). */
export type WarningLevel = 2 | 3 | 4;

/** The countries the server polls (TR's feed is not served by MeteoAlarm). */
export type WarningCountry = 'BG' | 'GR' | 'MK' | 'RS' | 'RO';

export const WARNING_COUNTRIES: readonly WarningCountry[] = ['BG', 'GR', 'MK', 'RS', 'RO'];

export interface MeteoalarmCountryState {
  readonly country: WarningCountry;
  /** The last time this country's feed was read successfully; `null` = never yet. */
  readonly checked_at: string | null;
  /** Whether the last attempt at this country's feed succeeded. */
  readonly ok: boolean;
}

export interface MeteoalarmWarning {
  readonly id: string;
  readonly country: WarningCountry;
  readonly region: string;
  readonly emma_id: string | null;
  readonly kind: WarningKind;
  readonly level: WarningLevel;
  /** The issuer's own event name and headline, relayed verbatim (often English). */
  readonly event: string | null;
  readonly headline: string | null;
  readonly onset: string | null;
  readonly expires: string;
  readonly sent: string | null;
  /** MeteoAlarm's page for the region — the official source link. */
  readonly source_url: string | null;
  /** The issuing national service's page. */
  readonly issuer_url: string | null;
  readonly cap_confirmed: boolean;
}

export interface MeteoalarmAttribution {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly href?: string;
}

/** The wire shape, as the route and the fixture spell it. */
export interface MeteoalarmDoc {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly countries: readonly MeteoalarmCountryState[];
  readonly warnings: readonly MeteoalarmWarning[];
  readonly attribution: readonly MeteoalarmAttribution[];
}

// ── Validation ──────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
  Number.isFinite(Date.parse(value));

const isNullableInstant = (value: unknown): value is string | null =>
  value === null || isInstant(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/** Only https links leave the page; anything else is dropped to `null`, not trusted. */
function httpsOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

const isCountry = (value: unknown): value is WarningCountry =>
  typeof value === 'string' && (WARNING_COUNTRIES as readonly string[]).includes(value);

function parseCountry(value: unknown): MeteoalarmCountryState | null {
  if (!isRecord(value)) return null;
  const { country, checked_at, ok } = value;
  if (!isCountry(country) || !isNullableInstant(checked_at) || typeof ok !== 'boolean') {
    return null;
  }
  return { country, checked_at, ok };
}

function parseWarning(value: unknown): MeteoalarmWarning | null {
  if (!isRecord(value)) return null;
  const { id, country, region, emma_id, kind, level, event, headline } = value;
  const { onset, expires, sent, cap_confirmed } = value;
  if (typeof id !== 'string' || id === '' || !isCountry(country)) return null;
  if (typeof region !== 'string' || region === '' || !isNullableString(emma_id)) return null;
  if (kind !== 'forest-fire' && kind !== 'high-temperature') return null;
  if (level !== 2 && level !== 3 && level !== 4) return null;
  if (!isNullableString(event) || !isNullableString(headline)) return null;
  if (!isNullableInstant(onset) || !isInstant(expires) || !isNullableInstant(sent)) return null;
  if (typeof cap_confirmed !== 'boolean') return null;
  const source_url = httpsOrNull(value['source_url']);
  const issuer_url = httpsOrNull(value['issuer_url']);
  if (source_url === undefined || issuer_url === undefined) return null;
  return {
    id,
    country,
    region,
    emma_id,
    kind,
    level,
    event,
    headline,
    onset,
    expires,
    sent,
    source_url,
    issuer_url,
    cap_confirmed,
  };
}

function parseAttribution(value: unknown): MeteoalarmAttribution | null {
  if (!isRecord(value)) return null;
  const { id, source, text, href } = value;
  if (typeof id !== 'string' || typeof source !== 'string' || typeof text !== 'string') {
    return null;
  }
  if (href === undefined) return { id, source, text };
  const safe = httpsOrNull(href);
  return safe === undefined || safe === null
    ? { id, source, text }
    : { id, source, text, href: safe };
}

function parseAll<T>(value: unknown, parse: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * The body, validated whole: one malformed warning rejects the document rather than being
 * skipped, because a silently dropped row would read as "no warning there".
 */
export function parseMeteoalarmDocument(value: unknown): MeteoalarmDoc | null {
  if (!isRecord(value)) return null;
  if (value['schema_version'] !== 1 || !isInstant(value['generated_at'])) return null;
  const countries = parseAll(value['countries'], parseCountry);
  const warnings = parseAll(value['warnings'], parseWarning);
  const attribution =
    value['attribution'] === undefined ? [] : parseAll(value['attribution'], parseAttribution);
  if (countries === null || warnings === null || attribution === null) return null;
  return {
    schema_version: 1,
    generated_at: value['generated_at'],
    countries,
    warnings,
    attribution,
  };
}

/** The link a warning row offers: MeteoAlarm's region page, else the issuer's own page. */
export function officialLinkOf(warning: MeteoalarmWarning): string | null {
  return warning.source_url ?? warning.issuer_url;
}

/** Countries whose last read failed — the panel names them so their silence is not read as calm. */
export function uncheckedCountries(doc: MeteoalarmDoc): readonly WarningCountry[] {
  return doc.countries.filter((state) => !state.ok).map((state) => state.country);
}
