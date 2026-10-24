/**
 * The stored MeteoAlarm warnings document (V2-B3) and the serving view of it.
 *
 * The worker's refresh job writes `meteoalarm/current.json` with a sha256 sidecar; the
 * overlay route reads it, verifies it and serves the warnings still in force at the
 * request's `now`. The document is the relay's whole state — no database, no migration.
 *
 * Staleness is a property of the document, not of the request: a poller that stopped more
 * than {@link METEOALARM_MAX_STALENESS_MS} ago makes the route answer 503, so a quiet
 * panel always means "no warnings in force", never "nobody has looked for an hour".
 */

import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import type { WarningKind, WarningLevel } from './meteoalarm-feed.js';

export const METEOALARM_SCHEMA_VERSION = 1;

export const METEOALARM_DIR = 'meteoalarm';
export const METEOALARM_CURRENT_PATH = `${METEOALARM_DIR}/current.json`;
export const METEOALARM_CURRENT_META_PATH = `${METEOALARM_DIR}/current.meta.json`;

/** Four missed 15-minute cycles: past this the route says "unavailable", not "none". */
export const METEOALARM_MAX_STALENESS_MS = 60 * 60_000;

export interface MeteoalarmCountryState {
  readonly country: string;
  /** When this country's feed was last read successfully; `null` if never in this process. */
  readonly checked_at: string | null;
  /** Whether the last attempt succeeded. A failed country keeps its last-known warnings. */
  readonly ok: boolean;
}

export interface MeteoalarmWarning {
  /** MeteoAlarm's Atom entry id — stable across cycles. */
  readonly id: string;
  readonly country: string;
  readonly region: string;
  readonly emma_id: string | null;
  readonly kind: WarningKind;
  readonly level: WarningLevel;
  /** The issuer's event name as MeteoAlarm relays it (e.g. "Moderate forest-fire warning"). */
  readonly event: string | null;
  readonly headline: string | null;
  readonly onset: string | null;
  readonly expires: string;
  readonly sent: string | null;
  /** MeteoAlarm's page for the region — the official source link. */
  readonly source_url: string | null;
  /** The issuing national service's page, from the CAP `<web>`. */
  readonly issuer_url: string | null;
  /** True when the kind came from the CAP alert itself, false when from the Atom title. */
  readonly cap_confirmed: boolean;
}

export interface MeteoalarmDocument {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly countries: readonly MeteoalarmCountryState[];
  readonly warnings: readonly MeteoalarmWarning[];
}

/** The served view: the same shape, holding only warnings in force at `now`, fire first. */
export type MeteoalarmOverlayBody = MeteoalarmDocument;

export type MeteoalarmSelection =
  | { readonly ok: true; readonly body: MeteoalarmOverlayBody }
  | { readonly ok: false; readonly reason: 'stale' };

export function selectActiveWarnings(
  document: MeteoalarmDocument,
  now: EpochMs,
): MeteoalarmSelection {
  if (now - epochMsFromIso(document.generated_at) > METEOALARM_MAX_STALENESS_MS) {
    return { ok: false, reason: 'stale' };
  }
  const warnings = document.warnings
    .filter((warning) => epochMsFromIso(warning.expires) > now)
    .slice()
    .sort(compareWarnings);
  return {
    ok: true,
    body: {
      schema_version: document.schema_version,
      generated_at: document.generated_at,
      countries: document.countries,
      warnings,
    },
  };
}

/** Fire before heat, then higher level, then country and region, then id — total order. */
export function compareWarnings(a: MeteoalarmWarning, b: MeteoalarmWarning): number {
  if (a.kind !== b.kind) return a.kind === 'forest-fire' ? -1 : 1;
  if (a.level !== b.level) return b.level - a.level;
  return (
    a.country.localeCompare(b.country, 'en') ||
    a.region.localeCompare(b.region, 'en') ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

/** Validates a stored document; `null` when any field is off. */
export function parseMeteoalarmDocument(text: string): MeteoalarmDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw['schema_version'] !== METEOALARM_SCHEMA_VERSION) return null;
  if (!isIso(raw['generated_at'])) return null;
  const countries = raw['countries'];
  const warnings = raw['warnings'];
  if (!Array.isArray(countries) || !Array.isArray(warnings)) return null;
  if (!countries.every(isCountryState) || !warnings.every(isWarning)) return null;
  return raw as unknown as MeteoalarmDocument;
}

function isCountryState(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['country'] === 'string' &&
    (value['checked_at'] === null || isIso(value['checked_at'])) &&
    typeof value['ok'] === 'boolean'
  );
}

function isWarning(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value['id'] === 'string' &&
    typeof value['country'] === 'string' &&
    typeof value['region'] === 'string' &&
    nullableString(value['emma_id']) &&
    (value['kind'] === 'forest-fire' || value['kind'] === 'high-temperature') &&
    (value['level'] === 2 || value['level'] === 3 || value['level'] === 4) &&
    nullableString(value['event']) &&
    nullableString(value['headline']) &&
    (value['onset'] === null || isIso(value['onset'])) &&
    isIso(value['expires']) &&
    (value['sent'] === null || isIso(value['sent'])) &&
    nullableHttps(value['source_url']) &&
    nullableHttps(value['issuer_url']) &&
    typeof value['cap_confirmed'] === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function nullableHttps(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.startsWith('https://'));
}
