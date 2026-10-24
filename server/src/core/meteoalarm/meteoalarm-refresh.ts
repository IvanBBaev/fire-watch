/**
 * One MeteoAlarm poll (V2-B3; DATA-SOURCES-EXTENDED §J11): read each polled country's
 * Atom feed, keep the forest-fire and high-temperature warnings, and store them as one
 * document the overlay route serves.
 *
 * ## Being a polite client
 *
 *   * **Every {@link METEOALARM_REFRESH_INTERVAL_MS}** (15 min), one feed request per
 *     country, carrying the previous answer's validators (`If-None-Match`,
 *     `If-Modified-Since`). National services issue warnings a few times a day; a quarter
 *     of an hour is well inside what a reader needs and well outside what a feed notices.
 *   * **CAP alerts only for candidates.** An entry whose title names a non-fire type is
 *     dropped without a request (`classifyTitle`); only fire, heat and unplaceable titles
 *     have their CAP alert read, and each alert **once**: alerts are immutable (an update
 *     is a new alert with a new URL), so the parsed answer is cached for as long as the
 *     entry is in a feed, then forgotten. At most {@link METEOALARM_MAX_CAP_FETCHES_PER_CYCLE}
 *     alerts are fetched per cycle; the rest wait for the next.
 *   * **Nothing outside MeteoAlarm is followed.** A CAP link must be on
 *     `https://feeds.meteoalarm.org` (`isCapUrl`), or it is not fetched.
 *
 * ## What is stored
 *
 * `meteoalarm/current.json` (+ sha256 sidecar): the warnings of every country, each
 * country's last good read and whether this cycle's read worked. A country whose feed
 * fails keeps its last-known entries (they expire on their own `expires`) and is marked
 * `ok: false`; the panel says so. When **no** country could be read this cycle the document
 * is **not** rewritten — rewriting would refresh `generated_at` over old data — so it ages
 * until the route's staleness bound turns it into a 503.
 *
 * ## The `meteoalarm:warnings` feed row
 *
 * Recorded every cycle. It **succeeds** only when every country was read (200 or 304),
 * every candidate was classified and the document was written; `hadData` is "the document
 * was written". The row never pages (context only).
 */

import { canonicalJson } from '../determinism/canonical-json.js';
import { isoFromEpochMs, epochMsFromIso, type Clock, type EpochMs } from '../ports/clock.js';
import type { FeedStatusStore } from '../ports/feed-status-store.js';
import type { FeedValidators, MeteoalarmClient } from '../ports/meteoalarm-client.js';
import type { PayloadStore } from '../ports/payload-store.js';
import {
  METEOALARM_CURRENT_META_PATH,
  METEOALARM_CURRENT_PATH,
  METEOALARM_SCHEMA_VERSION,
  compareWarnings,
  type MeteoalarmCountryState,
  type MeteoalarmDocument,
  type MeteoalarmWarning,
} from './meteoalarm-document.js';
import {
  METEOALARM_COUNTRIES,
  classifyTitle,
  kindOfCap,
  parseAtomFeed,
  parseCapAlert,
  warningLevel,
  type AtomEntry,
  type CapClassification,
  type MeteoalarmCountry,
  type WarningKind,
  type WarningLevel,
} from './meteoalarm-feed.js';

export const METEOALARM_REFRESH_INTERVAL_MS = 15 * 60_000;

export const METEOALARM_MAX_CAP_FETCHES_PER_CYCLE = 40;

export const METEOALARM_PROVIDER = 'meteoalarm';

export interface MeteoalarmRefreshDeps {
  readonly client: MeteoalarmClient;
  readonly payloads: PayloadStore;
  readonly clock: Clock;
  /** Where the `meteoalarm:warnings` attempt is recorded, every cycle. */
  readonly feedStatus: FeedStatusStore;
  /** Defaults to {@link METEOALARM_COUNTRIES}; injectable for tests. */
  readonly countries?: readonly MeteoalarmCountry[];
  readonly maxCapFetchesPerCycle?: number;
}

export type CountryOutcome = 'parsed' | 'not_modified' | 'fetch_failed' | 'invalid';

export interface CountryResult {
  readonly country: string;
  readonly outcome: CountryOutcome;
  /** Entries held for this country after the cycle (current or carried). */
  readonly entries: number;
  readonly error: string | null;
}

export interface MeteoalarmRefreshReport {
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs;
  readonly countries: readonly CountryResult[];
  /** Warnings written (fire + heat, unexpired). */
  readonly warnings: number;
  readonly capFetches: number;
  readonly capFailures: number;
  /** Candidates left for the next cycle because the per-cycle CAP budget ran out. */
  readonly capDeferred: number;
  /** Candidates that could be classified neither from CAP nor from the title. */
  readonly unresolved: number;
  /** True when the document was written this cycle. */
  readonly written: boolean;
  readonly writeError: string | null;
  /** `null` when the `meteoalarm:warnings` feed row was recorded. */
  readonly feedStatusError: string | null;
}

/** Degraded when nothing could be read or stored, or the feed row was not recorded. */
export function meteoalarmRefreshFailed(report: MeteoalarmRefreshReport): boolean {
  return report.writeError !== null || report.feedStatusError !== null || !report.written;
}

interface CountryState {
  validators: FeedValidators | null;
  entries: readonly AtomEntry[];
  checkedAt: EpochMs | null;
}

export interface MeteoalarmRefresh {
  run(): Promise<MeteoalarmRefreshReport>;
}

/** The job, with the per-process state (validators, last entries, CAP cache) it carries. */
export function createMeteoalarmRefresh(deps: MeteoalarmRefreshDeps): MeteoalarmRefresh {
  const countries = deps.countries ?? METEOALARM_COUNTRIES;
  const maxCapFetches = deps.maxCapFetchesPerCycle ?? METEOALARM_MAX_CAP_FETCHES_PER_CYCLE;
  const state = new Map<string, CountryState>();
  /** Parsed CAP alerts by URL; `null` is a body that was not a CAP alert (not re-asked). */
  const capCache = new Map<string, CapClassification | null>();

  return {
    async run(): Promise<MeteoalarmRefreshReport> {
      const startedAt = deps.clock.now();
      const results: CountryResult[] = [];
      for (const country of countries) {
        results.push(await readCountry(country));
      }

      const now = deps.clock.now();
      let capFetches = 0;
      let capFailures = 0;
      let capDeferred = 0;
      let unresolved = 0;
      const warnings: MeteoalarmWarning[] = [];
      const liveCapUrls = new Set<string>();

      for (const country of countries) {
        for (const entry of state.get(country.code)?.entries ?? []) {
          if (epochMsFromIso(entry.expires) <= now) continue;
          const title = classifyTitle(entry.title);
          if (title.kind === 'not-relayed') continue;
          if (entry.capUrl !== null) liveCapUrls.add(entry.capUrl);

          let cap: CapClassification | null | undefined =
            entry.capUrl === null ? undefined : capCache.get(entry.capUrl);
          if (cap === undefined && entry.capUrl !== null && !capCache.has(entry.capUrl)) {
            if (capFetches >= maxCapFetches) {
              capDeferred += 1;
            } else {
              capFetches += 1;
              const fetched = await fetchCapSafely(entry.capUrl);
              if (fetched.body === null) {
                capFailures += 1;
              } else {
                cap = parseCapAlert(fetched.body);
                capCache.set(entry.capUrl, cap);
              }
            }
          }

          const resolved = resolve(title, cap ?? null);
          if (resolved === 'not-relayed') continue;
          if (resolved === null) {
            unresolved += 1;
            continue;
          }
          warnings.push({
            id: entry.id,
            country: country.code,
            region: entry.region,
            emma_id: entry.emmaId,
            kind: resolved.kind,
            level: resolved.level,
            event: entry.event,
            headline: cap?.headline ?? null,
            onset: entry.onset ?? entry.effective,
            expires: entry.expires,
            sent: entry.sent,
            source_url: entry.regionUrl,
            issuer_url: cap?.issuerUrl ?? null,
            cap_confirmed: resolved.capConfirmed,
          });
        }
      }
      for (const url of [...capCache.keys()]) {
        if (!liveCapUrls.has(url)) capCache.delete(url);
      }

      const anyRead = results.some(
        (result) => result.outcome === 'parsed' || result.outcome === 'not_modified',
      );
      let written = false;
      let writeError: string | null = null;
      if (anyRead) {
        const document: MeteoalarmDocument = {
          schema_version: METEOALARM_SCHEMA_VERSION,
          generated_at: isoFromEpochMs(now),
          countries: countries.map((country, index): MeteoalarmCountryState => {
            const checkedAt = state.get(country.code)?.checkedAt ?? null;
            const outcome = results[index]?.outcome;
            return {
              country: country.code,
              checked_at: checkedAt === null ? null : isoFromEpochMs(checkedAt),
              ok: outcome === 'parsed' || outcome === 'not_modified',
            };
          }),
          warnings: warnings.sort(compareWarnings),
        };
        try {
          const text = `${canonicalJson(document)}\n`;
          const stored = await deps.payloads.writeText(METEOALARM_CURRENT_PATH, text);
          await deps.payloads.writeText(
            METEOALARM_CURRENT_META_PATH,
            `${canonicalJson({
              provider: METEOALARM_PROVIDER,
              schema_version: METEOALARM_SCHEMA_VERSION,
              generated_at: document.generated_at,
              warnings: document.warnings.length,
              sha256: stored.sha256,
              bytes: stored.bytes,
            })}\n`,
          );
          written = true;
        } catch (error: unknown) {
          writeError = describeError(error);
        }
      }

      const problems: string[] = [];
      for (const result of results) {
        if (result.outcome === 'fetch_failed' || result.outcome === 'invalid') {
          problems.push(`${result.country}: ${result.error ?? result.outcome}`);
        }
      }
      if (capFailures > 0) problems.push(`${String(capFailures)} CAP alert(s) unreadable`);
      if (capDeferred > 0) problems.push(`${String(capDeferred)} CAP alert(s) deferred`);
      if (unresolved > 0) problems.push(`${String(unresolved)} warning(s) unclassified`);
      if (writeError !== null) problems.push(`write failed: ${writeError}`);
      if (!anyRead) problems.push('no country feed could be read');

      const feedStatusError = await recordFeed(problems, written);
      return {
        startedAt,
        finishedAt: deps.clock.now(),
        countries: results,
        warnings: written ? warnings.length : 0,
        capFetches,
        capFailures,
        capDeferred,
        unresolved,
        written,
        writeError,
        feedStatusError,
      };
    },
  };

  async function readCountry(country: MeteoalarmCountry): Promise<CountryResult> {
    const previous = state.get(country.code) ?? {
      validators: null,
      entries: [],
      checkedAt: null,
    };
    state.set(country.code, previous);
    const held = (): number => previous.entries.length;
    let fetched;
    try {
      fetched = await deps.client.fetchFeed(country.slug, previous.validators);
    } catch (error: unknown) {
      fetched = { kind: 'failed' as const, status: null, error: describeError(error) };
    }
    if (fetched.kind === 'failed') {
      return {
        country: country.code,
        outcome: 'fetch_failed',
        entries: held(),
        error: fetched.error,
      };
    }
    if (fetched.kind === 'not-modified') {
      if (previous.checkedAt === null) {
        return {
          country: country.code,
          outcome: 'invalid',
          entries: held(),
          error: '304 without a previous answer',
        };
      }
      previous.checkedAt = deps.clock.now();
      return { country: country.code, outcome: 'not_modified', entries: held(), error: null };
    }
    const parsed = parseAtomFeed(fetched.body);
    if (parsed === null) {
      return {
        country: country.code,
        outcome: 'invalid',
        entries: held(),
        error: 'body is not an Atom feed',
      };
    }
    previous.entries = parsed.entries;
    previous.validators = fetched.validators;
    previous.checkedAt = deps.clock.now();
    return { country: country.code, outcome: 'parsed', entries: held(), error: null };
  }

  async function fetchCapSafely(url: string): Promise<{ body: string | null }> {
    try {
      return await deps.client.fetchCap(url);
    } catch {
      return { body: null };
    }
  }

  async function recordFeed(problems: readonly string[], written: boolean): Promise<string | null> {
    try {
      await deps.feedStatus.recordAttempt({
        row: 'meteoalarm:warnings',
        attemptAt: deps.clock.now(),
        succeeded: written && problems.length === 0,
        hadData: written,
        error: problems.length === 0 ? null : problems.join('; '),
      });
      return null;
    } catch (error: unknown) {
      return describeError(error);
    }
  }
}

type Resolved = { kind: WarningKind; level: WarningLevel; capConfirmed: boolean };

/**
 * The relayed kind and level of a candidate: the CAP alert's when it was read, else the
 * title's when the title names fire or heat. `'not-relayed'` when the CAP alert says it is
 * neither; `null` when nothing can place it.
 */
function resolve(
  title: ReturnType<typeof classifyTitle>,
  cap: CapClassification | null,
): Resolved | 'not-relayed' | null {
  const titleLevel = title.kind === 'candidate' ? title.level : null;
  if (cap !== null) {
    const kind = kindOfCap(cap);
    if (kind === null)
      return cap.awarenessType === null && cap.fireEventCode === null
        ? fromTitle(title)
        : 'not-relayed';
    const level = warningLevel(cap.awarenessLevel) ?? titleLevel;
    if (level === null) return cap.awarenessLevel === 1 ? 'not-relayed' : null;
    return { kind, level, capConfirmed: true };
  }
  return fromTitle(title);
}

function fromTitle(title: ReturnType<typeof classifyTitle>): Resolved | null {
  if (title.kind !== 'candidate' || title.guess === null) return null;
  return { kind: title.guess, level: title.level, capConfirmed: false };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
