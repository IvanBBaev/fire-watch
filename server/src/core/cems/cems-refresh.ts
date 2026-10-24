/**
 * One Copernicus EMS refresh (TASKS V2-E3; DATA-SOURCES §V2-E3): read the wildfire
 * activation list, read the detail of each activation near coverage whose AOIs are not
 * already known, keep the ones in coverage, and store them as the overlay document.
 *
 * ## Being a polite client
 *
 * The dashboard API is public, keyless and undocumented as a machine interface: it is what
 * the Rapid Mapping portal reads. So the job asks little of it:
 *
 *   * **Hourly** ({@link CEMS_REFRESH_INTERVAL_MS}). Activations are triggered by civil
 *     protection authorities a handful of times a month across Europe; an hour is far
 *     inside how long a fire lasts and two orders of magnitude under how often the portal
 *     itself polls.
 *   * **The list walk stops at the retention horizon** ({@link CEMS_RETENTION_MS}): pages
 *     are newest first, so the walk ends at the first page that reaches back past it, at
 *     the API's last page, or at {@link CEMS_MAX_PAGES} — about three requests today.
 *   * **A detail is read once per change.** An activation whose `lastUpdate` matches the
 *     stored one keeps its stored AOIs; a candidate whose detail put it outside coverage is
 *     remembered with its `lastUpdate` ({@link CEMS_OUTSIDE_PATH}) and not read again until
 *     that changes; at most {@link CEMS_MAX_DETAILS_PER_CYCLE} details are read in one
 *     cycle and the rest wait for the next.
 *
 * ## Outcomes
 *
 * A list that cannot be read or parsed ends the cycle **without writing**: the stored
 * document keeps its `available_at`, so the route's staleness rule turns it into a 503 once
 * it is six hours old rather than serving an emptied list. A detail answered 403 is
 * `restricted` (art. 53 data, registered users only) — an answer, not a failure. Any other
 * detail failure keeps the previously stored AOIs when there are some, or marks the
 * activation `unavailable` (the web falls back to its centroid).
 *
 * ## The `cems:activations` feed row
 *
 * Every cycle records one attempt. It **succeeds** only when the list was read, the
 * document was written and no kept activation had to fall back for want of its detail.
 * `hadData` is "the document was written". A store failure is reported, never thrown.
 */

import type {
  CemsActivation,
  CemsAoiStatus,
  CemsBox,
  CemsOverlayBody,
} from '@fire-watch/contracts';
import { CEMS_OVERLAY_SCHEMA_VERSION } from '@fire-watch/contracts';

import { POLLING_BBOX, type BoundingBox } from '../config/polling-bbox.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import type { CemsClient } from '../ports/cems-client.js';
import { epochMsFromIso, isoFromEpochMs, type Clock, type EpochMs } from '../ports/clock.js';
import type { FeedStatusStore } from '../ports/feed-status-store.js';
import type { PayloadReader } from '../ports/payload-reader.js';
import type { PayloadStore } from '../ports/payload-store.js';
import {
  CEMS_CURRENT_META_PATH,
  CEMS_CURRENT_PATH,
  CEMS_OUTSIDE_PATH,
  CEMS_PROVIDER,
  parseCemsDocument,
  parseCemsOutside,
} from './cems-document.js';
import {
  isCemsCandidate,
  isCemsInCoverage,
  parseCemsDetail,
  parseCemsList,
  type CemsListEntry,
} from './cems-parse.js';

export const CEMS_REFRESH_INTERVAL_MS = 3_600_000;
export const CEMS_PAGE_LIMIT = 50;
export const CEMS_MAX_PAGES = 10;
export const CEMS_MAX_DETAILS_PER_CYCLE = 20;

/**
 * How far back an activation is kept: two fire seasons, the span the event pages a reader
 * can reach are expected to cover. A founder number.
 */
export const CEMS_RETENTION_MS = 730 * 86_400_000;

export interface CemsRefreshDeps {
  readonly client: CemsClient;
  readonly payloads: PayloadStore & PayloadReader;
  readonly clock: Clock;
  /** Where the `cems:activations` attempt is recorded, every cycle. */
  readonly feedStatus: FeedStatusStore;
  /** Defaults to `POLLING_BBOX`. */
  readonly coverage?: BoundingBox;
}

export type CemsDetailOutcome =
  /** Stored AOIs reused: `lastUpdate` unchanged. */
  | 'reused'
  /** Known to lie outside coverage at this `lastUpdate`; not read again. */
  | 'outside'
  | 'read'
  | 'restricted'
  /** The detail could not be read or parsed. */
  | 'failed'
  /** Over the per-cycle detail budget; the next cycle reads it. */
  | 'deferred';

export interface CemsActivationResult {
  readonly code: string;
  readonly detail: CemsDetailOutcome;
  readonly kept: boolean;
  readonly error: string | null;
}

export interface CemsRefreshReport {
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs;
  readonly pages: number;
  /** `null` when the list was read in full. */
  readonly listError: string | null;
  /** List entries that did not parse. */
  readonly skipped: number;
  readonly candidates: readonly CemsActivationResult[];
  readonly kept: number;
  readonly documentWritten: boolean;
  readonly documentError: string | null;
  /** A stored document that could not be read; the cycle continued without it. */
  readonly previousError: string | null;
  readonly feedStatusError: string | null;
}

/** Degraded when the list, the document or the feed row failed, or a detail fell back. */
export function cemsRefreshFailed(report: CemsRefreshReport): boolean {
  return (
    report.listError !== null ||
    report.documentError !== null ||
    report.feedStatusError !== null ||
    report.candidates.some(
      (entry) => entry.kept && (entry.detail === 'failed' || entry.detail === 'deferred'),
    )
  );
}

export async function runCemsRefresh(deps: CemsRefreshDeps): Promise<CemsRefreshReport> {
  const startedAt = deps.clock.now();
  const coverage = deps.coverage ?? POLLING_BBOX.values;
  const horizon = startedAt - CEMS_RETENTION_MS;

  const { previous, previousError } = await readPrevious(deps);
  const knownOutside = await readOutside(deps);

  const walk = await walkList(deps, horizon);
  if (walk.error !== null) {
    const feedStatusError = await recordFeed(deps, {
      problems: [`list: ${walk.error}`],
      written: false,
    });
    return {
      startedAt,
      finishedAt: deps.clock.now(),
      pages: walk.pages,
      listError: walk.error,
      skipped: walk.skipped,
      candidates: [],
      kept: 0,
      documentWritten: false,
      documentError: null,
      previousError,
      feedStatusError,
    };
  }

  const candidates: CemsActivationResult[] = [];
  const activations: CemsActivation[] = [];
  let detailsRead = 0;
  for (const entry of walk.entries) {
    if (!isCemsCandidate(entry, coverage)) continue;
    const prior = previous.get(entry.code);
    if (prior === undefined && knownOutside.get(entry.code) === entry.last_update) {
      candidates.push({ code: entry.code, detail: 'outside', kept: false, error: null });
      continue;
    }
    let detail: CemsDetailOutcome;
    let aois: readonly CemsBox[];
    let status: CemsAoiStatus;
    let error: string | null = null;
    if (
      prior !== undefined &&
      prior.last_update === entry.last_update &&
      prior.aois_status !== 'unavailable'
    ) {
      detail = 'reused';
      aois = prior.aois;
      status = prior.aois_status;
    } else if (detailsRead >= CEMS_MAX_DETAILS_PER_CYCLE) {
      detail = 'deferred';
      ({ aois, status } = fallback(prior));
      error = 'over the per-cycle detail budget';
    } else {
      detailsRead += 1;
      const read = await readDetail(deps.client, entry.code);
      if (read.ok) {
        detail = read.restricted ? 'restricted' : 'read';
        aois = read.aois;
        status = read.restricted ? 'restricted' : 'public';
      } else {
        detail = 'failed';
        ({ aois, status } = fallback(prior));
        error = read.reason;
      }
    }
    const kept = isCemsInCoverage(entry.centroid, aois, coverage);
    candidates.push({ code: entry.code, detail, kept, error });
    if (kept) activations.push(toActivation(entry, aois, status));
  }

  const document: CemsOverlayBody = {
    schema_version: CEMS_OVERLAY_SCHEMA_VERSION,
    available_at: isoFromEpochMs(walk.availableAt),
    activations,
  };
  let documentError: string | null = null;
  try {
    const written = await deps.payloads.writeText(
      CEMS_CURRENT_PATH,
      `${canonicalJson(document)}\n`,
    );
    await deps.payloads.writeText(
      CEMS_CURRENT_META_PATH,
      `${canonicalJson({
        provider: CEMS_PROVIDER,
        sha256: written.sha256,
        bytes: written.bytes,
        available_at: document.available_at,
        activations: activations.length,
        pages: walk.pages,
        skipped: walk.skipped,
      })}\n`,
    );
    const outside: Record<string, string> = {};
    for (const entry of walk.entries) {
      const result = candidates.find((candidate) => candidate.code === entry.code);
      const settled =
        result !== undefined &&
        !result.kept &&
        (result.detail === 'read' || result.detail === 'restricted' || result.detail === 'outside');
      if (settled) outside[entry.code] = entry.last_update;
    }
    await deps.payloads.writeText(CEMS_OUTSIDE_PATH, `${canonicalJson(outside)}\n`);
  } catch (error: unknown) {
    documentError = `document write failed: ${describeError(error)}`;
  }

  const problems: string[] = [];
  if (documentError !== null) problems.push(documentError);
  for (const entry of candidates) {
    if (entry.kept && entry.error !== null) problems.push(`${entry.code}: ${entry.error}`);
  }
  const feedStatusError = await recordFeed(deps, {
    problems,
    written: documentError === null,
  });
  return {
    startedAt,
    finishedAt: deps.clock.now(),
    pages: walk.pages,
    listError: null,
    skipped: walk.skipped,
    candidates,
    kept: activations.length,
    documentWritten: documentError === null,
    documentError,
    previousError,
    feedStatusError,
  };
}

async function readPrevious(
  deps: CemsRefreshDeps,
): Promise<{ previous: Map<string, CemsActivation>; previousError: string | null }> {
  const previous = new Map<string, CemsActivation>();
  try {
    const text = await deps.payloads.readText(CEMS_CURRENT_PATH);
    if (text === null) return { previous, previousError: null };
    const document = parseCemsDocument(text);
    if (document === null) {
      return { previous, previousError: 'the stored document failed validation' };
    }
    for (const activation of document.activations) previous.set(activation.code, activation);
    return { previous, previousError: null };
  } catch (error: unknown) {
    return { previous, previousError: `stored document unreadable: ${describeError(error)}` };
  }
}

/**
 * The candidates last found outside coverage. Unreadable or invalid means "none known": the
 * cost is one extra round of detail reads, never a wrong document.
 */
async function readOutside(deps: CemsRefreshDeps): Promise<Map<string, string>> {
  try {
    const text = await deps.payloads.readText(CEMS_OUTSIDE_PATH);
    return text === null ? new Map() : parseCemsOutside(text);
  } catch {
    return new Map();
  }
}

interface ListWalk {
  readonly entries: readonly CemsListEntry[];
  readonly pages: number;
  readonly skipped: number;
  /** When the first page arrived. */
  readonly availableAt: EpochMs;
  readonly error: string | null;
}

async function walkList(deps: CemsRefreshDeps, horizon: EpochMs): Promise<ListWalk> {
  const entries: CemsListEntry[] = [];
  let pages = 0;
  let skipped = 0;
  let availableAt: EpochMs | null = null;
  const stop = (error: string | null): ListWalk => ({
    entries,
    pages,
    skipped,
    availableAt: availableAt ?? deps.clock.now(),
    error,
  });
  while (pages < CEMS_MAX_PAGES) {
    const offset = pages * CEMS_PAGE_LIMIT;
    let fetched;
    try {
      fetched = await deps.client.listActivations({ offset, limit: CEMS_PAGE_LIMIT });
    } catch (error: unknown) {
      return stop(describeError(error));
    }
    pages += 1;
    if (fetched.body === null || fetched.availableAt === null) {
      return stop(fetched.error ?? `HTTP ${String(fetched.status)}`);
    }
    availableAt ??= fetched.availableAt;
    const parsed = parseCemsList(fetched.body);
    if (!parsed.ok) return stop(parsed.reason);
    skipped += parsed.skipped;
    let reachedHorizon = false;
    for (const entry of parsed.entries) {
      if (epochMsFromIso(entry.event_time) < horizon) reachedHorizon = true;
      else entries.push(entry);
    }
    if (reachedHorizon || !parsed.hasNext || parsed.entries.length + parsed.skipped === 0) break;
  }
  return stop(null);
}

async function readDetail(
  client: CemsClient,
  code: string,
): Promise<
  | { readonly ok: true; readonly restricted: boolean; readonly aois: readonly CemsBox[] }
  | { readonly ok: false; readonly reason: string }
> {
  let fetched;
  try {
    fetched = await client.activationDetail(code);
  } catch (error: unknown) {
    return { ok: false, reason: describeError(error) };
  }
  if (fetched.status === 403) return { ok: true, restricted: true, aois: [] };
  if (fetched.body === null) {
    return { ok: false, reason: fetched.error ?? `HTTP ${String(fetched.status)}` };
  }
  return parseCemsDetail(fetched.body, code);
}

function fallback(prior: CemsActivation | undefined): {
  aois: readonly CemsBox[];
  status: CemsAoiStatus;
} {
  return prior === undefined || prior.aois_status === 'unavailable'
    ? { aois: [], status: 'unavailable' }
    : { aois: prior.aois, status: prior.aois_status };
}

function toActivation(
  entry: CemsListEntry,
  aois: readonly CemsBox[],
  status: CemsAoiStatus,
): CemsActivation {
  return {
    code: entry.code,
    name: entry.name,
    event_time: entry.event_time,
    activation_time: entry.activation_time,
    last_update: entry.last_update,
    closed: entry.closed,
    countries: entry.countries,
    centroid: entry.centroid,
    aois,
    aois_status: status,
  };
}

async function recordFeed(
  deps: CemsRefreshDeps,
  cycle: { readonly problems: readonly string[]; readonly written: boolean },
): Promise<string | null> {
  try {
    await deps.feedStatus.recordAttempt({
      row: 'cems:activations',
      attemptAt: deps.clock.now(),
      succeeded: cycle.written && cycle.problems.length === 0,
      hadData: cycle.written,
      error: cycle.problems.length === 0 ? null : cycle.problems.join('; '),
    });
    return null;
  } catch (error: unknown) {
    return describeError(error);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
