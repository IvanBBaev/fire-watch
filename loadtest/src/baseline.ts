/**
 * The 1× baseline of GATES L-3 (TASKS A3 "define the 50× load baseline"), and the
 * assumptions the gate does not state but a load generator cannot run without.
 *
 * L-3 defines 1× as the busiest in-season hour *measured* in the preceding season,
 * recorded as three numbers: concurrent map sessions, `/snapshot.json` requests/min at the
 * edge, and concurrent SSE connections. Until season 1 has measured it, the planning
 * baseline is 2,000 / 4,000 / 500 — {@link PLANNING_BASELINE}. A measured baseline arrives
 * as a JSON file of the same three numbers ({@link parseBaseline}), so replacing the
 * planning figure after season 1 is a data change, not a code change.
 *
 * {@link TrafficAssumptions} are the numbers the gate leaves open. Every one is named and
 * sourced here so the report can print them next to the verdicts, and every default is a
 * founder decision until confirmed (loadtest/README.md, "Open decisions").
 */

export interface Baseline {
  readonly label: string;
  /** `planning` until season 1 measures the busiest hour; `measured` afterwards. */
  readonly source: 'planning' | 'measured';
  readonly sessions: number;
  /** `/snapshot.json` requests per minute at the edge (T1). */
  readonly snapshotRequestsPerMinute: number;
  readonly sseConnections: number;
}

/** GATES L-3: "the planning baseline is 2,000 sessions / 4,000 req/min / 500 SSE". */
export const PLANNING_BASELINE: Baseline = {
  label: 'GATES L-3 planning baseline (until season 1 measures the busiest hour)',
  source: 'planning',
  sessions: 2_000,
  snapshotRequestsPerMinute: 4_000,
  sseConnections: 500,
};

/** GATES L-3: the test runs at fifty times the baseline. */
export const L3_MULTIPLIER = 50;

/** GATES L-2 / ADR-003 D1: the stream hub's hard admission cap. */
export const SSE_HARD_CAP = 5_000;

export interface TrafficAssumptions {
  /**
   * Mean length of a map session. Every session fetches `/api/v1/client-config` once at
   * boot (web `boot.ts`), so the config request rate is sessions / this. Not in any spec.
   */
  readonly meanSessionMinutes: number;
  /** The web client's default T1 poll interval (web `core/config.ts`, E4 default). */
  readonly pollIntervalMs: number;
  /**
   * The full-snapshot rhythm under cursor polling (ADR-003 D3 / A1.5: at least every
   * 10 min). Between full snapshots a poller sends `?updated_after_seq=<mark>`.
   */
  readonly safetySnapshotIntervalMs: number;
  /**
   * Share of the T1 request rate that lands on T2 once the origin is killed. `1` models
   * every poller flipping to the static copy (ADR-003 A1.2).
   */
  readonly t2ShareAfterOriginKill: number;
  /**
   * The T2 object-age budget the origin-kill phase is judged against: the `snapshot-push`
   * warn budget, 5 min (OPERATIONS §1.3, contracts `SNAPSHOT_PUSH_WARN_SECONDS`), which is
   * also the client's T2 freshness bound (ADR-003 A1.2).
   */
  readonly t2ObjectAgeBudgetSeconds: number;
}

export const DEFAULT_ASSUMPTIONS: TrafficAssumptions = {
  meanSessionMinutes: 10,
  pollIntervalMs: 45_000,
  safetySnapshotIntervalMs: 10 * 60_000,
  t2ShareAfterOriginKill: 1,
  t2ObjectAgeBudgetSeconds: 5 * 60,
};

export class BaselineError extends Error {
  override readonly name = 'BaselineError';
}

/**
 * A measured baseline from a JSON file: `{ "label", "sessions",
 * "snapshotRequestsPerMinute", "sseConnections" }`. Strict — a typo in the file that
 * decides the launch gate's scale must fail loudly, not fall back to the planning figure.
 */
export function parseBaseline(value: unknown): Baseline {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BaselineError('baseline must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  const known = new Set([
    'label',
    'source',
    'sessions',
    'snapshotRequestsPerMinute',
    'sseConnections',
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new BaselineError(`baseline has an unknown field: ${key}`);
  }
  const label = record['label'];
  if (typeof label !== 'string' || label.trim() === '') {
    throw new BaselineError('baseline.label must be a non-empty string');
  }
  const source = record['source'] ?? 'measured';
  if (source !== 'measured' && source !== 'planning') {
    throw new BaselineError('baseline.source must be "measured" or "planning"');
  }
  return {
    label,
    source,
    sessions: positiveNumber(record, 'sessions'),
    snapshotRequestsPerMinute: positiveNumber(record, 'snapshotRequestsPerMinute'),
    sseConnections: nonNegativeNumber(record, 'sseConnections'),
  };
}

function positiveNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BaselineError(`baseline.${key} must be a positive number`);
  }
  return value;
}

function nonNegativeNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BaselineError(`baseline.${key} must be a non-negative number`);
  }
  return value;
}
