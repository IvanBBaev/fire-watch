/**
 * Is the provider still publishing? (TASKS C1, DATA-SOURCES §A1.1 pitfall 10.)
 *
 * A poll that succeeds and returns nothing is indistinguishable from a poll of a source
 * that has stopped producing: both are HTTP 200 with a header row. The freshness budgets
 * (C5) cannot tell them apart either — they score `last_success_at`, and an empty CSV is a
 * success. So on a quiet upstream the map freezes, no alert fires, and every health signal
 * stays green, which is exactly the failure the pitfall names.
 *
 * FIRMS publishes the answer: `/api/data_availability/csv/<MAP_KEY>/<SOURCE>` reports the
 * date range each product currently covers. If its `max_date` is current, silence means no
 * fires. If `max_date` has not moved for hours, silence means no data. This module turns
 * that response into that verdict.
 *
 * Pure and total. `evaluate` never throws — an unparseable or unexpected availability body
 * is `unknown`, never an exception, because a cycle that dies here would lose the
 * detections it had already fetched over a *diagnostic* it was only consulting.
 *
 * Resolution is one day, not one hour: `max_date` is a UTC calendar date. So the age is
 * measured from the *end* of that day — the first instant at which the provider can be
 * said to owe us something newer — which makes "stale > 6 h" mean "it is past 06:00 UTC
 * and the provider has published nothing for today".
 */

import type { EpochMs } from '../ports/clock.js';
import { parseCsvLine } from './firms-csv.js';

/**
 * The staleness threshold from the pitfall table. Not a freshness *budget* — those live in
 * `freshness-budgets.ts`, are per-row, and own the paging leg. This one number decides only
 * whether a cycle reports the upstream as stale.
 */
export const AVAILABILITY_STALE_MS = 6 * 3_600_000;

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD`, the only shape FIRMS publishes in this response. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DATA_ID_COLUMN = 'data_id';
const MAX_DATE_COLUMN = 'max_date';
const MIN_DATE_COLUMN = 'min_date';

export interface FirmsAvailabilityRow {
  /** The product name as the provider spells it, e.g. `VIIRS_NOAA20_NRT`. */
  readonly dataId: string;
  /** `YYYY-MM-DD`, or `null` when the provider left the cell empty. */
  readonly minDate: string | null;
  readonly maxDate: string | null;
}

export type UpstreamState = 'fresh' | 'stale' | 'unknown';

export interface UpstreamAvailability {
  /** The product the verdict is about — the registry's `queriedProduct`. */
  readonly product: string;
  readonly state: UpstreamState;
  /** What the provider says it has published up to; `null` when we could not tell. */
  readonly maxDate: string | null;
  /**
   * Seconds since the end of `max_date`'s UTC day, floored at zero. `null` when the state
   * is `unknown`. Reported even when `fresh`, because a number trending upward is visible
   * on a dashboard hours before it crosses a threshold.
   */
  readonly ageSeconds: number | null;
  /** Why it is `stale` or `unknown`; `null` when it is `fresh`. Written for an operator. */
  readonly reason: string | null;
}

export class FirmsAvailabilityFormatError extends Error {
  override readonly name = 'FirmsAvailabilityFormatError';
}

/**
 * The rows of a data-availability response.
 *
 * Whole-file problems throw: a body without a `data_id`/`max_date` header is not a sparse
 * answer, it is a different document — an HTML error page, or a changed API — and reading
 * "no rows" out of it would report every source as absent rather than as unverifiable.
 * Individual rows are skipped rather than fatal, because one unreadable line about a
 * product we do not poll must not blind us to the three we do.
 */
export function parseAvailabilityCsv(text: string): readonly FirmsAvailabilityRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = lines[0];
  if (header === undefined) {
    throw new FirmsAvailabilityFormatError('data availability response is empty');
  }

  const columns = parseCsvLine(header).map((column) => column.trim().toLowerCase());
  const dataIdAt = columns.indexOf(DATA_ID_COLUMN);
  const maxDateAt = columns.indexOf(MAX_DATE_COLUMN);
  const minDateAt = columns.indexOf(MIN_DATE_COLUMN);
  if (dataIdAt === -1 || maxDateAt === -1) {
    throw new FirmsAvailabilityFormatError(
      `data availability response has no ${DATA_ID_COLUMN}/${MAX_DATE_COLUMN} columns; ` +
        `got [${columns.join(', ')}]`,
    );
  }

  const rows: FirmsAvailabilityRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const dataId = cells[dataIdAt]?.trim() ?? '';
    if (dataId === '') continue;
    rows.push({
      dataId,
      minDate: cell(cells, minDateAt),
      maxDate: cell(cells, maxDateAt),
    });
  }
  return rows;
}

export interface AvailabilityQuery {
  /** The registry's `queriedProduct`; matched against `data_id` case-insensitively. */
  readonly product: string;
  /** The body as delivered. */
  readonly csv: string;
  readonly now: EpochMs;
  /** Defaults to {@link AVAILABILITY_STALE_MS}. */
  readonly staleAfterMs?: number;
}

/**
 * The verdict for one product. Never throws — see the module note.
 *
 * `unknown` is deliberately not `stale`: an availability endpoint that is itself down, or
 * that has changed its schema, says nothing about whether fires are being published, and
 * paging on it would train an operator to ignore this signal in the one week it matters.
 */
export function evaluateUpstreamAvailability(query: AvailabilityQuery): UpstreamAvailability {
  const staleAfterMs = query.staleAfterMs ?? AVAILABILITY_STALE_MS;

  let rows: readonly FirmsAvailabilityRow[];
  try {
    rows = parseAvailabilityCsv(query.csv);
  } catch (error) {
    return unknown(query.product, error instanceof Error ? error.message : String(error));
  }

  const wanted = query.product.toLowerCase();
  const row = rows.find((candidate) => candidate.dataId.toLowerCase() === wanted);
  if (row === undefined) {
    return unknown(
      query.product,
      `data availability lists no ${query.product}; it reports [${rows
        .map((candidate) => candidate.dataId)
        .join(', ')}]`,
    );
  }
  if (row.maxDate === null) {
    return unknown(query.product, `data availability reports no ${MAX_DATE_COLUMN}`);
  }

  const dayEnd = utcDayEnd(row.maxDate);
  if (dayEnd === null) {
    return unknown(query.product, `data availability reports ${MAX_DATE_COLUMN}=${row.maxDate}`);
  }
  if (!Number.isFinite(query.now)) {
    return unknown(query.product, `now must be a finite instant, got ${String(query.now)}`);
  }

  // Floored at zero: `max_date` is today for most of the day, which puts the end of its
  // day in the future. That is the healthy case, not a negative age.
  const ageMs = Math.max(0, query.now - dayEnd);
  const ageSeconds = Math.floor(ageMs / 1000);
  if (ageMs > staleAfterMs) {
    return {
      product: query.product,
      state: 'stale',
      maxDate: row.maxDate,
      ageSeconds,
      reason:
        `${query.product} has published nothing since ${row.maxDate}; the provider is ` +
        `${String(Math.floor(ageMs / 3_600_000))} h past the end of that UTC day, over the ` +
        `${String(Math.floor(staleAfterMs / 3_600_000))} h staleness threshold`,
    };
  }

  return {
    product: query.product,
    state: 'fresh',
    maxDate: row.maxDate,
    ageSeconds,
    reason: null,
  };
}

/**
 * The first instant strictly after the given UTC calendar day, or `null` when the value is
 * not a date. Computed from `Date.UTC` rather than from a parsed `Date`, so nothing here
 * depends on the zone CI happens to run in.
 */
function utcDayEnd(date: string): EpochMs | null {
  const match = DATE_RE.exec(date);
  if (match === null) return null;
  const [, year, month, day] = match;
  const start = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (!Number.isFinite(start)) return null;
  // Round-trips only for a real calendar date: `2026-02-31` becomes 3 March and is refused.
  if (new Date(start).toISOString().slice(0, 10) !== date) return null;
  return start + MS_PER_DAY;
}

function cell(cells: readonly string[], at: number): string | null {
  if (at === -1) return null;
  const value = cells[at]?.trim() ?? '';
  return value === '' ? null : value;
}

function unknown(product: string, reason: string): UpstreamAvailability {
  return { product, state: 'unknown', maxDate: null, ageSeconds: null, reason };
}
