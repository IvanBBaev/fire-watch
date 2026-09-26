/**
 * The demotion controller (ADR-003 D1 "server-side transport control", A1.1; 04 §5.2.3) —
 * the one thing that decides whether `/api/v1/client-config` says `transport: "sse"` or
 * `transport: "poll"`.
 *
 * It is a pure step function over injected samples and a millisecond clock, in the same
 * style as the web client's supervisor: the adapters measure (open streams, event-loop
 * lag, host CPU), the wiring feeds one sample every few seconds, the controller answers
 * with the next state and, when the answer changed, a transition the wiring acts on. No
 * timers, no `os`, no `perf_hooks` — that is what keeps every window here a hand-driven
 * test.
 *
 * ## The A1.1 triggers, and how each one reads on a sample
 *
 * | # | Trigger                                 | Window            |
 * |---|-----------------------------------------|-------------------|
 * | 1 | concurrent SSE connections > cap (5,000)| instant           |
 * | 2 | event-loop lag p99 > 200 ms             | sustained 5 min   |
 * | 3 | host CPU > 80 %                         | sustained 5 min   |
 *
 * - Trigger 1 is read as "the hub is full": the hub refuses admission *at* the cap, so
 *   the count never exceeds it, and the moment it equals the cap every further connect
 *   is already the 503 the amendment describes. Demoting there moves the fleet to T1
 *   instead of letting it queue on a door that is shut.
 * - "Sustained 5 min" means every sample for five minutes was over the threshold; one
 *   sample under it restarts the window. The controller keeps the instant the current
 *   run of over-threshold samples began and demotes when that run is five minutes old.
 * - A sample with `null` for a measurement (the sampler has nothing yet) is "no
 *   evidence": it never counts as over the threshold and never resets a clear window.
 *
 * ## Re-offer hysteresis (A1.1, L-2 criterion 4: no flapping)
 *
 * Once demoted, SSE is offered again only after **30 min continuously below all three
 * thresholds**. Any excursion — one sample over any threshold, or a full hub — resets the
 * clear window to zero. The same reducer state serves both windows; only `transport`
 * says which one is running.
 *
 * ## The operator kill
 *
 * `sseEnabled: false` (from the environment) pins `transport: "poll"` unconditionally:
 * no sample can re-offer, and no transition is ever announced. That is the "turn the
 * stream off for everyone without a deploy" of D1: the document is edge-cached for 30 s
 * and the API process restarts in seconds, so an environment change plus a restart is
 * every bit as fast as a live toggle would be, with none of the toggle's surface.
 *
 * Time is interval arithmetic on whatever clock the caller injects. The windows are
 * minutes long, so the process clock is sufficient; a wall-clock step would shift one
 * window once, never flip the transport by itself.
 */

import type { ClientTransport } from '@fire-watch/contracts';

import type { Clock } from '../ports/clock.js';

/** A1.1 trigger 2. */
export const LAG_P99_THRESHOLD_MS = 200;
/** A1.1 trigger 3, as a busy fraction of the whole host. */
export const CPU_THRESHOLD_FRACTION = 0.8;
/** A1.1: triggers 2 and 3 must hold this long before they demote. */
export const SUSTAIN_MS = 5 * 60_000;
/** A1.1: below every threshold this long before SSE is offered again. */
export const REOFFER_MS = 30 * 60_000;

export interface DemotionConfig {
  /** Trigger 1: the hub's admission cap. A count at or above it demotes at once. */
  readonly connectionCap: number;
  readonly lagP99ThresholdMs: number;
  /** `0..1`, the busy share of the host's cores. */
  readonly cpuThresholdFraction: number;
  readonly sustainMs: number;
  readonly reofferMs: number;
  /** `false` is the operator kill: `poll` for everyone, whatever the samples say. */
  readonly sseEnabled: boolean;
}

/** One reading of the three things A1.1 watches. `null` is "the sampler has nothing yet". */
export interface DemotionSample {
  readonly connections: number;
  readonly lagP99Ms: number | null;
  readonly cpuFraction: number | null;
}

export type DemotionTrigger = 'connections' | 'event_loop_lag' | 'host_cpu';

/** The whole reducer state — plain data so a test can build any point in a history. */
export interface DemotionSnapshot {
  readonly transport: ClientTransport;
  /** Ms of the first sample of the current run of over-threshold lag; `null` when under. */
  readonly lagHighSince: number | null;
  /** As above, for CPU. */
  readonly cpuHighSince: number | null;
  /** While demoted: ms since which every sample was under every threshold; else `null`. */
  readonly clearSince: number | null;
}

export type DemotionTransition =
  { readonly type: 'demoted'; readonly trigger: DemotionTrigger } | { readonly type: 're-offered' };

export interface DemotionStep {
  readonly next: DemotionSnapshot;
  readonly transition: DemotionTransition | null;
}

export function initialDemotionSnapshot(
  config: Pick<DemotionConfig, 'sseEnabled'>,
): DemotionSnapshot {
  return {
    transport: config.sseEnabled ? 'sse' : 'poll',
    lagHighSince: null,
    cpuHighSince: null,
    clearSince: null,
  };
}

/**
 * The `degrade` frame's reason for a trigger (A1.1 mechanics): a full hub is `capacity`,
 * the two load triggers are `load`. Kept next to the triggers so the mapping is one place.
 */
export function degradeReasonFor(trigger: DemotionTrigger): 'capacity' | 'load' {
  return trigger === 'connections' ? 'capacity' : 'load';
}

export function stepDemotion(
  s: DemotionSnapshot,
  sample: DemotionSample,
  nowMs: number,
  config: DemotionConfig,
): DemotionStep {
  const full = sample.connections >= config.connectionCap;
  const lagHigh = sample.lagP99Ms !== null && sample.lagP99Ms > config.lagP99ThresholdMs;
  const cpuHigh = sample.cpuFraction !== null && sample.cpuFraction > config.cpuThresholdFraction;

  // The two sustained runs are tracked in every state: a run that began before a
  // demotion is still a run, and the clear window below only cares that they are over.
  const lagHighSince = lagHigh ? (s.lagHighSince ?? nowMs) : null;
  const cpuHighSince = cpuHigh ? (s.cpuHighSince ?? nowMs) : null;
  const tracked: DemotionSnapshot = { ...s, lagHighSince, cpuHighSince };

  if (!config.sseEnabled) {
    return { next: { ...tracked, transport: 'poll', clearSince: null }, transition: null };
  }

  if (s.transport === 'sse') {
    const trigger = triggerOf(tracked, full, nowMs, config);
    if (trigger === null) return { next: tracked, transition: null };
    return {
      next: { ...tracked, transport: 'poll', clearSince: null },
      transition: { type: 'demoted', trigger },
    };
  }

  if (full || lagHigh || cpuHigh) {
    return { next: { ...tracked, clearSince: null }, transition: null };
  }
  const clearSince = s.clearSince ?? nowMs;
  if (nowMs - clearSince < config.reofferMs) {
    return { next: { ...tracked, clearSince }, transition: null };
  }
  return {
    next: { ...tracked, transport: 'sse', clearSince: null },
    transition: { type: 're-offered' },
  };
}

/** Which trigger, if any, has fired — in the table's order, so a log line names one. */
function triggerOf(
  s: DemotionSnapshot,
  full: boolean,
  nowMs: number,
  config: DemotionConfig,
): DemotionTrigger | null {
  if (full) return 'connections';
  if (s.lagHighSince !== null && nowMs - s.lagHighSince >= config.sustainMs) {
    return 'event_loop_lag';
  }
  if (s.cpuHighSince !== null && nowMs - s.cpuHighSince >= config.sustainMs) return 'host_cpu';
  return null;
}

export interface DemotionController {
  transport(): ClientTransport;
  snapshot(): DemotionSnapshot;
  /** Feeds one sample at the clock's current instant; answers the transition it caused. */
  observe(sample: DemotionSample): DemotionTransition | null;
}

export interface DemotionControllerOptions {
  readonly clock: Clock;
  readonly config: DemotionConfig;
}

/**
 * The stateful shell around {@link stepDemotion}: holds the current snapshot and reads the
 * clock once per sample. The wiring owns the sampling cadence and everything a transition
 * causes (the `degrade` drain, the log line); this only answers.
 */
export function createDemotionController(opts: DemotionControllerOptions): DemotionController {
  const { clock, config } = opts;
  assertConfig(config);
  let current = initialDemotionSnapshot(config);

  return {
    transport: () => current.transport,
    snapshot: () => current,
    observe: (sample) => {
      const { next, transition } = stepDemotion(current, sample, clock.now(), config);
      current = next;
      return transition;
    },
  };
}

function assertConfig(config: DemotionConfig): void {
  if (!Number.isInteger(config.connectionCap) || config.connectionCap < 1) {
    throw new RangeError('connectionCap must be a positive integer');
  }
  if (!(config.lagP99ThresholdMs > 0)) {
    throw new RangeError('lagP99ThresholdMs must be positive');
  }
  if (!(config.cpuThresholdFraction > 0 && config.cpuThresholdFraction <= 1)) {
    throw new RangeError('cpuThresholdFraction must be within (0, 1]');
  }
  if (!(config.sustainMs > 0) || !(config.reofferMs > 0)) {
    throw new RangeError('sustainMs and reofferMs must be positive');
  }
}
