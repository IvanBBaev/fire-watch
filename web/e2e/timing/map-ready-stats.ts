/**
 * The arithmetic of the map-ready timing gate, kept pure so it is unit-tested apart from
 * the browser: the median, the calibrated CPU slowdown, and the verdict with its report.
 * The data it is applied to lives in `map-ready-budget.ts`.
 */

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of no values');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? Number.NaN;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1] ?? Number.NaN;
  return (lower + upper) / 2;
}

export type CpuCalibration =
  | { readonly representative: true; readonly rate: number; readonly hostBenchmarkMs: number }
  | { readonly representative: false; readonly hostBenchmarkMs: number; readonly reason: string };

/**
 * The CPU throttle that makes this host, at this moment, run the calibration workload in
 * `targetMs` — the reference device's time. A host already at or beyond the target cannot
 * be slowed down to it (CDP's rate is ≥ 1), so it is not representative: its run would
 * measure a slower device than the budget is written for.
 */
export function calibrateCpu(
  hostBenchmarkMs: number,
  targetMs: number,
  maxRate: number,
): CpuCalibration {
  if (!(hostBenchmarkMs > 0)) {
    return { representative: false, hostBenchmarkMs, reason: 'benchmark did not run' };
  }
  const rate = targetMs / hostBenchmarkMs;
  if (rate < 1) {
    return {
      representative: false,
      hostBenchmarkMs,
      reason: `host ran the workload in ${hostBenchmarkMs.toFixed(1)} ms, slower than the reference device's ${targetMs} ms`,
    };
  }
  return { representative: true, rate: Math.min(rate, maxRate), hostBenchmarkMs };
}

export interface TimingRun {
  readonly mapReadyMs: number;
  readonly cpuRate: number;
  readonly hostBenchmarkMs: number;
  /** Other marks of the same run, for the report only. */
  readonly marks: Readonly<Record<string, number | null>>;
}

export interface TimingVerdict {
  readonly profile: string;
  readonly budgetMs: number;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly pass: boolean;
}

export function verdict(
  profile: string,
  budgetMs: number,
  runs: readonly TimingRun[],
): TimingVerdict {
  const times = runs.map((run) => run.mapReadyMs);
  const medianMs = median(times);
  return {
    profile,
    budgetMs,
    medianMs,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    pass: medianMs <= budgetMs,
  };
}

const ms = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '—';
  return Number.isFinite(value) ? `${Math.round(value)}` : 'never';
};

/** A plain-text table of every run and the verdict, for the log a CI job keeps. */
export function formatReport(
  result: TimingVerdict,
  runs: readonly TimingRun[],
  skipped: readonly string[],
): string {
  const markNames = [...new Set(runs.flatMap((run) => Object.keys(run.marks)))];
  const header = [
    'run',
    'map-ready ms',
    'cpu ×',
    'bench ms',
    ...markNames.map((name) => `${name} ms`),
  ];
  const rows = runs.map((run, index) => [
    `${index + 1}`,
    ms(run.mapReadyMs),
    run.cpuRate.toFixed(2),
    run.hostBenchmarkMs.toFixed(1),
    ...markNames.map((name) => ms(run.marks[name])),
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padStart(widths[column] ?? 0)).join('  ');
  const status = result.pass ? 'PASS' : 'FAIL';
  return [
    `map-ready ${result.profile}: median ${ms(result.medianMs)} ms (min ${ms(result.minMs)}, max ${ms(result.maxMs)}) against ${result.budgetMs} ms — ${status}`,
    line(header),
    ...rows.map(line),
    ...skipped.map((reason) => `  skipped: ${reason}`),
  ].join('\n');
}
