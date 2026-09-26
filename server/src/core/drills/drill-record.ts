/**
 * The drill record: what a drill did, how long each step took, what it checked, and the
 * verdict (TASKS I7, J2; OPERATIONS §6.3 rule 3; GATES L-17).
 *
 * A drill is a sequence of **steps** (timed; automated by the CLI or performed by hand and
 * reported with `--manual-step`) and a set of **checks** (pass / fail / not run). The
 * record is data; `render-record.ts` turns it into the Markdown file that is committed
 * under `docs/drills/records/`.
 *
 * The verdict is deliberately three-valued. A drill that skipped a leg is not a pass: it
 * is `incomplete`, and says which leg — the same honesty rule as the freshness banner.
 *
 * Pure: time arrives through the `Clock` port.
 */

import { isoFromEpochMs, type Clock, type EpochMs } from '../ports/clock.js';

export type RtoStatus = 'met' | 'exceeded' | 'incomplete' | 'failed';

export interface RtoEvaluation {
  readonly status: RtoStatus;
  /** Sum of the RTO-path steps that were performed. A lower bound when `incomplete`. */
  readonly measuredMinutes: number;
  readonly targetMinMinutes: number;
  readonly targetMaxMinutes: number;
  /** RTO-path steps not performed (or skipped): the measurement's blind spots. */
  readonly missing: readonly string[];
  /** RTO-path steps that failed: the recovery itself did not succeed. */
  readonly failed: readonly string[];
  readonly spec: string;
}

export type DrillKind = 'erasure' | 'restore';

export type StepMode = 'automated' | 'manual';

/** `not_performed`: a step of the procedure nobody ran (or reported) in this drill. */
export type StepStatus = 'passed' | 'failed' | 'skipped' | 'not_performed';

export interface DrillStepDefinition {
  readonly id: string;
  readonly title: string;
  readonly mode: StepMode;
  /** Whether the step's time counts toward the recovery time (restore drill only). */
  readonly onRtoPath: boolean;
}

export interface DrillStep extends DrillStepDefinition {
  readonly status: StepStatus;
  /** Null for a manual step (reported as a duration only) or one never started. */
  readonly startedAt: string | null;
  readonly durationMs: number | null;
  readonly detail: string;
}

export type CheckStatus = 'pass' | 'fail' | 'not_run';

export interface DrillCheck {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Where the requirement is written down. */
  readonly spec: string;
}

export type DrillVerdict = 'passed' | 'failed' | 'incomplete';

export interface DrillRecord {
  readonly kind: DrillKind;
  /** The operator's label for where the drill ran (`staging`, `local`, …). */
  readonly environment: string;
  /** What the drill touched, credential-free (database host/name, store, bucket). */
  readonly target: Readonly<Record<string, string>>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly steps: readonly DrillStep[];
  readonly checks: readonly DrillCheck[];
  /** Restore drills only. */
  readonly rto: RtoEvaluation | null;
  /** Named values worth keeping: artifact key, migration version, account hash prefix. */
  readonly facts: Readonly<Record<string, string>>;
  /** Anything that went wrong or looked wrong; a thrown error lands here too. */
  readonly findings: readonly string[];
  /** Known gaps the drill cannot close by itself, restated so the record is self-contained. */
  readonly openItems: readonly string[];
}

export function drillVerdict(record: {
  readonly steps: readonly DrillStep[];
  readonly checks: readonly DrillCheck[];
  readonly rto: RtoEvaluation | null;
}): DrillVerdict {
  if (record.steps.some((step) => step.status === 'failed')) return 'failed';
  if (record.checks.some((check) => check.status === 'fail')) return 'failed';
  if (record.rto !== null && (record.rto.status === 'exceeded' || record.rto.status === 'failed')) {
    return 'failed';
  }
  if (record.checks.length === 0) return 'incomplete';
  if (record.checks.some((check) => check.status === 'not_run')) return 'incomplete';
  if (record.rto !== null && record.rto.status === 'incomplete') return 'incomplete';
  return 'passed';
}

export function check(
  id: string,
  title: string,
  status: CheckStatus,
  detail: string,
  spec: string,
): DrillCheck {
  return { id, title, status, detail, spec };
}

/**
 * Times the steps of one drill. `run` records a thrown step as `failed` and rethrows, so
 * the caller stops the drill but still has every step up to the failure for the record.
 */
export interface StepRecorder {
  run<T>(
    definition: DrillStepDefinition,
    work: () => Promise<T>,
    describe?: (result: T) => string,
  ): Promise<T>;
  /** A step the drill decided not to perform (`--restore-only`, no store configured, …). */
  skip(definition: DrillStepDefinition, reason: string): void;
  /** A manual step, reported as minutes by the operator, or null when not reported. */
  manual(definition: DrillStepDefinition, minutes: number | null): void;
  steps(): readonly DrillStep[];
}

export function createStepRecorder(clock: Clock): StepRecorder {
  const steps: DrillStep[] = [];
  return {
    async run<T>(
      definition: DrillStepDefinition,
      work: () => Promise<T>,
      describe?: (result: T) => string,
    ): Promise<T> {
      const started: EpochMs = clock.now();
      try {
        const result = await work();
        steps.push({
          ...definition,
          status: 'passed',
          startedAt: isoFromEpochMs(started),
          durationMs: clock.now() - started,
          detail: describe === undefined ? '' : describe(result),
        });
        return result;
      } catch (error) {
        steps.push({
          ...definition,
          status: 'failed',
          startedAt: isoFromEpochMs(started),
          durationMs: clock.now() - started,
          detail: messageOf(error),
        });
        throw error;
      }
    },
    skip(definition, reason) {
      steps.push({
        ...definition,
        status: 'skipped',
        startedAt: null,
        durationMs: null,
        detail: reason,
      });
    },
    manual(definition, minutes) {
      steps.push(
        minutes === null
          ? {
              ...definition,
              status: 'not_performed',
              startedAt: null,
              durationMs: null,
              detail: 'not reported (--manual-step)',
            }
          : {
              ...definition,
              status: 'passed',
              startedAt: null,
              durationMs: Math.round(minutes * 60_000),
              detail: 'reported by the operator',
            },
      );
    },
    steps: () => [...steps],
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
