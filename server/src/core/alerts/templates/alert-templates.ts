/**
 * The alert templates: `template_id` + `template_params` → the three-part copy a channel
 * sends (TASKS H6; ADR-004 D1, D7; GLOSSARY §2, §3, §3b, §5.2).
 *
 * Pure and synchronous, per the renderer port: no clock, no I/O, no fetched copy. Every
 * word comes from `alert-copy.ts`; this module only decides which lines an alert has, in
 * what order, and how a channel's length limit is met.
 *
 * **Parameters are validated strictly.** A missing, ill-typed or unknown key throws, so a
 * decision that bound the wrong shape fails at dispatch as `errored` — loud in the cycle
 * line, silent on every phone — rather than rendering "Fire near undefined". The key list
 * per template is also what the pseudonymization classification
 * ({@link ALERT_TEMPLATE_PARAM_PRIVACY}) is checked against.
 *
 * **Timestamps** are rendered in the request's IANA zone with Intl, 24-hour (`h23`), in
 * the same locale tags the web uses (`bg-BG`, `en-GB`), so an alert and the event page
 * show one instant the same way. The frozen strings carry `HH:MM` with no offset, which
 * is why the repeated 03:30 on the October transition renders twice as `03:30` (S14).
 *
 * **Truncation** happens only at whole lines. A line cut in half can turn frozen copy
 * into a banned sentence — `safety_no_travel` shortened to "Do not travel toward the
 * fire" is exactly rule 7's vocabulary without its negation's context — so a channel
 * limit drops optional lines from the end, never characters, and a template whose
 * required lines alone exceed the limit throws.
 *
 * **Voice.** Every template is own-voice except the `official_then_redetected` escalation,
 * which relays an authority's statement with its link and timestamp; {@link lintContextFor}
 * is how the gateway's never-send lint learns that, and it reads the same parameters.
 */

import { SCORE_BUCKETS, type NeverSendContext, type ScoreBucket } from '@fire-watch/contracts';

import type { RenderedAlert } from '../../ports/alert-channel.js';
import type { AlertChannel } from '../../ports/alert-outbox-store.js';
import type { RenderRequest } from '../../ports/alert-renderer.js';
import { PRODUCT_NAME } from '../../snapshot/snapshot-builder.js';

import {
  ALERT_COPY,
  ALERT_COPY_PENDING_FOUNDER_REVIEW,
  fillCopy,
  type AlertCopyKey,
  type AlertLocale,
} from './alert-copy.js';

// ── Identity ─────────────────────────────────────────────────────────────────

export const ALERT_TEMPLATE_IDS = ['new_fire.v1', 'escalation.v1', 'digest.v1'] as const;
export type AlertTemplateId = (typeof ALERT_TEMPLATE_IDS)[number];

export const ESCALATION_RUNGS = ['score_upgrade', 'area_doubling', 'lifecycle_worsening'] as const;
export type EscalationRung = (typeof ESCALATION_RUNGS)[number];

/** How the lifecycle worsened; only `official_then_redetected` relays a quoted statement. */
export const LIFECYCLE_WORSENING_VARIANTS = [
  'redetected',
  'reignition',
  'official_then_redetected',
] as const;
export type LifecycleWorseningVariant = (typeof LIFECYCLE_WORSENING_VARIANTS)[number];

export const OFFICIAL_STATUSES = ['contained', 'extinguished'] as const;
export type OfficialStatus = (typeof OFFICIAL_STATUSES)[number];

// ── Channel limits ───────────────────────────────────────────────────────────

/**
 * Body budgets in characters. Push is a lock-screen surface where a few lines are read;
 * Telegram's hard cap is 4096 characters for the whole message, and the budget leaves
 * room for the title, link and footer. Email has no practical limit. The push figure is
 * a draft (founder decision) — the web-push adapter's own byte cap is far larger.
 */
export const BODY_MAX_CHARS: Readonly<Record<AlertChannel, number | null>> = {
  push: 480,
  telegram: 3000,
  email: null,
};

// ── Parameters ───────────────────────────────────────────────────────────────

/** A place name per locale: the outbox row is bound before the recipient's locale is. */
export interface LocalizedPlace {
  readonly bg: string;
  readonly en: string;
}

interface EventParams {
  readonly eventUrl: string;
  readonly placeName: LocalizedPlace;
  readonly distanceKm: number;
  readonly zoneLabel: string | null;
  readonly observedAt: string;
  readonly scoreBucket: ScoreBucket;
  readonly burnedAreaHa: number | null;
  readonly areaSource: string | null;
  readonly agriBurn: boolean;
}

export type NewFireParams = EventParams;

export interface EscalationParams extends EventParams {
  readonly rung: EscalationRung;
  readonly variant: LifecycleWorseningVariant | null;
  readonly officialStatus: OfficialStatus | null;
  readonly officialStatementAt: string | null;
  readonly officialSourceLabel: string | null;
  readonly officialSourceUrl: string | null;
}

export interface DigestEntry {
  readonly eventUrl: string;
  readonly placeName: LocalizedPlace;
  readonly distanceKm: number;
  readonly observedAt: string;
  readonly scoreBucket: ScoreBucket;
  readonly burnedAreaHa: number | null;
  readonly areaSource: string | null;
  readonly agriBurn: boolean;
}

export interface DigestParams {
  readonly windowStart: string;
  readonly zoneLabel: string | null;
  readonly entries: readonly DigestEntry[];
}

const EVENT_KEYS = [
  'eventUrl',
  'placeName',
  'distanceKm',
  'zoneLabel',
  'observedAt',
  'scoreBucket',
  'burnedAreaHa',
  'areaSource',
  'agriBurn',
] as const;

const ESCALATION_KEYS = [
  ...EVENT_KEYS,
  'rung',
  'variant',
  'officialStatus',
  'officialStatementAt',
  'officialSourceLabel',
  'officialSourceUrl',
] as const;

const DIGEST_KEYS = ['windowStart', 'zoneLabel', 'entries'] as const;

/** The parameter keys each template accepts — exactly these, all of them present. */
export const ALERT_TEMPLATE_PARAM_KEYS: Readonly<Record<AlertTemplateId, readonly string[]>> = {
  'new_fire.v1': EVENT_KEYS,
  'escalation.v1': ESCALATION_KEYS,
  'digest.v1': DIGEST_KEYS,
};

/**
 * Which parameters A1.3 pseudonymization could keep (`non-personal`) and which describe
 * the recipient (`personal`). A proposal for `RETAINED_TEMPLATE_PARAM_KEYS`
 * (`core/erasure/erasure-plan.ts`), not wired into it: filling that list is an erasure
 * decision. `distanceKm` is personal because, with the event's public position, it
 * places the zone centre on a circle; `entries` carries one per event.
 */
export const ALERT_TEMPLATE_PARAM_PRIVACY: Readonly<
  Record<(typeof ESCALATION_KEYS | typeof DIGEST_KEYS)[number], 'personal' | 'non-personal'>
> = {
  eventUrl: 'non-personal',
  placeName: 'non-personal',
  distanceKm: 'personal',
  zoneLabel: 'personal',
  observedAt: 'non-personal',
  scoreBucket: 'non-personal',
  burnedAreaHa: 'non-personal',
  areaSource: 'non-personal',
  agriBurn: 'non-personal',
  rung: 'non-personal',
  variant: 'non-personal',
  officialStatus: 'non-personal',
  officialStatementAt: 'non-personal',
  officialSourceLabel: 'non-personal',
  officialSourceUrl: 'non-personal',
  windowStart: 'non-personal',
  entries: 'personal',
};

type Params = Readonly<Record<string, unknown>>;

function fail(templateId: string, message: string): never {
  throw new Error(`template ${templateId}: ${message}`);
}

function assertKeys(templateId: string, params: Params, keys: readonly string[]): void {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    fail(templateId, 'params must be an object');
  }
  for (const key of keys) {
    if (!(key in params)) fail(templateId, `missing param ${key}`);
  }
  for (const key of Object.keys(params)) {
    if (!keys.includes(key)) fail(templateId, `unknown param ${key}`);
  }
}

function readString(templateId: string, params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(templateId, `${key} must be a non-empty string`);
  }
  return value;
}

function readNullableString(templateId: string, params: Params, key: string): string | null {
  return params[key] === null ? null : readString(templateId, params, key);
}

function readHttpsUrl(templateId: string, params: Params, key: string): string {
  const value = readString(templateId, params, key);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(templateId, `${key} must be an absolute URL`);
  }
  if (url.protocol !== 'https:') fail(templateId, `${key} must be an https URL`);
  return value;
}

function readInstant(templateId: string, params: Params, key: string): string {
  const value = readString(templateId, params, key);
  // An offset is required: a bare local time would be read in the host's zone.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(templateId, `${key} must be an ISO-8601 instant with an offset`);
  }
  return value;
}

function readNonNegative(templateId: string, params: Params, key: string): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(templateId, `${key} must be a finite non-negative number`);
  }
  return value;
}

function readBoolean(templateId: string, params: Params, key: string): boolean {
  const value = params[key];
  if (typeof value !== 'boolean') fail(templateId, `${key} must be a boolean`);
  return value;
}

function readEnum<T extends string>(
  templateId: string,
  params: Params,
  key: string,
  allowed: readonly T[],
): T {
  const value = params[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(templateId, `${key} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function readPlace(templateId: string, params: Params, key: string): LocalizedPlace {
  const value = params[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(templateId, `${key} must be an object with bg and en names`);
  }
  const place = value as Params;
  assertKeys(`${templateId} ${key}`, place, ['bg', 'en']);
  return {
    bg: readString(templateId, place, 'bg'),
    en: readString(templateId, place, 'en'),
  };
}

function readArea(
  templateId: string,
  params: Params,
): { burnedAreaHa: number | null; areaSource: string | null } {
  const burnedAreaHa =
    params['burnedAreaHa'] === null ? null : readNonNegative(templateId, params, 'burnedAreaHa');
  const areaSource = readNullableString(templateId, params, 'areaSource');
  // GLOSSARY §5.2: the burned-area figure is always attributed to its source.
  if ((burnedAreaHa === null) !== (areaSource === null)) {
    fail(templateId, 'burnedAreaHa and areaSource are given together or not at all');
  }
  return { burnedAreaHa, areaSource };
}

function readEventFields(templateId: string, params: Params): EventParams {
  return {
    eventUrl: readHttpsUrl(templateId, params, 'eventUrl'),
    placeName: readPlace(templateId, params, 'placeName'),
    distanceKm: readNonNegative(templateId, params, 'distanceKm'),
    zoneLabel: readNullableString(templateId, params, 'zoneLabel'),
    observedAt: readInstant(templateId, params, 'observedAt'),
    scoreBucket: readEnum(templateId, params, 'scoreBucket', SCORE_BUCKETS),
    ...readArea(templateId, params),
    agriBurn: readBoolean(templateId, params, 'agriBurn'),
  };
}

export function readNewFireParams(params: Params): NewFireParams {
  const id = 'new_fire.v1';
  assertKeys(id, params, EVENT_KEYS);
  return readEventFields(id, params);
}

export function readEscalationParams(params: Params): EscalationParams {
  const id = 'escalation.v1';
  assertKeys(id, params, ESCALATION_KEYS);
  const event = readEventFields(id, params);
  const rung = readEnum(id, params, 'rung', ESCALATION_RUNGS);
  const official = [
    'officialStatus',
    'officialStatementAt',
    'officialSourceLabel',
    'officialSourceUrl',
  ] as const;

  if (rung !== 'lifecycle_worsening') {
    if (params['variant'] !== null) fail(id, `variant is only for lifecycle_worsening`);
  }
  const variant =
    rung === 'lifecycle_worsening'
      ? readEnum(id, params, 'variant', LIFECYCLE_WORSENING_VARIANTS)
      : null;
  if (rung === 'area_doubling' && event.burnedAreaHa === null) {
    fail(id, 'area_doubling needs burnedAreaHa');
  }

  if (variant !== 'official_then_redetected') {
    for (const key of official) {
      if (params[key] !== null) fail(id, `${key} is only for official_then_redetected`);
    }
    return {
      ...event,
      rung,
      variant,
      officialStatus: null,
      officialStatementAt: null,
      officialSourceLabel: null,
      officialSourceUrl: null,
    };
  }
  // CI-10 §5.5: the quoted exemption needs both a source URL and a statement timestamp,
  // so a relayed statement without either is not renderable at all.
  return {
    ...event,
    rung,
    variant,
    officialStatus: readEnum(id, params, 'officialStatus', OFFICIAL_STATUSES),
    officialStatementAt: readInstant(id, params, 'officialStatementAt'),
    officialSourceLabel: readString(id, params, 'officialSourceLabel'),
    officialSourceUrl: readHttpsUrl(id, params, 'officialSourceUrl'),
  };
}

export function readDigestParams(params: Params): DigestParams {
  const id = 'digest.v1';
  assertKeys(id, params, DIGEST_KEYS);
  const raw = params['entries'];
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(id, 'entries must be a non-empty array');
  }
  const entryKeys = EVENT_KEYS.filter((key) => key !== 'zoneLabel');
  const entries = raw.map((value: unknown, index): DigestEntry => {
    const entryId = `${id} entries[${String(index)}]`;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail(entryId, 'must be an object');
    }
    const entry = value as Params;
    assertKeys(entryId, entry, entryKeys);
    return {
      eventUrl: readHttpsUrl(entryId, entry, 'eventUrl'),
      placeName: readPlace(entryId, entry, 'placeName'),
      distanceKm: readNonNegative(entryId, entry, 'distanceKm'),
      observedAt: readInstant(entryId, entry, 'observedAt'),
      scoreBucket: readEnum(entryId, entry, 'scoreBucket', SCORE_BUCKETS),
      ...readArea(entryId, entry),
      agriBurn: readBoolean(entryId, entry, 'agriBurn'),
    };
  });
  return {
    windowStart: readInstant(id, params, 'windowStart'),
    zoneLabel: readNullableString(id, params, 'zoneLabel'),
    entries,
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** The BCP-47 tags the web uses, so an alert and the event page agree on a timestamp. */
const LOCALE_TAG: Readonly<Record<AlertLocale, string>> = { bg: 'bg-BG', en: 'en-GB' };

/**
 * The product locale for a BCP-47 tag (`bg`, `bg-BG`, `en-US` …). Anything else throws:
 * no template has copy for it, and a silent fallback would send Bulgarian to a reader
 * who asked for something else without anyone having decided that it should.
 */
export function alertLocale(tag: string): AlertLocale {
  const primary = tag.split(/[-_]/u)[0]?.toLowerCase();
  if (primary === 'bg' || primary === 'en') return primary;
  throw new Error(`no alert copy for locale ${tag}`);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  locale: AlertLocale,
  timeZone: string,
  kind: 'time' | 'dateTime' | 'date',
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${kind}`;
  let cached = formatters.get(key);
  if (cached === undefined) {
    const time: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    };
    const date: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' };
    const options = kind === 'time' ? time : kind === 'date' ? date : { ...date, ...time };
    // An unknown zone throws a RangeError here, which is the failure we want.
    cached = new Intl.DateTimeFormat(LOCALE_TAG[locale], { ...options, timeZone });
    formatters.set(key, cached);
  }
  return cached;
}

/** `HH:MM`, 24-hour, in the recipient's zone — the §3 `HH:MM` slot. */
export function formatAlertTime(iso: string, locale: AlertLocale, timeZone: string): string {
  return formatter(locale, timeZone, 'time').format(new Date(iso));
}

/** Date and `HH:MM` — the §3/§3b `<date HH:MM>` slot. */
export function formatAlertDateTime(iso: string, locale: AlertLocale, timeZone: string): string {
  return formatter(locale, timeZone, 'dateTime').format(new Date(iso));
}

/** Date only — the §3b `<date>` slot. */
export function formatAlertDate(iso: string, locale: AlertLocale, timeZone: string): string {
  return formatter(locale, timeZone, 'date').format(new Date(iso));
}

function formatNumber(value: number, locale: AlertLocale, fractionDigits = 0): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale], {
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

function twoSignificantFigures(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(2));
}

/**
 * GLOSSARY §5.2 `area_both_units`: both units, two significant figures, `~`, дка first for
 * Bulgarian readers. The same arithmetic as the web's `areaBothUnits`.
 */
export function formatAreaBothUnits(ha: number, locale: AlertLocale): string {
  const roundedHa = formatNumber(twoSignificantFigures(ha), locale, 20);
  const roundedDka = formatNumber(twoSignificantFigures(ha * 10), locale, 20);
  return locale === 'bg'
    ? `~${roundedDka} дка (${roundedHa} ha)`
    : `~${roundedHa} ha (${roundedDka} дка)`;
}

/** One decimal under 10 km, whole kilometres beyond: the precision a reader acts on. */
export function formatDistance(km: number, locale: AlertLocale): string {
  const value =
    km < 10
      ? formatNumber(Math.round(km * 10) / 10, locale, 1)
      : formatNumber(Math.round(km), locale);
  return fillCopy('unit.distanceKm', locale, { km: value });
}

function zoneName(label: string | null, locale: AlertLocale): string {
  return label === null
    ? fillCopy('zone.default', locale)
    : fillCopy('zone.named', locale, { label });
}

function tierLabel(bucket: ScoreBucket, locale: AlertLocale): string {
  const key: AlertCopyKey = `tier.${bucket}`;
  return fillCopy(key, locale);
}

// ── Lines and truncation ─────────────────────────────────────────────────────

interface Line {
  readonly text: string;
  /** A required line survives every channel limit; the template throws instead. */
  readonly required: boolean;
}

const required = (text: string): Line => ({ text, required: true });
const optional = (text: string): Line => ({ text, required: false });

/**
 * Drops optional lines, last first, until the body fits. Whole lines only — see the
 * module comment for why a character cut is never acceptable.
 */
function fitLines(templateId: string, lines: readonly Line[], max: number | null): string {
  const kept = [...lines];
  const length = (): number => kept.map((line) => line.text).join('\n').length;
  for (let index = kept.length - 1; max !== null && length() > max && index >= 0; index -= 1) {
    if (!kept[index]!.required) kept.splice(index, 1);
  }
  if (max !== null && length() > max) {
    fail(templateId, `required lines exceed the ${String(max)}-character body limit`);
  }
  return kept.map((line) => line.text).join('\n');
}

function footer(locale: AlertLocale): string {
  return [
    fillCopy('footer.attribution', locale),
    fillCopy('licence.lanceTactical', locale),
    fillCopy('licence.lanceAsIs', locale),
    fillCopy('footer.scope', locale, { product: PRODUCT_NAME }),
  ].join('\n');
}

function eventLines(
  params: EventParams,
  locale: AlertLocale,
  timeZone: string,
  options: { readonly activeLine: boolean; readonly areaRequired: boolean },
): { readonly head: Line[]; readonly tail: Line[] } {
  const head = [
    required(fillCopy('line.confidence', locale, { tier: tierLabel(params.scoreBucket, locale) })),
  ];
  if (params.scoreBucket === 'unverified')
    head.push(required(fillCopy('line.unverifiedNote', locale)));
  head.push(
    required(
      fillCopy('line.distance', locale, {
        zone: zoneName(params.zoneLabel, locale),
        distance: formatDistance(params.distanceKm, locale),
      }),
    ),
  );
  if (options.activeLine) {
    head.push(
      required(
        fillCopy('frozen.active', locale, {
          time: formatAlertTime(params.observedAt, locale, timeZone),
        }),
      ),
    );
  }
  const tail: Line[] = [];
  if (params.burnedAreaHa !== null && params.areaSource !== null) {
    const area = fillCopy('line.area', locale, {
      area: formatAreaBothUnits(params.burnedAreaHa, locale),
      source: params.areaSource,
    });
    tail.push(options.areaRequired ? required(area) : optional(area));
  }
  if (params.agriBurn) tail.push(optional(fillCopy('frozen.agriBurnTag', locale)));
  return { head, tail };
}

/** Render-time knobs a test may override; production uses {@link BODY_MAX_CHARS}. */
export interface RenderOptions {
  readonly bodyMaxChars?: Readonly<Partial<Record<AlertChannel, number | null>>>;
}

function bodyLimit(channel: AlertChannel, options: RenderOptions): number | null {
  const override = options.bodyMaxChars?.[channel];
  return override === undefined ? BODY_MAX_CHARS[channel] : override;
}

// ── Templates ────────────────────────────────────────────────────────────────

function renderNewFire(request: RenderRequest, options: RenderOptions): RenderedAlert {
  const locale = alertLocale(request.locale);
  const params = readNewFireParams(request.templateParams);
  const { head, tail } = eventLines(params, locale, request.timeZone, {
    activeLine: true,
    areaRequired: false,
  });
  const lines = [...head, ...tail, required(fillCopy('frozen.safetyNoTravel', locale))];
  return {
    title: fillCopy('newFire.title', locale, { place: params.placeName[locale] }),
    body: fitLines('new_fire.v1', lines, bodyLimit(request.channel, options)),
    footer: footer(locale),
    url: params.eventUrl,
  };
}

function reasonLine(params: EscalationParams, locale: AlertLocale, timeZone: string): string {
  switch (params.rung) {
    case 'score_upgrade':
      return fillCopy('escalation.scoreUpgrade', locale, {
        tier: tierLabel(params.scoreBucket, locale),
      });
    case 'area_doubling':
      return fillCopy('escalation.areaDoubling', locale);
    case 'lifecycle_worsening':
      break;
  }
  switch (params.variant) {
    case 'redetected':
      return fillCopy('escalation.redetected', locale);
    case 'reignition':
      return fillCopy('escalation.reignition', locale);
    case 'official_then_redetected':
    case null:
      break;
  }
  const status = params.officialStatus;
  const statementAt = params.officialStatementAt;
  const label = params.officialSourceLabel;
  const url = params.officialSourceUrl;
  if (status === null || statementAt === null || label === null || url === null) {
    fail('escalation.v1', 'official_then_redetected needs the official statement fields');
  }
  return fillCopy('frozen.officialThenRedetected', locale, {
    detectedAt: formatAlertDateTime(params.observedAt, locale, timeZone),
    officialStatus: fillCopy(`frozen.officialStatus.${status}`, locale),
    statementDate: formatAlertDate(statementAt, locale, timeZone),
    source: fillCopy('source.withLink', locale, { label, url }),
  });
}

function renderEscalation(request: RenderRequest, options: RenderOptions): RenderedAlert {
  const locale = alertLocale(request.locale);
  const params = readEscalationParams(request.templateParams);
  // The §3b string already states the detection time; a second "last detection" line
  // would say the same instant twice in two formats.
  const { head, tail } = eventLines(params, locale, request.timeZone, {
    activeLine: params.variant !== 'official_then_redetected',
    areaRequired: params.rung === 'area_doubling',
  });
  const lines = [
    required(reasonLine(params, locale, request.timeZone)),
    ...head,
    ...tail,
    required(fillCopy('frozen.safetyNoTravel', locale)),
  ];
  return {
    title: fillCopy('escalation.title', locale, { place: params.placeName[locale] }),
    body: fitLines('escalation.v1', lines, bodyLimit(request.channel, options)),
    footer: footer(locale),
    url: params.eventUrl,
  };
}

function digestEntryLines(
  entry: DigestEntry,
  locale: AlertLocale,
  timeZone: string,
  channel: AlertChannel,
): string[] {
  const lines = [
    fillCopy('digest.entry', locale, {
      nearPlace: fillCopy('event.nearPlace', locale, { place: entry.placeName[locale] }),
      distance: formatDistance(entry.distanceKm, locale),
      tier: tierLabel(entry.scoreBucket, locale),
      dateTime: formatAlertDateTime(entry.observedAt, locale, timeZone),
    }),
  ];
  if (entry.burnedAreaHa !== null && entry.areaSource !== null) {
    lines.push(
      `  ${fillCopy('line.area', locale, {
        area: formatAreaBothUnits(entry.burnedAreaHa, locale),
        source: entry.areaSource,
      })}`,
    );
  }
  if (entry.agriBurn) lines.push(`  ${fillCopy('frozen.agriBurnTag', locale)}`);
  // A push notification opens one link; the text channels can carry one per event.
  if (channel !== 'push') lines.push(`  ${entry.eventUrl}`);
  return lines;
}

function renderDigest(request: RenderRequest, options: RenderOptions): RenderedAlert {
  const locale = alertLocale(request.locale);
  const params = readDigestParams(request.templateParams);
  const zone = zoneName(params.zoneLabel, locale);
  const count = params.entries.length;
  const intro =
    count === 1
      ? fillCopy('digest.introOne', locale, { zone })
      : fillCopy('digest.introMany', locale, { zone, count: formatNumber(count, locale) });
  const safety = fillCopy('frozen.safetyNoTravel', locale);
  const blocks = params.entries.map((entry) =>
    digestEntryLines(entry, locale, request.timeZone, request.channel).join('\n'),
  );
  const max = bodyLimit(request.channel, options);

  // Entries are dropped whole from the end and counted in a "+N more" line, so a
  // truncated digest still says how many events it did not list.
  let shown = blocks.length;
  const compose = (): string => {
    const hidden = blocks.length - shown;
    const more =
      hidden === 0
        ? []
        : [fillCopy('digest.more', locale, { count: formatNumber(hidden, locale) })];
    return [intro, ...blocks.slice(0, shown), ...more, safety].join('\n');
  };
  while (max !== null && shown > 0 && compose().length > max) shown -= 1;
  if (max !== null && compose().length > max) {
    fail('digest.v1', `required lines exceed the ${String(max)}-character body limit`);
  }

  return {
    title: fillCopy('digest.title', locale, {
      dateTime: formatAlertDateTime(params.windowStart, locale, request.timeZone),
    }),
    body: compose(),
    footer: footer(locale),
    url: null,
  };
}

// ── Registry and governance ──────────────────────────────────────────────────

export type RenderAlertTemplate = (
  request: RenderRequest,
  options?: RenderOptions,
) => RenderedAlert;

/**
 * Every template as drafted. **Not** what the gateway sends with — that is the subset
 * {@link isReviewedTemplate} admits, which is empty until the founder clears the copy.
 */
export const DRAFT_ALERT_TEMPLATES: ReadonlyMap<AlertTemplateId, RenderAlertTemplate> = new Map<
  AlertTemplateId,
  RenderAlertTemplate
>([
  ['new_fire.v1', (request, options = {}) => renderNewFire(request, options)],
  ['escalation.v1', (request, options = {}) => renderEscalation(request, options)],
  ['digest.v1', (request, options = {}) => renderDigest(request, options)],
]);

const SHARED_COPY: readonly AlertCopyKey[] = [
  'footer.attribution',
  'footer.scope',
  'licence.lanceTactical',
  'licence.lanceAsIs',
  'tier.confirmed',
  'tier.likely',
  'tier.unverified',
  'unit.distanceKm',
  'zone.default',
  'zone.named',
  'frozen.safetyNoTravel',
  'frozen.agriBurnTag',
  'line.area',
];

const EVENT_COPY: readonly AlertCopyKey[] = [
  ...SHARED_COPY,
  'line.confidence',
  'line.unverifiedNote',
  'line.distance',
  'frozen.active',
];

/** The copy each template can render — what a review of that template has to cover. */
export const ALERT_TEMPLATE_COPY: Readonly<Record<AlertTemplateId, readonly AlertCopyKey[]>> = {
  'new_fire.v1': [...EVENT_COPY, 'newFire.title'],
  'escalation.v1': [
    ...EVENT_COPY,
    'escalation.title',
    'escalation.scoreUpgrade',
    'escalation.areaDoubling',
    'escalation.redetected',
    'escalation.reignition',
    'frozen.officialThenRedetected',
    'frozen.officialStatus.contained',
    'frozen.officialStatus.extinguished',
    'source.withLink',
  ],
  'digest.v1': [
    ...SHARED_COPY,
    'digest.title',
    'digest.introOne',
    'digest.introMany',
    'digest.entry',
    'digest.more',
    'event.nearPlace',
  ],
};

/** A template is reviewed when none of the copy it can render is pending founder review. */
export function isReviewedTemplate(templateId: AlertTemplateId): boolean {
  return ALERT_TEMPLATE_COPY[templateId].every(
    (key) => !ALERT_COPY_PENDING_FOUNDER_REVIEW.includes(key),
  );
}

/** Convenience for tests and the CI-10 matrix: render any drafted template by id. */
export function renderAlertTemplate(
  request: RenderRequest,
  options: RenderOptions = {},
): RenderedAlert {
  const template = DRAFT_ALERT_TEMPLATES.get(request.templateId as AlertTemplateId);
  if (template === undefined) throw new Error(`no alert template ${request.templateId}`);
  return template(request, options);
}

// ── Voice ────────────────────────────────────────────────────────────────────

const OWN_VOICE: NeverSendContext = Object.freeze({ voice: 'own' });

/**
 * The never-send context for a rendered alert (CI-10 §5.5), from the same parameters the
 * template read. Own voice for everything except the `official_then_redetected`
 * escalation, which relays an authority's statement and carries its URL and timestamp.
 * Parameters that do not validate get own voice — the strictest reading — and the
 * template itself will refuse to render them anyway.
 */
export function lintContextFor(templateId: string, params: Params): NeverSendContext {
  if (templateId !== 'escalation.v1') return OWN_VOICE;
  let parsed: EscalationParams;
  try {
    parsed = readEscalationParams(params);
  } catch {
    return OWN_VOICE;
  }
  if (
    parsed.variant !== 'official_then_redetected' ||
    parsed.officialSourceLabel === null ||
    parsed.officialSourceUrl === null ||
    parsed.officialStatementAt === null
  ) {
    return OWN_VOICE;
  }
  return {
    voice: 'quoted-official',
    quotedSource: {
      authority: parsed.officialSourceLabel,
      sourceUrl: parsed.officialSourceUrl,
      statementAt: parsed.officialStatementAt,
    },
  };
}

/** Re-exported so callers need one import for the governance picture. */
export { ALERT_COPY, ALERT_COPY_PENDING_FOUNDER_REVIEW };
