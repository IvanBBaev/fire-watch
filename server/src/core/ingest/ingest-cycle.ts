/**
 * One ingest cycle (TASKS C1, C2).
 *
 * Poll every live FIRMS source, judge what came back, append what survived, and record
 * what happened to each source either way. This is the application service the scheduler
 * calls; it holds no platform of its own — the client, the stores and the clock all arrive
 * as ports, which is what lets a cycle be driven from a fixture as easily as from NASA.
 *
 * The stages, in the order they must run:
 *
 *   poll → validate → judge the batch → append → quarantine → record the batch → freshness
 *
 * Judging *before* the append is what lets the breaker's verdict be written with the rows
 * as a column, rather than applied afterwards by an UPDATE the runtime role does not hold
 * (ADR-002 A1.1). Quarantine after the append, because a quarantine entry is evidence
 * about a batch and the batch is the thing that either landed or did not.
 *
 * Three rules shape everything here:
 *
 *   * A cycle never throws. A source that fails is a *recorded* failure, not an exception
 *     that takes the other two down with it (DATA-SOURCES §A1.1 pitfall 10).
 *   * Freshness follows the archive, not the network. Rows that were fetched and then
 *     failed to land are not data we hold, so a write failure is recorded as a failed
 *     attempt even though the HTTP call succeeded.
 *   * The breaker fails open. It is a safety device over the archive, and a safety device
 *     that cannot read its own history must not stop a season from being captured — so a
 *     failed baseline read degrades to "not enough history" and is recorded as an error.
 */

import type { SourceId } from '@fire-watch/contracts';

import { INGEST_ANOMALY } from '../config/ingest-anomaly.js';
import type { Clock } from '../ports/clock.js';
import type { AppendResult, DetectionStore } from '../ports/detection-store.js';
import type { QuarantineEntry, QuarantineStore } from '../ports/quarantine-store.js';
import { evaluateBatch, type AnomalyDecision } from './anomaly-breaker.js';
import { detectionRecords, pollAttempt } from './detection-records.js';
import {
  describeViolations,
  partitionByValidity,
  type InvalidDetection,
} from './detection-validation.js';
import {
  FIRMS_DAY_RANGE,
  liveFirmsSources,
  pollFirmsSource,
  type FirmsPollRun,
  type IngestedDetection,
  type PollFirmsDeps,
} from './firms-poller.js';

/**
 * The last stage that failed, or `stored` when none did. It is deliberately not a summary
 * of how much data landed — the counts say that, and conflating the two is how a partial
 * write comes to be read as a total one.
 */
export type IngestOutcome =
  'stored' | 'poll_failed' | 'write_failed' | 'quarantine_write_failed' | 'status_write_failed';

export interface SourceIngestResult {
  readonly source: SourceId;
  readonly outcome: IngestOutcome;
  /** `null` when the source never answered. */
  readonly availableAt: number | null;
  /** Detections the poll produced, after within-batch de-duplication. */
  readonly received: number;
  readonly inserted: number;
  readonly alreadyPresent: number;
  /** Rows the CSV parser refused. Quarantined with the bytes that were delivered. */
  readonly rejected: number;
  /** Rows that parsed and then failed E1 validation. They are quarantined, not stored. */
  readonly quarantined: number;
  readonly duplicatesWithinBatch: number;
  /** The breaker's verdict on this batch; `null` when there was no batch to judge. */
  readonly anomaly: AnomalyDecision | null;
  /** Every failure this source hit, joined; `null` when it hit none. */
  readonly error: string | null;
}

export interface IngestCycleReport {
  readonly startedAt: number;
  readonly finishedAt: number;
  /** In the order the sources were polled, which is registry order. */
  readonly sources: readonly SourceIngestResult[];
}

export interface IngestCycleDeps extends PollFirmsDeps {
  readonly store: DetectionStore;
  readonly quarantineStore: QuarantineStore;
  readonly clock: Clock;
  /** Defaults to the registry's active FIRMS sources; a backfill passes its own. */
  readonly sources?: readonly SourceId[];
  /** Defaults to `ingest_anomaly_v1`; a replay pins the version it reproduces. */
  readonly anomalyConfig?: typeof INGEST_ANOMALY;
}

const NOTHING_APPENDED: AppendResult = { received: 0, inserted: 0, alreadyPresent: 0 };

/**
 * Sequential, in registry order, for the same reason `pollFirms` is: the quota is
 * generous relative to a 10–15 minute cadence, and a fixed order means the same cycle
 * produces the same report twice.
 */
export async function runIngestCycle(deps: IngestCycleDeps): Promise<IngestCycleReport> {
  const startedAt = deps.clock.now();
  const sources = deps.sources ?? liveFirmsSources();

  const results: SourceIngestResult[] = [];
  for (const source of sources) {
    results.push(await ingestSource(source, deps));
  }

  return { startedAt, finishedAt: deps.clock.now(), sources: results };
}

async function ingestSource(source: SourceId, deps: IngestCycleDeps): Promise<SourceIngestResult> {
  const run = await pollFirmsSource(source, deps);
  const availableAt = run.availableAt;

  let appended = NOTHING_APPENDED;
  let invalid: readonly InvalidDetection<IngestedDetection>[] = [];
  let anomaly: AnomalyDecision | null = null;
  let writeError: string | null = null;
  let bookkeepingError: string | null = null;

  if (run.outcome === 'ok' && availableAt !== null) {
    const partition = partitionByValidity(run.detections, {
      availableAt,
      ...(deps.bbox === undefined ? {} : { bbox: deps.bbox.values }),
      dayRange: FIRMS_DAY_RANGE,
    });
    invalid = partition.invalid;

    const judged = await judgeBatch(source, run.detections.length, deps);
    anomaly = judged.decision;
    bookkeepingError = judged.error;

    try {
      // Only the rows that survived validation. A row we do not believe is quarantined
      // instead of landing (C2's done-when), while a row in a batch the breaker tripped on
      // lands flagged — the season cannot be re-polled, so a false trip must not delete it.
      const stored: FirmsPollRun = { ...run, detections: partition.valid };
      appended = await deps.store.appendDetections(
        detectionRecords(stored, { quarantined: anomaly.tripped }),
      );
    } catch (error) {
      writeError = describeError(error);
    }

    bookkeepingError = joinErrors([
      bookkeepingError,
      await recordBookkeeping({ source, availableAt, run, invalid, anomaly, appended }, deps),
    ]);
  }

  const attempt = pollAttempt(run, deps.clock.now());
  let statusError: string | null = null;
  try {
    await deps.store.recordPollAttempt(
      writeError === null ? attempt : { ...attempt, succeeded: false, error: writeError },
    );
  } catch (error) {
    // The freshness row is how an outage becomes visible, so failing to write it is worse
    // than failing to poll: it is the one failure nothing downstream can infer.
    statusError = describeError(error);
  }

  return {
    source,
    outcome: outcomeOf(run.outcome === 'failed', writeError, bookkeepingError, statusError),
    availableAt,
    received: run.detections.length,
    inserted: appended.inserted,
    alreadyPresent: appended.alreadyPresent,
    rejected: run.rejections.length,
    quarantined: invalid.length,
    duplicatesWithinBatch: run.duplicatesWithinBatch,
    anomaly,
    error: joinErrors([run.error ?? null, writeError, bookkeepingError, statusError]),
  };
}

/**
 * The breaker's verdict on this batch, and the error that stopped it being an informed
 * one. A baseline that cannot be read degrades to `not_enough_history` rather than to a
 * guess: with no history there is nothing to be anomalous against, which is exactly what
 * that verdict means, and it is the one verdict that never trips.
 */
async function judgeBatch(
  source: SourceId,
  batchSize: number,
  deps: IngestCycleDeps,
): Promise<{ readonly decision: AnomalyDecision; readonly error: string | null }> {
  const config = deps.anomalyConfig ?? INGEST_ANOMALY;
  const evaluate = (trailing: readonly number[]): AnomalyDecision =>
    evaluateBatch(batchSize, trailing, { config });

  try {
    const trailing = await deps.quarantineStore.recentBatchSizes(source, config.values.windowSize);
    return { decision: evaluate(trailing), error: null };
  } catch (error) {
    return { decision: evaluate([]), error: describeError(error) };
  }
}

interface BookkeepingInput {
  readonly source: SourceId;
  readonly availableAt: number;
  readonly run: FirmsPollRun;
  readonly invalid: readonly InvalidDetection<IngestedDetection>[];
  readonly anomaly: AnomalyDecision;
  readonly appended: AppendResult;
}

/**
 * Writes the evidence: what was thrown out and why, then the counts of the batch as a
 * whole. Both writes are attempted even if the first fails, because they answer different
 * questions and losing one is no reason to lose the other.
 */
async function recordBookkeeping(
  input: BookkeepingInput,
  deps: IngestCycleDeps,
): Promise<string | null> {
  const errors: (string | null)[] = [];

  try {
    await deps.quarantineStore.quarantine(quarantineEntries(input));
  } catch (error) {
    errors.push(describeError(error));
  }

  try {
    await deps.quarantineStore.recordBatch({
      source: input.source,
      availableAt: input.availableAt,
      // What the breaker judged, which is what arrived — not what landed. The two differ
      // by the rows that failed validation and by whatever the archive already held.
      received: input.run.detections.length,
      inserted: input.appended.inserted,
      alreadyPresent: input.appended.alreadyPresent,
      rejected: input.run.rejections.length,
      quarantined: input.invalid.length,
      anomalyVerdict: input.anomaly.verdict,
      anomalyTripped: input.anomaly.tripped,
      baseline: input.anomaly.baseline,
      ratio: input.anomaly.ratio,
      ingestConfigVersion: input.anomaly.configVersion,
      pollingBboxVersion: input.run.pollingBboxVersion,
      sourceRegistryVersion: input.run.sourceRegistryVersion,
    });
  } catch (error) {
    errors.push(describeError(error));
  }

  return joinErrors(errors);
}

/**
 * Parser rejections, then validation failures, then at most one batch-scope entry.
 *
 * A line is either refused by the parser or produced as a row — never both — so no two
 * row-scope entries of one batch can address the same line, which is what the uniqueness
 * on `(source, available_at, scope, row_index)` relies on.
 */
function quarantineEntries(input: BookkeepingInput): readonly QuarantineEntry[] {
  const { source, availableAt } = input;
  const entries: QuarantineEntry[] = [
    ...input.run.rejections.map((rejection) => ({
      source,
      availableAt,
      scope: 'row' as const,
      rowIndex: rejection.rowIndex,
      // The parser refused it, so it was never identified; there is no uid to record.
      detectionUid: null,
      reason: rejection.reason,
      raw: rejection.raw,
    })),
    ...input.invalid.map(({ detection, violations }) => ({
      source,
      availableAt,
      scope: 'row' as const,
      rowIndex: detection.rowIndex,
      detectionUid: detection.detectionUid,
      reason: describeViolations(violations),
      raw: detection.raw,
    })),
  ];

  if (input.anomaly.tripped) {
    entries.push({
      source,
      availableAt,
      scope: 'batch',
      rowIndex: null,
      detectionUid: null,
      reason: describeAnomaly(input.anomaly, input.run.detections.length),
      raw: null,
    });
  }

  return entries;
}

/** The verdict as a sentence, for the operator who reads the quarantine before the code. */
function describeAnomaly(anomaly: AnomalyDecision, batchSize: number): string {
  const baseline =
    anomaly.baseline === null ? 'no baseline' : `a baseline of ${String(anomaly.baseline)}`;
  const ratio = anomaly.ratio === null ? '' : ` (${String(anomaly.ratio)}×)`;
  return (
    `${anomaly.verdict}: ${String(batchSize)} rows against ${baseline}${ratio}, ` +
    `under ${anomaly.configVersion}`
  );
}

function outcomeOf(
  pollFailed: boolean,
  writeError: string | null,
  bookkeepingError: string | null,
  statusError: string | null,
): IngestOutcome {
  if (statusError !== null) return 'status_write_failed';
  if (writeError !== null) return 'write_failed';
  // Ordered below the archive's own write on purpose: the rows are safe, and what was
  // lost is the record of how they were judged. It is still not `stored` — a breaker
  // whose history has holes is a breaker nobody can trust the next verdict of.
  if (bookkeepingError !== null) return 'quarantine_write_failed';
  return pollFailed ? 'poll_failed' : 'stored';
}

function joinErrors(errors: readonly (string | null)[]): string | null {
  const present = errors.filter((error): error is string => error !== null);
  return present.length === 0 ? null : present.join('; ');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the cycle as a whole should be treated as a failure by whatever ran it.
 *
 * A single source outage is not one: it is recorded, and the freshness budgets (C5) are
 * what decide when it becomes an alert. What is a failure is a cycle where nothing at all
 * reached the archive, or where the archive's own record of what happened could not be
 * written — the two states in which the data can no longer explain itself.
 */
export function cycleFailed(report: IngestCycleReport): boolean {
  if (report.sources.length === 0) return true;
  if (report.sources.some((result) => result.outcome === 'status_write_failed')) return true;
  return report.sources.every((result) => result.outcome !== 'stored');
}
