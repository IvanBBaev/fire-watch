/**
 * The scenario model: A3's 1× baseline → the 50× request mix the generator drives.
 *
 * Pure and deterministic. It answers two questions and nothing else:
 *
 *   1. *How much?* — per-stream target rates and the SSE concurrency target
 *      ({@link buildScenario}).
 *   2. *When?* — how many arrivals a stream owes by a given instant of a phase
 *      ({@link cumulativeArrivals}) and how many streams should be open
 *      ({@link desiredSseConnections}).
 *
 * The generator is an **open model**: arrivals are owed at a rate, whether or not earlier
 * requests have answered. A closed model (N virtual users, each waiting for its answer)
 * slows down exactly when the system under test does, which hides the saturation the test
 * exists to find ("coordinated omission"). 100,000 map sessions polling every 45 s are an
 * arrival process, not 100,000 loops — so rates, not virtual users, are the unit here.
 *
 * Streams in the mix (TASKS E1/E3/E4, ADR-003 D1):
 *
 *   * `snapshot` — T1 `/snapshot.json`, the L-3 req/min figure. A share carries the cursor
 *     `?updated_after_seq=<mark>` (D3/A1.5 cursor polling between safety snapshots) and a
 *     share revalidates with `If-None-Match` (every poller after its first answer).
 *   * `clientConfig` — `/api/v1/client-config`, once per session start (E4).
 *   * `t2` — the static R2 copy (E3), only after the origin is killed.
 *   * SSE — `/api/v1/stream` (E2), a concurrency target rather than a rate; above the hub's
 *     cap the origin must refuse, demote the fleet to T1 and close every stream cleanly.
 *
 * Phases: `ramp` (linear rise to the targets), `steady` (hold — the window every L-3
 * number is judged on), `origin-kill` (T1 off, T2 on: the fallback leg of L-3).
 */

import {
  DEFAULT_ASSUMPTIONS,
  L3_MULTIPLIER,
  PLANNING_BASELINE,
  SSE_HARD_CAP,
  type Baseline,
  type TrafficAssumptions,
} from './baseline.js';

export const SCENARIO_SCHEMA = 'fire-watch.loadtest.scenario/v1';

export const PHASES = ['ramp', 'steady', 'origin-kill'] as const;
export type PhaseName = (typeof PHASES)[number];

export const REQUEST_STREAMS = ['snapshot', 'clientConfig', 't2'] as const;
export type RequestStream = (typeof REQUEST_STREAMS)[number];

/** How a stream's rate behaves inside a phase. */
export type RateShape = 'ramp' | 'full' | 'off';

/**
 * Which stream runs in which phase — data, so a reader sees the whole traffic plan in one
 * table. Once the origin is dead, T1 and the config document are gone with it and every
 * poller is on T2 (A1.2); streams die with the origin.
 */
export const RATE_PROFILE: Readonly<
  Record<RequestStream | 'sse', Readonly<Record<PhaseName, RateShape>>>
> = {
  snapshot: { ramp: 'ramp', steady: 'full', 'origin-kill': 'off' },
  clientConfig: { ramp: 'ramp', steady: 'full', 'origin-kill': 'off' },
  t2: { ramp: 'off', steady: 'off', 'origin-kill': 'full' },
  sse: { ramp: 'ramp', steady: 'full', 'origin-kill': 'off' },
};

export interface Phase {
  readonly name: PhaseName;
  readonly durationMs: number;
}

export interface ScenarioInput {
  readonly baseline?: Baseline;
  readonly assumptions?: TrafficAssumptions;
  /** L-3 says 50; anything else is a rehearsal and the report says so. */
  readonly multiplier?: number;
  /**
   * Scales every rate and the SSE target, never the cap or the thresholds. `1` is the
   * gate; the in-process smoke runs at a few thousandths.
   */
  readonly scale?: number;
  /** The origin hub's admission cap. The gate's figure is 5,000 (L-2/L-3). */
  readonly sseCap?: number;
  readonly shard?: { readonly index: number; readonly count: number };
  readonly durationsMs?: {
    readonly ramp: number;
    readonly steady: number;
    readonly originKill: number;
  };
}

export interface Scenario {
  readonly schema: typeof SCENARIO_SCHEMA;
  readonly baseline: Baseline;
  readonly assumptions: TrafficAssumptions;
  readonly multiplier: number;
  readonly scale: number;
  readonly shard: { readonly index: number; readonly count: number };
  /** Whole-test figures, before sharding — what the report compares against the gate. */
  readonly totals: {
    readonly sessions: number;
    readonly snapshotRequestsPerMinute: number;
    readonly sseConnections: number;
  };
  /** This shard's share: the rates this generator process drives. */
  readonly targets: {
    readonly snapshotRps: number;
    readonly clientConfigRps: number;
    readonly t2Rps: number;
    readonly sseConnections: number;
  };
  /** The global hub cap; not sharded, since the origin has one hub. */
  readonly sseCap: number;
  readonly mix: {
    /** Share of snapshot requests sent as `?updated_after_seq=<mark>` once a mark is known. */
    readonly cursorShare: number;
    /** Share of snapshot requests sent with `If-None-Match` once a tag is known. */
    readonly conditionalShare: number;
  };
  readonly phases: readonly Phase[];
}

/** Ramp 2 min, hold 10 min, origin dead 5 min — one T2 budget. */
export const DEFAULT_DURATIONS_MS = {
  ramp: 120_000,
  steady: 600_000,
  originKill: 300_000,
} as const;

export class ScenarioError extends Error {
  override readonly name = 'ScenarioError';
}

export function buildScenario(input: ScenarioInput = {}): Scenario {
  const baseline = input.baseline ?? PLANNING_BASELINE;
  const assumptions = input.assumptions ?? DEFAULT_ASSUMPTIONS;
  const multiplier = input.multiplier ?? L3_MULTIPLIER;
  const scale = input.scale ?? 1;
  const sseCap = input.sseCap ?? SSE_HARD_CAP;
  const shard = input.shard ?? { index: 1, count: 1 };
  const durations = input.durationsMs ?? DEFAULT_DURATIONS_MS;

  positive('multiplier', multiplier);
  positive('scale', scale);
  if (!Number.isInteger(sseCap) || sseCap < 1)
    throw new ScenarioError('sseCap must be a positive integer');
  if (
    !Number.isInteger(shard.count) ||
    shard.count < 1 ||
    !Number.isInteger(shard.index) ||
    shard.index < 1 ||
    shard.index > shard.count
  ) {
    throw new ScenarioError('shard must be i/n with 1 ≤ i ≤ n');
  }
  positive('ramp duration', durations.ramp);
  positive('steady duration', durations.steady);
  if (!(durations.originKill >= 0)) throw new ScenarioError('origin-kill duration must be ≥ 0');
  positive('meanSessionMinutes', assumptions.meanSessionMinutes);
  positive('pollIntervalMs', assumptions.pollIntervalMs);
  positive('safetySnapshotIntervalMs', assumptions.safetySnapshotIntervalMs);
  if (!(assumptions.t2ShareAfterOriginKill >= 0 && assumptions.t2ShareAfterOriginKill <= 1)) {
    throw new ScenarioError('t2ShareAfterOriginKill must be within [0, 1]');
  }

  const factor = multiplier * scale;
  const totals = {
    sessions: baseline.sessions * factor,
    snapshotRequestsPerMinute: baseline.snapshotRequestsPerMinute * factor,
    sseConnections: Math.ceil(baseline.sseConnections * factor),
  };

  const snapshotRps = totals.snapshotRequestsPerMinute / 60 / shard.count;
  const clientConfigRps = totals.sessions / (assumptions.meanSessionMinutes * 60) / shard.count;
  const t2Rps = snapshotRps * assumptions.t2ShareAfterOriginKill;
  // Integer connections per shard, and the shards together owe exactly the total.
  const sseConnections =
    Math.floor(totals.sseConnections / shard.count) +
    (shard.index <= totals.sseConnections % shard.count ? 1 : 0);

  const phases: Phase[] = [
    { name: 'ramp', durationMs: durations.ramp },
    { name: 'steady', durationMs: durations.steady },
  ];
  if (durations.originKill > 0)
    phases.push({ name: 'origin-kill', durationMs: durations.originKill });

  return {
    schema: SCENARIO_SCHEMA,
    baseline,
    assumptions,
    multiplier,
    scale,
    shard,
    totals,
    targets: { snapshotRps, clientConfigRps, t2Rps, sseConnections },
    sseCap,
    mix: deriveMix(assumptions, snapshotRps, clientConfigRps),
    phases,
  };
}

/**
 * The request mix, derived rather than guessed:
 *
 *   * cursor share — between two full safety snapshots a poller sends one full request
 *     and the rest as cursor requests, so `1 − poll / safety` (45 s / 10 min → 0.925);
 *   * conditional share — every snapshot request except a session's first carries the tag
 *     it last saw, and a session's first request happens once per session start, i.e. at
 *     the client-config rate: `1 − configRate / snapshotRate`.
 */
export function deriveMix(
  assumptions: Pick<TrafficAssumptions, 'pollIntervalMs' | 'safetySnapshotIntervalMs'>,
  snapshotRps: number,
  clientConfigRps: number,
): Scenario['mix'] {
  const cursorShare = clamp01(
    1 - assumptions.pollIntervalMs / assumptions.safetySnapshotIntervalMs,
  );
  const conditionalShare = snapshotRps > 0 ? clamp01(1 - clientConfigRps / snapshotRps) : 0;
  return { cursorShare, conditionalShare };
}

/**
 * Arrivals a stream owes from the start of a phase until `elapsedMs` into it: the integral
 * of its rate. A `ramp` rises linearly from zero to `ratePerSecond` over the phase, so its
 * integral is quadratic; `full` is linear; `off` is zero. The generator issues
 * `floor(owed) − issued` requests per tick, which keeps the long-run rate exact however
 * irregular the ticks are.
 */
export function cumulativeArrivals(
  shape: RateShape,
  ratePerSecond: number,
  phaseDurationMs: number,
  elapsedMs: number,
): number {
  const t = Math.min(Math.max(elapsedMs, 0), phaseDurationMs);
  switch (shape) {
    case 'off':
      return 0;
    case 'full':
      return (ratePerSecond * t) / 1000;
    case 'ramp':
      return phaseDurationMs === 0 ? 0 : (ratePerSecond * t * t) / (2 * phaseDurationMs * 1000);
  }
}

/** Streams that should be open (or opening) `elapsedMs` into a phase. */
export function desiredSseConnections(scenario: Scenario, phase: Phase, elapsedMs: number): number {
  const target = scenario.targets.sseConnections;
  switch (RATE_PROFILE.sse[phase.name]) {
    case 'off':
      return 0;
    case 'full':
      return target;
    case 'ramp': {
      const fraction = Math.min(Math.max(elapsedMs / phase.durationMs, 0), 1);
      return Math.floor(target * fraction);
    }
  }
}

/** The rate a request stream is driven at, before its phase shape is applied. */
export function streamRate(scenario: Scenario, stream: RequestStream): number {
  switch (stream) {
    case 'snapshot':
      return scenario.targets.snapshotRps;
    case 'clientConfig':
      return scenario.targets.clientConfigRps;
    case 't2':
      return scenario.targets.t2Rps;
  }
}

/** Requests the whole scenario owes a stream: the yardstick for the generator's own health. */
export function plannedArrivals(scenario: Scenario, stream: RequestStream): number {
  const rate = streamRate(scenario, stream);
  return scenario.phases.reduce(
    (sum, phase) =>
      sum +
      cumulativeArrivals(
        RATE_PROFILE[stream][phase.name],
        rate,
        phase.durationMs,
        phase.durationMs,
      ),
    0,
  );
}

function positive(name: string, value: number): void {
  if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    throw new ScenarioError(`${name} must be a positive number`);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
