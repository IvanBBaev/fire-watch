/**
 * The verdict: given what each feed last did and what it was supposed to do, is the
 * product healthy, degraded, or blind? (OPERATIONS §2.2.)
 *
 * Pure and total. Everything time-dependent arrives as `now`, everything policy-dependent
 * arrives as the budget table, and there is no path that throws on data — only on a
 * *configuration* that cannot be evaluated, which is a boot bug and should be loud.
 *
 * This is deliberately the only place the band mapping exists. The Grafana rules, the
 * status page and the client banner all read the rows this produces rather than
 * re-deriving "late" from timestamps, because four implementations of "late" is four
 * chances to disagree at 3 a.m. about whether anything is actually wrong.
 */

import type {
  FreshnessReport,
  FreshnessRow,
  FreshnessRowId,
  FreshnessState,
  FreshnessStatus,
} from '@fire-watch/contracts';

import {
  FRESHNESS_BUDGETS,
  activeMute,
  budgetFor,
  type FreshnessBudget,
  type FreshnessBudgetTable,
} from '../config/freshness-budgets.js';

/**
 * What one row last did, in epoch milliseconds. For sources this is a `source_status` row;
 * for jobs it will be whatever the job records. The shape is the same because the question
 * is the same.
 */
export interface FreshnessObservation {
  readonly row: FreshnessRowId;
  /** When we last tried, successfully or not. Distinguishes "never ran" from "never worked". */
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  /**
   * When a successful attempt last carried rows. Never scored — a poll that succeeds and
   * returns zero detections is a quiet afternoon, not an outage (§1.1(5)) — but reported,
   * because "the feed is up and has said nothing for nine hours" is worth seeing in August.
   */
  readonly lastDataAt: number | null;
  readonly consecutiveFailures: number;
}

export interface FreshnessQuery {
  readonly now: number;
  /**
   * The rows this deployment claims to be running. Required rather than defaulted to the
   * whole table: a staging box that polls three sources should report three rows, and the
   * set has to come from the same place the scheduler gets its work, so the two cannot
   * drift. Every id must have a budget — one that does not is a config bug, and throws.
   */
  readonly expected: readonly FreshnessRowId[];
  readonly observations: readonly FreshnessObservation[];
  readonly table?: FreshnessBudgetTable;
  /** The version string reported in the body; defaults to the shipped table's. */
  readonly version?: string;
}

export interface FreshnessVerdict {
  readonly report: FreshnessReport;
  /**
   * What the probe should answer with. Deliberately not the same question as
   * `report.status`: a critical weather feed is honestly `critical` in the body and still
   * a 200 on the wire, because §1.2 says weather never 500s. The body describes the
   * system; the status code describes what an external prober should do about it.
   */
  readonly httpStatus: 200 | 500;
}

/** Sort order for the body: offending rows first (§2.2 rule 2). */
const STATE_RANK: Readonly<Record<FreshnessState, number>> = {
  critical: 0,
  warn: 1,
  muted: 2,
  unknown: 3,
  ok: 4,
};

export function evaluateFreshness(query: FreshnessQuery): FreshnessVerdict {
  const table = query.table ?? FRESHNESS_BUDGETS.values;
  const version = query.version ?? FRESHNESS_BUDGETS.version;

  const rows = dedupe(query.expected).map((row) => {
    const budget = budgetFor(row, table);
    if (budget === undefined) {
      throw new RangeError(`freshness was asked about ${row}, which has no budget`);
    }
    return evaluateRow(
      budget,
      query.observations.find((observation) => observation.row === row),
      query.now,
      table,
    );
  });

  const ordered = rows.toSorted((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);

  return {
    report: {
      generatedAt: new Date(query.now).toISOString(),
      status: overallStatus(ordered),
      budgetVersion: version,
      rows: ordered,
    },
    httpStatus: ordered.some((row) => row.state === 'critical' && row.pages) ? 500 : 200,
  };
}

function evaluateRow(
  budget: FreshnessBudget,
  observation: FreshnessObservation | undefined,
  now: number,
  table: FreshnessBudgetTable,
): FreshnessRow {
  const ageSeconds = age(observation, now);
  const base = rawState(observation, ageSeconds, budget);
  const mute =
    base === 'warn' || base === 'critical' ? activeMute(budget.row, now, table) : undefined;

  return {
    row: budget.row,
    lastSuccessAt: iso(observation?.lastSuccessAt ?? null),
    lastDataAt: iso(observation?.lastDataAt ?? null),
    ageSeconds,
    warnSeconds: budget.warnSeconds,
    criticalSeconds: budget.criticalSeconds,
    state: mute === undefined ? base : 'muted',
    consecutiveFailures: observation?.consecutiveFailures ?? 0,
    pages: budget.pages,
    mutedUntil: mute?.untilIso ?? null,
    muteReason: mute?.reason ?? null,
  };
}

/**
 * Seconds since the provider last answered, or `null` when it never has.
 *
 * A `lastSuccessAt` in the future is clamped to zero rather than reported as a negative
 * age. That is a clock problem, and clock offset has its own metric (§3) — letting it leak
 * in here would only produce a nonsense number on a page about something else.
 */
function age(observation: FreshnessObservation | undefined, now: number): number | null {
  const lastSuccessAt = observation?.lastSuccessAt ?? null;
  if (lastSuccessAt === null) return null;
  return Math.max(0, Math.floor((now - lastSuccessAt) / 1000));
}

function rawState(
  observation: FreshnessObservation | undefined,
  ageSeconds: number | null,
  budget: FreshnessBudget,
): FreshnessState {
  if (ageSeconds === null) {
    // Never succeeded. Which of the two ways that happens matters:
    //
    // Never even *attempted* is `unknown` — a fresh database on a box whose worker has not
    // finished its first cycle. Scoring it critical would 500 the smoke test of a first
    // deploy and roll back a perfectly good release (§2.2 rule 8), and the failure mode it
    // would supposedly catch — the worker never starting at all — is exactly what the
    // heartbeat leg exists for, off-box and independent of this endpoint (§3).
    //
    // Attempted and never once succeeded is `critical`. There is no age to compare, but
    // there is no ambiguity either: we have been asking and getting nothing.
    return observation === undefined || observation.lastAttemptAt === null ? 'unknown' : 'critical';
  }
  if (ageSeconds >= budget.criticalSeconds) return 'critical';
  if (ageSeconds >= budget.warnSeconds) return 'warn';
  return 'ok';
}

/**
 * `unknown` and `muted` both count as `warn`, never as `ok`. A muted row is a known outage
 * that is not being acted on and must stay visible on the status page (§1.1(6)); an
 * unknown row is a feed nobody has heard from since boot. Neither is health.
 */
function overallStatus(rows: readonly FreshnessRow[]): FreshnessStatus {
  if (rows.some((row) => row.state === 'critical')) return 'critical';
  if (rows.some((row) => row.state !== 'ok')) return 'warn';
  return 'ok';
}

function dedupe(rows: readonly FreshnessRowId[]): readonly FreshnessRowId[] {
  return [...new Set(rows)];
}

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}
