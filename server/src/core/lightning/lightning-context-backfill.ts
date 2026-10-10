/**
 * The F18 archive backfill (TASKS F18; DATA-SOURCES §F18): answer the lightning context
 * for events whose window left the nine-hour document before it was answered — an outage,
 * no credentials yet, an event first seen long after it started, or an event that moved
 * after its window aged out ({@link recomputeReason}).
 *
 * For each such event it searches the Data Store for the LFL products of the event's
 * window, reuses the records already on disk, downloads and decodes (sandboxed) the rest,
 * and evaluates the window over a document built from exactly those products. It writes
 * **only `complete` rows**: a window with a missing product, a failed download, a refused
 * decode or an exhausted budget is reported with the spans it could not cover and keeps
 * whatever row it had. It never writes a number the products did not give.
 *
 * ## Bounds and idempotence
 *
 * * At most `maxEvents` events per run (newest first detection first) and at most
 *   `maxProducts` downloads in total. Products past the budget are `not_attempted`.
 * * A product is downloaded once: its record (or its refused sidecar) on disk is the done
 *   mark, shared with the live refresh, so a second run reuses what the first fetched.
 * * An event with a `complete` row that still holds is never listed again.
 * * A 401/403 stops the run's remaining downloads, as in the refresh.
 *
 * Records written here land in the same per-product paths the refresh uses; the refresh
 * only ever reads the ones inside its own retention, so archive windows never enter the
 * live document.
 */

import {
  LIGHTNING_CONTEXT,
  LIGHTNING_CONTEXT_DRIFT,
  type LightningContextDrift,
  type LightningContextValues,
} from '../config/lightning-context.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../ports/clock.js';
import type {
  LightningContextCandidate,
  LightningContextRow,
  LightningContextStore,
} from '../ports/lightning-context-store.js';
import type { LightningProduct } from '../ports/lightning-client.js';
import {
  coverage,
  evaluateLightningContext,
  recomputeReason,
  type LightningContextReason,
} from './lightning-context.js';
import {
  LIGHTNING_DOCUMENT_RETENTION_MS,
  emptyDocument,
  mergeRecords,
  type LightningRecord,
} from './lightning-document.js';
import { parseInterval } from './lightning-payload.js';
import {
  dedupe,
  fetchOne,
  latestPerWindow,
  readExisting,
  type LightningProductDeps,
  type LightningProductOutcome,
} from './lightning-refresh.js';

const HOUR_MS = 3_600_000;
const PRODUCT_MS = 10 * 60_000;

export interface LightningBackfillDeps extends LightningProductDeps {
  readonly store: LightningContextStore;
  readonly clock: Clock;
}

export interface LightningBackfillLimits {
  /** Events looked at in one run. */
  readonly maxEvents: number;
  /** Product downloads in one run, across all events. */
  readonly maxProducts: number;
}

/** Why the backfill looks at an event: the loop's reasons, or a row that said "no data". */
export type LightningBackfillReason = LightningContextReason | 'unavailable';

/**
 * Whether an event is the backfill's to answer, and why: whatever the loop would
 * recompute, plus an `unavailable` row (the loop's last word, never the archive's).
 */
export function backfillReason(
  event: LightningContextCandidate,
  paramsVersion: string,
  drift: LightningContextDrift = LIGHTNING_CONTEXT_DRIFT,
): LightningBackfillReason | null {
  const reason = recomputeReason(event, paramsVersion, drift);
  if (reason !== null) return reason;
  return event.previous?.status === 'unavailable' ? 'unavailable' : null;
}

/**
 * Events first detected before this instant have a window the live document can no longer
 * hold whole; younger ones are the loop's.
 */
export function backfillCutoff(
  now: EpochMs,
  config: VersionedConfig<LightningContextValues> = LIGHTNING_CONTEXT,
): EpochMs {
  return now - LIGHTNING_DOCUMENT_RETENTION_MS + config.values.windowHours * HOUR_MS;
}

/**
 * - `complete`: the window was covered; the row was written.
 * - `not_covered`: the archive lists no product for the window.
 * - `partial`: some of the window is covered, some is not (a product missing from the
 *   archive or refused by the decoder) — nothing written.
 * - `failed`: a product's download, decode or record write failed — nothing written; a
 *   later run retries it.
 * - `budget_exhausted`: products were left for a later run (budget or an auth refusal).
 * - `search_failed`: the Data Store search did not answer.
 */
export type LightningBackfillOutcome =
  'complete' | 'not_covered' | 'partial' | 'failed' | 'budget_exhausted' | 'search_failed';

export interface LightningBackfillEvent {
  readonly eventId: string;
  readonly reason: LightningBackfillReason;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly outcome: LightningBackfillOutcome;
  /** Distinct windows the search listed for the event. */
  readonly found: number;
  /** Products whose record was already on disk (or known refused). */
  readonly reused: number;
  readonly downloaded: number;
  readonly notAttempted: number;
  /** Parts of the window no product covers, ISO intervals; empty when `complete`. */
  readonly missing: readonly string[];
  /** Non-null exactly when `complete`. */
  readonly flashCount: number | null;
  readonly nearestKm: number | null;
  /** Download, decode or search failures, at most a few. */
  readonly errors: readonly string[];
}

export interface LightningBackfillReport {
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs;
  readonly firstDetectedBefore: EpochMs;
  /** Events the store listed; at most `maxEvents`. */
  readonly listed: number;
  readonly downloads: number;
  /** Why downloads stopped early, if they did. */
  readonly stopped: string | null;
  readonly events: readonly LightningBackfillEvent[];
  /** A store failure; `null` when the run went through. */
  readonly error: string | null;
}

type Windowed = {
  readonly product: LightningProduct;
  readonly window: { readonly start: EpochMs; readonly end: EpochMs };
};

const MAX_ERRORS_PER_EVENT = 5;

/** One run. Throws only on nonsensical limits; every other failure is in the report. */
export async function runLightningContextBackfill(
  deps: LightningBackfillDeps,
  limits: LightningBackfillLimits,
  config: VersionedConfig<LightningContextValues> = LIGHTNING_CONTEXT,
  drift: LightningContextDrift = LIGHTNING_CONTEXT_DRIFT,
): Promise<LightningBackfillReport> {
  checkLimit(limits.maxEvents, 'maxEvents');
  checkLimit(limits.maxProducts, 'maxProducts', 0);
  const startedAt = deps.clock.now();
  const firstDetectedBefore = backfillCutoff(startedAt, config);
  const budget = { downloads: 0, stopped: null as string | null };
  const events: LightningBackfillEvent[] = [];
  const finish = (listed: number, error: string | null): LightningBackfillReport => ({
    startedAt,
    finishedAt: deps.clock.now(),
    firstDetectedBefore,
    listed,
    downloads: budget.downloads,
    stopped: budget.stopped,
    events,
    error,
  });

  let listed: readonly LightningContextCandidate[];
  try {
    listed = await deps.store.incompleteEvents(
      config.version,
      firstDetectedBefore,
      limits.maxEvents,
      drift,
    );
  } catch (error: unknown) {
    return finish(0, `store: ${describe(error)}`);
  }

  for (const event of listed) {
    const reason = backfillReason(event, config.version, drift);
    if (reason === null) continue;
    const answer = await backfillOne(deps, event, reason, limits, budget, config);
    if (answer.row !== null) {
      try {
        await deps.store.save([{ ...answer.row, computedAt: deps.clock.now() }]);
      } catch (error: unknown) {
        events.push({ ...answer.event, outcome: 'failed', flashCount: null, nearestKm: null });
        return finish(listed.length, `store: ${describe(error)}`);
      }
    }
    events.push(answer.event);
  }
  return finish(listed.length, null);
}

async function backfillOne(
  deps: LightningBackfillDeps,
  event: LightningContextCandidate,
  reason: LightningBackfillReason,
  limits: LightningBackfillLimits,
  budget: { downloads: number; stopped: string | null },
  config: VersionedConfig<LightningContextValues>,
): Promise<{
  readonly event: LightningBackfillEvent;
  readonly row: LightningContextRow | null;
}> {
  const windowTo = event.firstDetectedAt;
  const windowFrom = windowTo - config.values.windowHours * HOUR_MS;
  const base = {
    eventId: event.eventId,
    reason,
    windowFrom: isoFromEpochMs(windowFrom),
    windowTo: isoFromEpochMs(windowTo),
  };
  const errors: string[] = [];
  const note = (message: string): void => {
    if (errors.length < MAX_ERRORS_PER_EVENT) errors.push(message);
  };

  // Search a product's length either side, for the products straddling the edges.
  const search = await deps.client
    .search({
      startIso: isoFromEpochMs(windowFrom - PRODUCT_MS),
      endIso: isoFromEpochMs(windowTo + PRODUCT_MS),
    })
    .catch((error: unknown) => ({ ok: false as const, status: null, error: describe(error) }));
  if (!search.ok) {
    const status = search.status === null ? '' : `HTTP ${String(search.status)}: `;
    note(`search: ${status}${search.error}`);
    return {
      event: {
        ...base,
        outcome: 'search_failed',
        found: 0,
        reused: 0,
        downloaded: 0,
        notAttempted: 0,
        missing: [`${base.windowFrom}/${base.windowTo}`],
        flashCount: null,
        nearestKm: null,
        errors,
      },
      row: null,
    };
  }

  const candidates = latestPerWindow(
    dedupe(search.products)
      .map((product) => ({
        product,
        window: parseInterval(`${product.window.startIso}/${product.window.endIso}`),
      }))
      .filter(
        (c): c is Windowed =>
          c.window !== null && c.window.end > windowFrom && c.window.start < windowTo,
      ),
  ).sort((a, b) => a.window.end - b.window.end || a.product.id.localeCompare(b.product.id));

  const records: LightningRecord[] = [];
  let reused = 0;
  let downloaded = 0;
  let notAttempted = 0;
  let failed = 0;
  for (const { product, window } of candidates) {
    const existing = await readExisting(deps, window.end, product.id);
    if (existing === 'refused') {
      reused += 1;
      note(`${product.id}: refused by the decoder`);
      continue;
    }
    if (existing !== null) {
      reused += 1;
      records.push(existing);
      continue;
    }
    if (budget.stopped !== null || budget.downloads >= limits.maxProducts) {
      notAttempted += 1;
      continue;
    }
    budget.downloads += 1;
    downloaded += 1;
    const fetched = await fetchOne(deps, product, window);
    if (fetched.record !== null) records.push(fetched.record);
    const outcome: LightningProductOutcome = fetched.result.outcome;
    if (outcome === 'refused') note(`${product.id}: refused by the decoder`);
    else if (outcome !== 'recorded') {
      failed += 1;
      note(`${product.id}: ${fetched.result.error ?? outcome}`);
    }
    if (fetched.authFailed) budget.stopped = 'stopped after an authentication refusal';
  }

  // A document of exactly these products, generated just after the window so nothing in
  // it is trimmed by the live document's retention.
  const generatedAt = windowTo + PRODUCT_MS;
  const document = mergeRecords(emptyDocument(generatedAt), records, generatedAt);
  const evaluated = evaluateLightningContext(event, document, generatedAt, config);
  const row = evaluated?.status === 'complete' ? evaluated : null;
  const missing =
    row === null
      ? uncovered(windowFrom, windowTo, coverage(document, config.values.maxGapSeconds * 1000))
      : [];
  const outcome: LightningBackfillOutcome =
    row !== null
      ? 'complete'
      : failed > 0
        ? 'failed'
        : notAttempted > 0
          ? 'budget_exhausted'
          : candidates.length === 0
            ? 'not_covered'
            : 'partial';
  return {
    event: {
      ...base,
      outcome,
      found: candidates.length,
      reused,
      downloaded,
      notAttempted,
      missing,
      flashCount: row?.flashCount ?? null,
      nearestKm: row?.nearestKm ?? null,
      errors,
    },
    row,
  };
}

/** The parts of `[from, to]` no span covers, as ISO intervals. */
function uncovered(
  from: EpochMs,
  to: EpochMs,
  spans: readonly { readonly from: EpochMs; readonly to: EpochMs }[],
): string[] {
  const gaps: string[] = [];
  let cursor = from;
  for (const span of spans) {
    if (span.to <= cursor) continue;
    if (span.from >= to) break;
    if (span.from > cursor) gaps.push(`${isoFromEpochMs(cursor)}/${isoFromEpochMs(span.from)}`);
    cursor = Math.max(cursor, span.to);
  }
  if (cursor < to) gaps.push(`${isoFromEpochMs(cursor)}/${isoFromEpochMs(to)}`);
  return gaps;
}

function checkLimit(value: number, name: string, min = 1): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a safe integer >= ${String(min)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
