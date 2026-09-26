/**
 * Transport supervisor (review 08 §5.2.3, ADR-003 D3 as amended by A1.1/A1.2) — the one
 * actor that decides which tier the client reads from. It is a pure reducer over reported
 * outcomes and monotonic time: the feeds own their transports and report what happened;
 * the supervisor answers with a state and a list of effects; the coordinator carries the
 * effects out. Nothing here touches the network or the wall clock, which is what makes
 * every transition replayable — the fast-check suite in `supervisor.property.test.ts`
 * drives it with thousands of random histories.
 *
 * ## The machine
 *
 * - `BOOT → POLLING` on `start` — T1 is the default for everyone (ADR-003 D1).
 * - `POLLING → SSE_CONNECTING` on the first *healthy* poll when the stream is enabled and
 *   the re-offer hold has elapsed; `SSE_CONNECTING → SSE_LIVE` on `open`. Live, the poller
 *   drops to its safety cadence: a full snapshot every 10 minutes, no cursor polls (D3).
 * - `SSE_* → POLLING` on any stream `error` or a server `degrade`, **silently** (A1.1): the
 *   user sees polling, not a warning, and the stream is not offered again for 30 minutes
 *   (`hysteresisMs`, L-2 criterion 4: no flapping).
 * - `* → STATIC_FALLBACK` under exactly the A1.2 flip conditions: three consecutive
 *   unusable origin responses spanning at least two poll intervals, **or** one fetched
 *   snapshot whose `generated_at` is older than the T2 freshness bound measured in server
 *   time (A1.6). A `429` counts as unusable (A1.3); a `304` is usable and fresh.
 * - `STATIC_FALLBACK → POLLING` after the origin has answered usable *and* fresh for 30
 *   continuous minutes (A1.2: "follows the supervisor's existing 30-min hysteresis"). Only
 *   origin outcomes (`tier: 'T1'`) move this window; the static copy's own outcomes say
 *   nothing about the origin.
 * - `wake` / `online` in any running state: force a full snapshot before trusting whatever
 *   transport is up (D3), without changing state.
 *
 * ## What an effect means
 *
 * Effects are instructions to the coordinator, emitted in the order they must be applied:
 * `poll` (re)starts the poller in a cadence — a restart always begins with a full fetch, so
 * it doubles as "resync now"; `set-tier` points the poller at the origin or the static copy;
 * `open-stream` / `close-stream` drive the SSE feed; `refetch` forces one full fetch in place.
 */

import type { Clock, ServerNow } from '../ports.js';
import type {
  PollCadence,
  PollOutcome,
  PollingTier,
  SseSignal,
  SupervisorState,
} from '../types.js';

/** Unusable origin responses in a row before the streak can flip to T2 (A1.2). */
export const STATIC_FLIP_STREAK = 3;

/** Poll intervals the streak must span before it can flip to T2 (A1.2). */
export const STATIC_FLIP_SPAN_INTERVALS = 2;

export interface SupervisorConfig {
  readonly pollIntervalMs: number;
  /** A fetched snapshot older than this (server time) flips to T2 (A1.2 freshness bound). */
  readonly staticFlipStaleMs: number;
  /** Both hysteresis windows: SSE re-offer after a drop, and T2 → T1 recovery (30 min). */
  readonly hysteresisMs: number;
  /** `false` never leaves polling — the CI-7 configuration (every feature T1-complete). */
  readonly sseEnabled: boolean;
}

/** The whole reducer state — plain data so a test can build any point in a history. */
export interface SupervisorSnapshot {
  readonly state: SupervisorState;
  /** Length of the current run of unusable origin outcomes. */
  readonly unusableStreak: number;
  /** Monotonic ms of the first outcome of that run; `null` when the run is empty. */
  readonly unusableSince: number | null;
  /** In fallback: monotonic ms since which every origin probe was usable and fresh. */
  readonly healthySince: number | null;
  /** Monotonic ms before which the stream is not offered (0 = no hold). */
  readonly sseHoldUntil: number;
}

export type SupervisorInput =
  | { readonly type: 'start' }
  | { readonly type: 'poll'; readonly outcome: PollOutcome }
  | { readonly type: 'stream'; readonly signal: SseSignal }
  | { readonly type: 'wake' }
  | { readonly type: 'online' };

export type SupervisorEffect =
  | { readonly type: 'poll'; readonly cadence: PollCadence }
  | { readonly type: 'set-tier'; readonly tier: PollingTier }
  | { readonly type: 'open-stream' }
  | { readonly type: 'close-stream' }
  | { readonly type: 'refetch' };

export interface SupervisorContext {
  /** Monotonic ms — every window here is an interval, never a wall-clock instant. */
  readonly now: number;
  /** Server-time epoch ms (A1.6) — the only clock `generated_at` may be compared against. */
  readonly serverNow: number;
}

export interface SupervisorStep {
  readonly next: SupervisorSnapshot;
  readonly effects: readonly SupervisorEffect[];
}

export const INITIAL_SUPERVISOR_SNAPSHOT: SupervisorSnapshot = {
  state: 'BOOT',
  unusableStreak: 0,
  unusableSince: null,
  healthySince: null,
  sseHoldUntil: 0,
};

/** A1.2's freshness test for one fetched snapshot; a 304 (no body) is fresh by definition. */
function isStale(outcome: PollOutcome, ctx: SupervisorContext, config: SupervisorConfig): boolean {
  if (outcome.kind !== 'ok' || outcome.generatedAt === null) return false;
  const generatedMs = Date.parse(outcome.generatedAt);
  if (Number.isNaN(generatedMs)) return false;
  return ctx.serverNow - generatedMs > config.staticFlipStaleMs;
}

const NO_EFFECTS: readonly SupervisorEffect[] = [];

function same(snapshot: SupervisorSnapshot): SupervisorStep {
  return { next: snapshot, effects: NO_EFFECTS };
}

function reducePoll(
  s: SupervisorSnapshot,
  outcome: PollOutcome,
  ctx: SupervisorContext,
  config: SupervisorConfig,
): SupervisorStep {
  // Only the origin's answers say anything about the origin.
  if (outcome.tier !== 'T1') return same(s);

  if (s.state === 'STATIC_FALLBACK') {
    if (outcome.kind === 'unusable' || isStale(outcome, ctx, config)) {
      return same(s.healthySince === null ? s : { ...s, healthySince: null });
    }
    const healthySince = s.healthySince ?? ctx.now;
    if (ctx.now - healthySince < config.hysteresisMs) {
      return same(healthySince === s.healthySince ? s : { ...s, healthySince });
    }
    return {
      next: { ...s, state: 'POLLING', healthySince: null, unusableStreak: 0, unusableSince: null },
      effects: [{ type: 'set-tier', tier: 'T1' }],
    };
  }

  if (outcome.kind === 'unusable') {
    const unusableSince = s.unusableSince ?? ctx.now;
    const unusableStreak = s.unusableStreak + 1;
    const spans =
      unusableStreak >= STATIC_FLIP_STREAK &&
      ctx.now - unusableSince >= STATIC_FLIP_SPAN_INTERVALS * config.pollIntervalMs;
    if (!spans) return same({ ...s, unusableStreak, unusableSince });
    return flipToStatic({ ...s, unusableStreak, unusableSince });
  }

  const reset = s.unusableStreak === 0 ? s : { ...s, unusableStreak: 0, unusableSince: null };
  if (isStale(outcome, ctx, config)) return flipToStatic(reset);

  if (s.state === 'POLLING' && config.sseEnabled && ctx.now >= s.sseHoldUntil) {
    return { next: { ...reset, state: 'SSE_CONNECTING' }, effects: [{ type: 'open-stream' }] };
  }
  return same(reset);
}

/** Leave whatever transport is up for the static copy; a live stream is closed first. */
function flipToStatic(s: SupervisorSnapshot): SupervisorStep {
  const streaming = s.state === 'SSE_CONNECTING' || s.state === 'SSE_LIVE';
  const next: SupervisorSnapshot = {
    ...s,
    state: 'STATIC_FALLBACK',
    unusableStreak: 0,
    unusableSince: null,
    healthySince: null,
  };
  return {
    next,
    effects: streaming
      ? [
          { type: 'close-stream' },
          { type: 'poll', cadence: 'poll' },
          { type: 'set-tier', tier: 'T2' },
        ]
      : [{ type: 'set-tier', tier: 'T2' }],
  };
}

function reduceStream(
  s: SupervisorSnapshot,
  signal: SseSignal,
  ctx: SupervisorContext,
  config: SupervisorConfig,
): SupervisorStep {
  if (s.state !== 'SSE_CONNECTING' && s.state !== 'SSE_LIVE') return same(s);
  if (signal.kind === 'open') {
    if (s.state === 'SSE_LIVE') return same(s);
    return { next: { ...s, state: 'SSE_LIVE' }, effects: [{ type: 'poll', cadence: 'safety' }] };
  }
  // `error` and `degrade` alike: back to polling without a word, and no second offer for
  // the whole hysteresis window (A1.1). The poller restart begins with a full fetch, which
  // is the resync a dropped stream owes the store (D3 rule 3).
  return {
    next: { ...s, state: 'POLLING', sseHoldUntil: ctx.now + config.hysteresisMs },
    effects: [{ type: 'close-stream' }, { type: 'poll', cadence: 'poll' }],
  };
}

export function reduceSupervisor(
  s: SupervisorSnapshot,
  input: SupervisorInput,
  ctx: SupervisorContext,
  config: SupervisorConfig,
): SupervisorStep {
  switch (input.type) {
    case 'start':
      if (s.state !== 'BOOT') return same(s);
      return { next: { ...s, state: 'POLLING' }, effects: [{ type: 'poll', cadence: 'poll' }] };
    case 'poll':
      if (s.state === 'BOOT') return same(s);
      return reducePoll(s, input.outcome, ctx, config);
    case 'stream':
      return reduceStream(s, input.signal, ctx, config);
    case 'wake':
    case 'online':
      if (s.state === 'BOOT') return same(s);
      return { next: s, effects: [{ type: 'refetch' }] };
  }
}

export interface TransportSupervisor {
  state(): SupervisorState;
  snapshot(): SupervisorSnapshot;
  dispatch(input: SupervisorInput): void;
  /** Effects, in order, as each dispatch produces them. Returns an unsubscribe function. */
  onEffect(callback: (effect: SupervisorEffect) => void): () => void;
  /** Subscribe to transitions; returns an unsubscribe function. */
  onTransition(callback: (to: SupervisorState, from: SupervisorState) => void): () => void;
}

export interface TransportSupervisorOptions {
  readonly clock: Clock;
  readonly serverNow: ServerNow;
  readonly config: SupervisorConfig;
}

/**
 * The stateful shell around {@link reduceSupervisor}: holds the current snapshot, reads the
 * clocks once per dispatch, and fans out transitions and effects. Transitions are announced
 * before effects so a listener that keys off the state (the coordinator's "which feed's
 * status is the truth?") already sees the new state when the effects arrive.
 */
export function createTransportSupervisor(opts: TransportSupervisorOptions): TransportSupervisor {
  const { clock, serverNow, config } = opts;
  const effectCallbacks = new Set<(effect: SupervisorEffect) => void>();
  const transitionCallbacks = new Set<(to: SupervisorState, from: SupervisorState) => void>();
  let current = INITIAL_SUPERVISOR_SNAPSHOT;

  return {
    state: () => current.state,
    snapshot: () => current,
    dispatch: (input) => {
      const ctx: SupervisorContext = { now: clock.monotonicNow(), serverNow: serverNow() };
      const { next, effects } = reduceSupervisor(current, input, ctx, config);
      const from = current.state;
      current = next;
      if (next.state !== from) {
        for (const callback of [...transitionCallbacks]) callback(next.state, from);
      }
      for (const effect of effects) {
        for (const callback of [...effectCallbacks]) callback(effect);
      }
    },
    onEffect: (callback) => {
      effectCallbacks.add(callback);
      return () => {
        effectCallbacks.delete(callback);
      };
    },
    onTransition: (callback) => {
      transitionCallbacks.add(callback);
      return () => {
        transitionCallbacks.delete(callback);
      };
    },
  };
}
