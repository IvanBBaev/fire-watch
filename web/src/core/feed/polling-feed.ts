/**
 * The polling transport behind `DataFeedPort` (ADR-003 D1: polling is the product; the
 * stream is a later enhancement behind the same port). One snapshot loop, one freshness
 * side-loop and one safety timer, all plain `setTimeout` chains owned by `start()`/`stop()`.
 *
 * ## Request modes (ADR-003 A1.5)
 *
 * The first fetch of a run is always **full** (`snapshotUrl`, no query): a full snapshot is
 * the only proof of the event set, and the `lastSeq` a caller hands `start()` seeds the
 * cursor mark but never stands in for that proof. Once a full `200` has been parsed — or a
 * full `304` has confirmed the set a restart resumed with — ordinary polls become
 * **cursor** requests, `?updated_after_seq=<mark>`, the mark being the highest `max_seq`
 * this run has parsed (seed included), and the **safety timer** bounds them: an
 * independent timer of `safetySnapshotIntervalMs`, jittered downward only, forces a full
 * fetch and is re-armed by every full `200`/`304` from any cause. Cursor responses never
 * touch it, so a cursor-only stretch can never outlive the 10-minute rule.
 *
 * Two ETags, never crossed: a full request carries only a tag learned from a full `200`,
 * so a full `304` means "the whole set is unchanged"; a cursor request carries only the tag
 * of a cursor `200`, and a cursor `304` confirms nothing but the delta. Both tags outlive
 * `stop()` when the next `start()` resumes with a cursor (the store still holds the set
 * they name) and are forgotten when it starts from nothing. A cursor request answered
 * `partial: false` (a static file ignoring the query — the dev fixture) is a full snapshot
 * by its body and is treated as one for the tag, the mark and the safety timer.
 *
 * `cadence: 'safety'` is the mode under a live stream: no cursor polls at all — the initial
 * full fetch, the safety timer's full fetches and the backoff retries of a failed full
 * fetch are the only snapshot traffic. The freshness side-poll runs in every mode and tier.
 *
 * ## Tiers (ADR-003 A1.2)
 *
 * `T1` sends everything to `snapshotUrl` (the origin). `T2` fetches the static copy at
 * `staticSnapshotUrl` — always full, with its own ETag — and then **probes the origin**
 * with a full request so the supervisor's recovery window can watch it: the probe's
 * outcome is reported as `T1`, and a parsed probe body is emitted too (fresher data is
 * fresher data; the reconciler is seq-guarded). Status follows the static fetch alone. T2
 * never backs off exponentially: it paces at the jittered poll interval, an origin
 * `Retry-After` merely skips origin probes until it elapses, and a static `Retry-After`
 * holds the whole cycle. A static `304` keeps the held set usable but never restamps its
 * age: the CDN answers for the object, not for the pipeline behind it. With `staticSnapshotUrl === null` there is no static tier and T2
 * behaves exactly like T1. Every successful origin or static response feeds the
 * server-time tracker — both are the same server family (A1.6).
 *
 * ## Messages and outcomes
 *
 * A parsed `200` emits `snapshot` with the `partial` flag as the wire carried it. A full
 * `304` **from the origin** emits `snapshot-confirmed` with the response `Date` (the origin
 * vouched for the stored set as of then); a cursor `304` and a static `304` emit nothing —
 * the first confirms only a delta, the second only that a CDN still holds an object whose
 * age it knows nothing about. Every snapshot attempt then reports
 * exactly one `PollOutcome` — after the message, so a supervisor reacting to the outcome
 * sees a store that already holds the data. A `200` whose body fails the guard is
 * `unusable` with `status: 200`. The freshness side-poll reports no outcome.
 *
 * ## Status policy (normative for this adapter)
 *
 * - `'connecting'` — from creation (and from every `start()`) until the first successful
 *   attempt of that run.
 * - `'live'` — on every successful attempt; a `304` counts, the failure streak resets.
 * - `'degraded'` — after **2 consecutive** failed attempts (network error, unusable status
 *   code, or a body that fails the snapshot guard). A single failure never changes the
 *   status; the next success returns it to `'live'`.
 * - `'dead'` — only when `stop()` is called. The feed never declares itself dead.
 *
 * ## Error policy
 *
 * Errors are **status-code-driven**; RFC 7807 problem bodies are informational only —
 * "clients key their behavior off the status code and `Retry-After`, never off the
 * problem body" (ADR-003 A1.3). A `429`/`503` additionally holds the next attempt until
 * `Retry-After` (delta-seconds, or an HTTP-date measured against server time, A1.6).
 * In T1, failed attempts back off exponentially from the poll interval, jittered, capped
 * at 5 minutes; an explicit `Retry-After` may hold longer than the cap.
 *
 * Every request has a deadline, {@link REQUEST_TIMEOUT_MS}, body included: one that has
 * not finished by then is aborted and counts as a failed attempt like a network error. A
 * forced fetch (`refetchNow`, a tier change) aborts the snapshot request it supersedes.
 * Bodies the feed does not parse are still read to their end, so the browser completes
 * those requests instead of cancelling them.
 *
 * The freshness side-poll fires once immediately on `start()` (the staleness banner
 * should not wait a full interval for its first data) and then every
 * `freshnessPollIntervalMs`. Its body is parsed **regardless of HTTP status** — the probe
 * API deliberately answers `500` with a valid critical report, and that report is the
 * payload. An unparseable body is skipped silently; the freshness loop never drives feed
 * status.
 */

import type {
  FreshnessReport,
  FreshnessRow,
  FreshnessRowId,
  FreshnessState,
  FreshnessStatus,
} from '@fire-watch/contracts';
import { FRESHNESS_STATES, FRESHNESS_STATUSES } from '@fire-watch/contracts';

import type { ClientConfig } from '../config.js';
import type { Clock, Rng, ServerNow } from '../ports.js';
import type {
  DataFeedPort,
  FeedMessage,
  FeedStatus,
  PollCadence,
  PollOutcome,
  PollingTier,
  Snapshot,
} from '../types.js';
import { parseSnapshot } from './parse-snapshot.js';
import type { ServerTimeTracker } from './server-time.js';
import { createServerTimeTracker } from './server-time.js';

/** Backoff ceiling for failed T1 polls; an explicit `Retry-After` may exceed it. */
const BACKOFF_CAP_MS = 5 * 60_000;

/**
 * The longest one snapshot or freshness request may take, body included, before it is
 * given up as a failed attempt. `fetch` has no deadline of its own: a request the network
 * never answers (a half-open connection, a proxy that swallows it) would otherwise hold
 * the loop forever — no outcome reported, so the status stays `'live'` over a feed that
 * has stopped, and the supervisor never sees the failures that would move it to T2.
 * Generous on purpose: this bounds a stall, it does not judge a slow link.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Consecutive failures before the status turns `'degraded'`. */
const DEGRADED_AFTER_FAILURES = 2;

/** The one query parameter `/snapshot.json` understands (ADR-003 D1, snapshot-route). */
const CURSOR_QUERY_PARAM = 'updated_after_seq';

export interface PollingFeedOptions {
  readonly config: ClientConfig;
  readonly clock: Clock;
  readonly rng: Rng;
  /** Injectable for tests; defaults to the platform `fetch`. */
  readonly fetchFn?: typeof fetch;
  /**
   * Shared server-time tracker (A1.6). Defaults to a private one; the composition root
   * injects the app-wide instance so the store and the UI read the same clock.
   */
  readonly serverTime?: ServerTimeTracker;
}

export interface PollingFeed extends DataFeedPort {
  /**
   * `lastSeq` seeds the cursor mark; `cadence` defaults to `'poll'`. A `null` cursor says
   * the caller holds nothing, so no conditional request is made on its behalf: every
   * remembered ETag is forgotten and the first response of the run carries a body.
   */
  start(cursor: { readonly lastSeq: number | null; readonly cadence?: PollCadence }): void;
  /**
   * Server-corrected clock (ADR-003 A1.6), fed by this feed's own snapshot responses.
   * Exposed so staleness math never has to fall back to the raw device clock.
   */
  readonly serverNow: ServerNow;
  /**
   * Force an immediate *full* snapshot fetch (rule 3 / wake / online). Cancels the pending
   * poll timer; a fetch already in flight is superseded. No-op when not running.
   */
  refetchNow(): void;
  /** Switch origins (A1.2). A change triggers an immediate full fetch; the same tier is a no-op. */
  setTier(tier: PollingTier): void;
  /** One outcome per snapshot attempt, after its message — never for the freshness side-poll. */
  onOutcome(callback: (outcome: PollOutcome) => void): void;
}

/** Which remembered ETag a request carries and refreshes — the tags are never crossed. */
type EtagSlot = 'full' | 'cursor' | 'static';

interface SnapshotRequest {
  readonly url: string;
  readonly tier: PollingTier;
  readonly slot: EtagSlot;
}

/** One attempt, classified by status and guard — the only shape the loops reason about. */
type SnapshotResult =
  | { readonly kind: 'not-modified'; readonly response: Response; readonly rttMs: number }
  | {
      readonly kind: 'parsed';
      readonly response: Response;
      readonly rttMs: number;
      readonly snapshot: Snapshot;
    }
  | { readonly kind: 'unusable'; readonly response: Response | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseFreshnessRowBody(value: unknown): FreshnessRow | null {
  if (!isRecord(value)) return null;
  const row = value['row'];
  // The row id is checked as a string but not against this build's id union: the budget
  // table mints new ids as "a normal change" (contracts/freshness.ts), and a client one
  // release behind must not blind the whole banner because ops added a row.
  if (typeof row !== 'string') return null;
  const state = value['state'];
  if (typeof state !== 'string' || !(FRESHNESS_STATES as readonly string[]).includes(state)) {
    return null;
  }
  const lastSuccessAt = value['lastSuccessAt'];
  const lastDataAt = value['lastDataAt'];
  const ageSeconds = value['ageSeconds'];
  const warnSeconds = value['warnSeconds'];
  const criticalSeconds = value['criticalSeconds'];
  const consecutiveFailures = value['consecutiveFailures'];
  const pages = value['pages'];
  const mutedUntil = value['mutedUntil'];
  const muteReason = value['muteReason'];
  if (!isStringOrNull(lastSuccessAt) || !isStringOrNull(lastDataAt)) return null;
  if (ageSeconds !== null && !isFiniteNumber(ageSeconds)) return null;
  if (!isFiniteNumber(warnSeconds) || !isFiniteNumber(criticalSeconds)) return null;
  if (!isFiniteNumber(consecutiveFailures)) return null;
  if (typeof pages !== 'boolean') return null;
  if (!isStringOrNull(mutedUntil) || !isStringOrNull(muteReason)) return null;
  return {
    row: row as FreshnessRowId,
    lastSuccessAt,
    lastDataAt,
    ageSeconds,
    warnSeconds,
    criticalSeconds,
    state: state as FreshnessState,
    consecutiveFailures,
    pages,
    mutedUntil,
    muteReason,
  };
}

/**
 * Cheap structural guard for the freshness body (camelCase, `FreshnessReport` in
 * `@fire-watch/contracts`). Returns `null` on any defect — the caller skips silently.
 */
export function parseFreshnessReport(input: unknown): FreshnessReport | null {
  if (!isRecord(input)) return null;
  const generatedAt = input['generatedAt'];
  const status = input['status'];
  const budgetVersion = input['budgetVersion'];
  const rows = input['rows'];
  if (typeof generatedAt !== 'string' || typeof budgetVersion !== 'string') return null;
  if (typeof status !== 'string' || !(FRESHNESS_STATUSES as readonly string[]).includes(status)) {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const parsedRows: FreshnessRow[] = [];
  for (const row of rows) {
    const parsed = parseFreshnessRowBody(row);
    if (parsed === null) return null;
    parsedRows.push(parsed);
  }
  return { generatedAt, status: status as FreshnessStatus, budgetVersion, rows: parsedRows };
}

/** The response `Date` as an ISO string, or `null` when absent or unparseable. */
function dateHeaderIso(response: Response): string | null {
  const header = response.headers.get('date');
  if (header === null) return null;
  const ms = Date.parse(header);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * `work`, or a rejection as soon as `signal` aborts. The platform `fetch` honours its
 * signal by itself; this makes the deadline hold for any `fetchFn` and for body reads.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('request aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('request aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Read a body nobody parses (a `304`, an error status) to its end. Left unread, the
 * browser tears the load down as cancelled — DevTools and CDP report every cursor `304`
 * as `net::ERR_ABORTED` — rather than completing it. Failures are irrelevant: the
 * attempt has already been classified by its status.
 */
async function discardBody(response: Response, signal: AbortSignal): Promise<void> {
  try {
    await abortable(response.arrayBuffer(), signal);
  } catch {
    // Nothing to keep.
  }
}

export function createPollingFeed(opts: PollingFeedOptions): PollingFeed {
  const { config, clock, rng } = opts;
  // Wrapped rather than referenced: an unbound `fetch` throws "Illegal invocation" in
  // browsers, and the wrapper keeps the default out of the way of injected stubs.
  const fetchFn: typeof fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const tracker = opts.serverTime ?? createServerTimeTracker(clock);

  const messageCallbacks = new Set<(message: FeedMessage) => void>();
  const statusCallbacks = new Set<(status: FeedStatus) => void>();
  const outcomeCallbacks = new Set<(outcome: PollOutcome) => void>();

  let status: FeedStatus = 'connecting';
  let running = false;
  let tier: PollingTier = 'T1';
  let cadence: PollCadence = 'poll';
  /** Bumped on every start/stop; the freshness loop discards work from an older run. */
  let runGeneration = 0;
  /**
   * Bumped on start/stop and on every forced fetch: a snapshot attempt in flight from an
   * older generation is superseded — its response is dropped and it schedules nothing.
   */
  let fetchGeneration = 0;
  let abort: AbortController | null = null;
  /** The snapshot requests in flight, so a superseding fetch can cancel what it replaces. */
  const inFlight = new Set<AbortController>();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let freshnessTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;
  const etags: Record<EtagSlot, string | null> = { full: null, cursor: null, static: null };
  /** Highest `max_seq` parsed this run (or the seed); what a cursor request asks after. */
  let mark: number | null = null;
  /** Whether a full `200` has been parsed this run — the precondition for cursor mode. */
  let haveFull = false;
  /** Monotonic ms before which T2 skips its origin probe (an origin `Retry-After`). */
  let originHoldUntil: number | null = null;
  let consecutiveFailures = 0;

  const setStatus = (next: FeedStatus): void => {
    if (next === status) return;
    status = next;
    for (const callback of statusCallbacks) callback(next);
  };

  const emit = (message: FeedMessage): void => {
    for (const callback of messageCallbacks) callback(message);
  };

  const emitOutcome = (outcome: PollOutcome): void => {
    for (const callback of outcomeCallbacks) callback(outcome);
  };

  /** Uniform jitter: `ms * (1 + ratio * (2r − 1))`, i.e. within `ms ± ratio·ms`. */
  const jittered = (ms: number): number => ms * (1 + config.pollJitterRatio * (2 * rng.next() - 1));

  /** Downward-only jitter: the safety rule is "at least every N minutes", never later. */
  const safetyDelay = (): number =>
    config.safetySnapshotIntervalMs * (1 - config.pollJitterRatio * rng.next());

  const clearPollTimer = (): void => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const clearSafetyTimer = (): void => {
    if (safetyTimer !== null) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  };

  const schedulePoll = (delayMs: number): void => {
    if (!running) return;
    clearPollTimer();
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void attempt(false);
    }, delayMs);
  };

  const scheduleFreshness = (delayMs: number): void => {
    if (!running) return;
    freshnessTimer = setTimeout(() => {
      void pollFreshness();
    }, delayMs);
  };

  /** Cancel whatever is pending or in flight and fetch a full snapshot right now. */
  const fetchNow = (): void => {
    if (!running) return;
    clearPollTimer();
    fetchGeneration += 1;
    // The superseded response would be dropped anyway; cancelling it also frees the
    // connection it holds, which matters most when it is the one that never answers.
    for (const request of inFlight) request.abort();
    inFlight.clear();
    void attempt(true);
  };

  /** (Re)arm the 10-minute rule; only a full success gets here. */
  const armSafetyTimer = (): void => {
    if (!running) return;
    clearSafetyTimer();
    safetyTimer = setTimeout(() => {
      safetyTimer = null;
      fetchNow();
    }, safetyDelay());
  };

  /** `Retry-After` on 429/503 only: delta-seconds, or an HTTP-date against server time. */
  const retryAfterMs = (response: Response): number | null => {
    if (response.status !== 429 && response.status !== 503) return null;
    const header = response.headers.get('retry-after');
    if (header === null) return null;
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
    const dateMs = Date.parse(trimmed);
    if (Number.isNaN(dateMs)) return null;
    return Math.max(0, dateMs - tracker.serverNow());
  };

  /** T1 backoff: exponential from the poll interval, jittered, capped; a hold may exceed it. */
  const backoffMs = (hold: number | null): number => {
    const exponential = Math.min(
      config.pollIntervalMs * 2 ** (consecutiveFailures - 1),
      BACKOFF_CAP_MS,
    );
    const backoff = Math.min(jittered(exponential), BACKOFF_CAP_MS);
    return hold === null ? backoff : Math.max(backoff, hold);
  };

  const recordAttempt = (ok: boolean): void => {
    if (ok) {
      consecutiveFailures = 0;
      setStatus('live');
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= DEGRADED_AFTER_FAILURES) setStatus('degraded');
  };

  /**
   * A signal for one request: aborted by `stop()` (the run's controller) or by
   * {@link REQUEST_TIMEOUT_MS}, whichever comes first. `release` must run once the request
   * and its body are done with, so neither the timer nor the listener outlives it.
   */
  const requestSignal = (): { controller: AbortController; release: () => void } => {
    const controller = new AbortController();
    const run = abort;
    const onRunAbort = (): void => controller.abort();
    run?.signal.addEventListener('abort', onRunAbort);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return {
      controller,
      release: () => {
        clearTimeout(timer);
        run?.signal.removeEventListener('abort', onRunAbort);
      },
    };
  };

  const fetchSnapshot = async (request: SnapshotRequest): Promise<SnapshotResult> => {
    const headers: Record<string, string> = {};
    const etag = etags[request.slot];
    if (etag !== null) headers['if-none-match'] = etag;
    const { controller, release } = requestSignal();
    inFlight.add(controller);
    try {
      return await exchange(request.url, headers, controller.signal);
    } finally {
      inFlight.delete(controller);
      release();
    }
  };

  /** One snapshot request and its body, classified. Never throws. */
  const exchange = async (
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<SnapshotResult> => {
    const startedAt = clock.monotonicNow();
    let response: Response;
    try {
      // `fetch` may ignore an abort (an injected one can), so the deadline races it too.
      response = await abortable(fetchFn(url, { headers, signal }), signal);
    } catch {
      return { kind: 'unusable', response: null };
    }
    const rttMs = clock.monotonicNow() - startedAt;
    if (response.status === 304) {
      await discardBody(response, signal);
      return { kind: 'not-modified', response, rttMs };
    }
    if (!response.ok) {
      await discardBody(response, signal);
      return { kind: 'unusable', response };
    }
    try {
      const body: unknown = await abortable(response.json(), signal);
      return { kind: 'parsed', response, rttMs, snapshot: parseSnapshot(body) };
    } catch {
      // Unparseable JSON, a ParseError from the guard, or a body that never finished
      // arriving: a malformed snapshot is a failed attempt — garbage never reaches the store.
      return { kind: 'unusable', response };
    }
  };

  /**
   * Apply one classified attempt: server time, ETags, the cursor mark, the safety timer,
   * then the message, then the outcome. Returns the `Retry-After` hold, if any.
   */
  const settle = (request: SnapshotRequest, result: SnapshotResult): number | null => {
    if (result.kind === 'unusable') {
      const hold = result.response === null ? null : retryAfterMs(result.response);
      emitOutcome({
        kind: 'unusable',
        tier: request.tier,
        status: result.response?.status ?? null,
        retryAfterMs: hold,
      });
      return hold;
    }
    // 304s are a polling client's common case and still carry server time (A1.6 says to
    // sample them explicitly).
    tracker.observe(
      { date: result.response.headers.get('date'), age: result.response.headers.get('age') },
      result.rttMs,
    );
    if (result.kind === 'not-modified') {
      const full = request.slot !== 'cursor';
      if (full) {
        // The tag it matched came from a whole set this feed handed over, so the held set
        // is complete and current: proof enough for cursor polls to build on it.
        haveFull = true;
        armSafetyTimer();
      }
      // Only the origin can confirm *freshness*, and that is a narrower claim than
      // completeness above. An origin `304` means the publisher was asked and had nothing
      // newer, so the set is current as of the response `Date`. A static `304` means only
      // that a CDN still holds the object it was handed: the publisher was never
      // consulted, and if the push job died the object freezes while its `Date` keeps
      // advancing with every revalidation. Confirming on that re-anchors the staleness
      // clock on every poll, which makes GLOSSARY §3b's snapshot-age trigger unreachable
      // in the one situation it was written for — contracts/freshness.ts: "a threshold
      // delivered by the pipeline cannot describe that pipeline being down". We are on T2
      // *because* the origin is unreachable, so the freshness report is not arriving
      // either and the age of the static copy is the only honest signal left. Its own
      // `generated_at` is that age, and it already arrived with the body.
      if (request.slot === 'full') {
        const generatedAt = dateHeaderIso(result.response);
        if (generatedAt !== null) emit({ kind: 'snapshot-confirmed', generatedAt });
      }
      emitOutcome({ kind: 'ok', tier: request.tier, full, generatedAt: null });
      return null;
    }
    const { snapshot } = result;
    // The body decides, not the request: a static file answers a cursor query with the
    // whole set, and the whole set is exactly what the full tag and the safety rule want.
    const full = !snapshot.partial;
    const etag = result.response.headers.get('etag');
    if (request.slot === 'static') etags.static = etag;
    else {
      if (request.slot === 'cursor') etags.cursor = etag;
      if (full) etags.full = etag;
    }
    mark = mark === null ? snapshot.maxSeq : Math.max(mark, snapshot.maxSeq);
    if (full) {
      haveFull = true;
      armSafetyTimer();
    }
    emit({ kind: 'snapshot', snapshot });
    emitOutcome({ kind: 'ok', tier: request.tier, full, generatedAt: snapshot.generatedAt });
    return null;
  };

  /** T1: one request to the origin — full when forced or unproven, else a cursor. */
  const pollOrigin = async (forceFull: boolean): Promise<void> => {
    const generation = fetchGeneration;
    const cursor = !forceFull && cadence === 'poll' && haveFull && mark !== null;
    const request: SnapshotRequest = cursor
      ? { url: `${config.snapshotUrl}?${CURSOR_QUERY_PARAM}=${mark}`, tier: 'T1', slot: 'cursor' }
      : { url: config.snapshotUrl, tier: 'T1', slot: 'full' };
    const result = await fetchSnapshot(request);
    if (generation !== fetchGeneration) return;
    const ok = result.kind !== 'unusable';
    recordAttempt(ok);
    const hold = settle(request, result);
    if (!ok) {
      schedulePoll(backoffMs(hold));
      return;
    }
    // Under a live stream the safety timer alone paces the loop.
    if (cadence === 'poll') schedulePoll(jittered(config.pollIntervalMs));
  };

  /** T2: the static copy first (status follows it), then a probe of the origin. */
  const pollStatic = async (staticUrl: string): Promise<void> => {
    const generation = fetchGeneration;
    const staticRequest: SnapshotRequest = { url: staticUrl, tier: 'T2', slot: 'static' };
    const staticResult = await fetchSnapshot(staticRequest);
    if (generation !== fetchGeneration) return;
    recordAttempt(staticResult.kind !== 'unusable');
    const staticHold = settle(staticRequest, staticResult);

    if (originHoldUntil === null || clock.monotonicNow() >= originHoldUntil) {
      originHoldUntil = null;
      const originRequest: SnapshotRequest = { url: config.snapshotUrl, tier: 'T1', slot: 'full' };
      const originResult = await fetchSnapshot(originRequest);
      if (generation !== fetchGeneration) return;
      const originHold = settle(originRequest, originResult);
      if (originHold !== null) originHoldUntil = clock.monotonicNow() + originHold;
    }

    if (cadence !== 'poll' && staticResult.kind !== 'unusable') return;
    const delay = jittered(config.pollIntervalMs);
    schedulePoll(staticHold === null ? delay : Math.max(delay, staticHold));
  };

  const attempt = (forceFull: boolean): Promise<void> => {
    const staticUrl = config.staticSnapshotUrl;
    if (tier === 'T2' && staticUrl !== null) return pollStatic(staticUrl);
    return pollOrigin(forceFull);
  };

  const pollFreshness = async (): Promise<void> => {
    const generation = runGeneration;
    const { controller, release } = requestSignal();
    try {
      const response = await abortable(
        fetchFn(config.freshnessUrl, { signal: controller.signal }),
        controller.signal,
      );
      // Parsed regardless of HTTP status on purpose: the probe answers 500 with a valid
      // critical report, and that report is exactly what the banner needs to show.
      const body: unknown = await abortable(response.json(), controller.signal);
      if (generation !== runGeneration) return;
      const report = parseFreshnessReport(body);
      if (report !== null) emit({ kind: 'freshness', report });
    } catch {
      // Skip silently — the freshness side channel never drives feed status.
    } finally {
      release();
    }
    if (generation !== runGeneration) return;
    scheduleFreshness(config.freshnessPollIntervalMs);
  };

  return {
    start: (cursor) => {
      if (running) return;
      running = true;
      runGeneration += 1;
      fetchGeneration += 1;
      consecutiveFailures = 0;
      cadence = cursor.cadence ?? 'poll';
      mark = cursor.lastSeq;
      haveFull = false;
      originHoldUntil = null;
      if (cursor.lastSeq === null) {
        etags.full = null;
        etags.cursor = null;
        etags.static = null;
      }
      abort = new AbortController();
      setStatus('connecting');
      void attempt(true);
      void pollFreshness();
    },
    stop: () => {
      if (!running) return;
      running = false;
      runGeneration += 1;
      fetchGeneration += 1;
      clearPollTimer();
      clearSafetyTimer();
      if (freshnessTimer !== null) {
        clearTimeout(freshnessTimer);
        freshnessTimer = null;
      }
      abort?.abort();
      abort = null;
      inFlight.clear();
      setStatus('dead');
    },
    refetchNow: fetchNow,
    setTier: (next) => {
      if (next === tier) return;
      tier = next;
      originHoldUntil = null;
      fetchNow();
    },
    onMessage: (callback) => {
      messageCallbacks.add(callback);
    },
    onStatus: (callback) => {
      statusCallbacks.add(callback);
      // Late-subscriber safety: the current status is delivered immediately, so wiring
      // order between the feed and its consumers cannot lose the initial state.
      callback(status);
    },
    onOutcome: (callback) => {
      outcomeCallbacks.add(callback);
    },
    serverNow: tracker.serverNow,
  };
}
