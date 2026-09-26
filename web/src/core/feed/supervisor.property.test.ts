/**
 * Properties of the transport supervisor over random histories (ADR-003 A1.1/A1.2,
 * review 08 L-2 criterion 4). Each property drives `reduceSupervisor` with a random
 * sequence of inputs at random monotonic gaps and checks an invariant that must hold at
 * every step, whatever the order.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PollOutcome, SseSignal } from '../types.js';
import {
  INITIAL_SUPERVISOR_SNAPSHOT,
  STATIC_FLIP_SPAN_INTERVALS,
  STATIC_FLIP_STREAK,
  reduceSupervisor,
  type SupervisorConfig,
  type SupervisorInput,
  type SupervisorSnapshot,
} from './supervisor.js';

const MINUTE = 60_000;
const SERVER_T0 = Date.parse('2026-07-14T10:00:00Z');

const CONFIG: SupervisorConfig = {
  pollIntervalMs: 45_000,
  staticFlipStaleMs: 5 * MINUTE,
  hysteresisMs: 30 * MINUTE,
  sseEnabled: true,
};

/** One scripted step: how long after the previous step it happens, and what arrives. */
interface Step {
  readonly gapMs: number;
  readonly input: SupervisorInput;
}

/** A trace entry: the context at the step, the input, and the reducer's answer. */
interface Trace {
  readonly now: number;
  readonly input: SupervisorInput;
  readonly before: SupervisorSnapshot;
  readonly after: SupervisorSnapshot;
  readonly effects: readonly ReturnType<typeof reduceSupervisor>['effects'][number][];
}

const pollOutcomeArb: fc.Arbitrary<PollOutcome> = fc.oneof(
  fc.record({
    kind: fc.constant('ok' as const),
    tier: fc.constantFrom('T1' as const, 'T2' as const),
    full: fc.boolean(),
    // Age of the fetched snapshot in server time; `null` = 304.
    ageMs: fc.option(fc.integer({ min: 0, max: 12 * MINUTE }), { nil: null }),
  }),
  fc.record({
    kind: fc.constant('unusable' as const),
    tier: fc.constantFrom('T1' as const, 'T2' as const),
    status: fc.constantFrom(429, 500, 502, 503, 504, null),
    retryAfterMs: fc.option(fc.integer({ min: 1_000, max: 120_000 }), { nil: null }),
  }),
) as unknown as fc.Arbitrary<PollOutcome>;

const signalArb: fc.Arbitrary<SseSignal> = fc.oneof(
  fc.constant({ kind: 'open' } as const),
  fc.constant({ kind: 'error' } as const),
  fc.constant({ kind: 'degrade', reason: 'overloaded' } as const),
);

const stepArb: fc.Arbitrary<Step> = fc.record({
  gapMs: fc.oneof(
    fc.constant(0),
    fc.integer({ min: 1, max: CONFIG.pollIntervalMs }),
    fc.integer({ min: CONFIG.pollIntervalMs, max: 35 * MINUTE }),
  ),
  input: fc.oneof(
    {
      weight: 6,
      arbitrary: fc.record({ type: fc.constant('poll' as const), outcome: pollOutcomeArb }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ type: fc.constant('stream' as const), signal: signalArb }),
    },
    { weight: 1, arbitrary: fc.constant({ type: 'wake' } as const) },
    { weight: 1, arbitrary: fc.constant({ type: 'online' } as const) },
  ),
});

/**
 * Replay a script from BOOT, materialising each `ok` outcome's `generated_at` against the
 * server clock of the moment it arrives so "age" is meaningful in server time (A1.6).
 */
function run(steps: readonly Step[], config: SupervisorConfig = CONFIG): Trace[] {
  const trace: Trace[] = [];
  let snapshot = INITIAL_SUPERVISOR_SNAPSHOT;
  let now = 1_000;
  const boot = reduceSupervisor(snapshot, { type: 'start' }, { now, serverNow: SERVER_T0 }, config);
  trace.push({
    now,
    input: { type: 'start' },
    before: snapshot,
    after: boot.next,
    effects: boot.effects,
  });
  snapshot = boot.next;

  for (const step of steps) {
    now += step.gapMs;
    const serverNow = SERVER_T0 + now;
    let input: SupervisorInput = step.input;
    if (input.type === 'poll' && input.outcome.kind === 'ok') {
      const raw = input.outcome as unknown as {
        ageMs: number | null;
        tier: 'T1' | 'T2';
        full: boolean;
      };
      input = {
        type: 'poll',
        outcome: {
          kind: 'ok',
          tier: raw.tier,
          full: raw.full,
          generatedAt: raw.ageMs === null ? null : new Date(serverNow - raw.ageMs).toISOString(),
        },
      };
    }
    const out = reduceSupervisor(snapshot, input, { now, serverNow }, config);
    trace.push({ now, input, before: snapshot, after: out.next, effects: out.effects });
    snapshot = out.next;
  }
  return trace;
}

function isHealthyOrigin(input: SupervisorInput, serverNow: number, config: SupervisorConfig) {
  if (input.type !== 'poll' || input.outcome.tier !== 'T1' || input.outcome.kind !== 'ok') {
    return false;
  }
  const at = input.outcome.generatedAt;
  return at === null || serverNow - Date.parse(at) <= config.staticFlipStaleMs;
}

describe('supervisor properties', () => {
  it('never re-offers the stream within the hysteresis window after a drop (A1.1, L-2 #4)', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 200 }), (steps) => {
        const trace = run(steps);
        let lastDropAt: number | null = null;
        for (const t of trace) {
          const dropped =
            (t.before.state === 'SSE_CONNECTING' || t.before.state === 'SSE_LIVE') &&
            t.after.state === 'POLLING';
          if (dropped) lastDropAt = t.now;
          const offered = t.effects.some((e) => e.type === 'open-stream');
          if (offered && lastDropAt !== null) {
            expect(t.now - lastDropAt).toBeGreaterThanOrEqual(CONFIG.hysteresisMs);
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it('never offers the stream at all when it is disabled', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 100 }), (steps) => {
        const trace = run(steps, { ...CONFIG, sseEnabled: false });
        for (const t of trace) {
          expect(t.after.state).not.toBe('SSE_CONNECTING');
          expect(t.after.state).not.toBe('SSE_LIVE');
          expect(t.effects.some((e) => e.type === 'open-stream')).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('flips to T2 only under the A1.2 condition, and only on an origin outcome', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 200 }), (steps) => {
        const trace = run(steps);
        // Reconstruct the streak independently of the reducer's own bookkeeping.
        let streak = 0;
        let streakSince: number | null = null;
        for (const t of trace) {
          const flipped =
            t.before.state !== 'STATIC_FALLBACK' && t.after.state === 'STATIC_FALLBACK';
          const serverNow = SERVER_T0 + t.now;
          if (flipped) {
            expect(t.input.type).toBe('poll');
            if (t.input.type !== 'poll') return;
            expect(t.input.outcome.tier).toBe('T1');
            const stale =
              t.input.outcome.kind === 'ok' &&
              t.input.outcome.generatedAt !== null &&
              serverNow - Date.parse(t.input.outcome.generatedAt) > CONFIG.staticFlipStaleMs;
            const byStreak =
              t.input.outcome.kind === 'unusable' &&
              streak + 1 >= STATIC_FLIP_STREAK &&
              streakSince !== null &&
              t.now - streakSince >= STATIC_FLIP_SPAN_INTERVALS * CONFIG.pollIntervalMs;
            expect(stale || byStreak).toBe(true);
            expect(t.effects.some((e) => e.type === 'set-tier' && e.tier === 'T2')).toBe(true);
          }
          // Streak bookkeeping — origin outcomes only, and only outside fallback.
          if (t.input.type === 'poll' && t.input.outcome.tier === 'T1') {
            if (t.after.state === 'STATIC_FALLBACK') {
              streak = 0;
              streakSince = null;
            } else if (t.input.outcome.kind === 'unusable') {
              streakSince ??= t.now;
              streak += 1;
            } else {
              streak = 0;
              streakSince = null;
            }
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it('returns from T2 only after 30 continuous minutes of usable, fresh origin probes', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 300 }), (steps) => {
        const trace = run(steps);
        let healthySince: number | null = null;
        for (const t of trace) {
          const serverNow = SERVER_T0 + t.now;
          const recovered = t.before.state === 'STATIC_FALLBACK' && t.after.state === 'POLLING';
          if (
            t.before.state === 'STATIC_FALLBACK' &&
            t.input.type === 'poll' &&
            t.input.outcome.tier === 'T1'
          ) {
            if (isHealthyOrigin(t.input, serverNow, CONFIG)) {
              healthySince ??= t.now;
            } else {
              healthySince = null;
            }
          }
          if (recovered) {
            expect(healthySince).not.toBeNull();
            expect(t.now - (healthySince ?? 0)).toBeGreaterThanOrEqual(CONFIG.hysteresisMs);
            expect(t.effects).toEqual([{ type: 'set-tier', tier: 'T1' }]);
          }
          if (t.after.state !== 'STATIC_FALLBACK') healthySince = null;
        }
      }),
      { numRuns: 400 },
    );
  });

  it('static-copy outcomes never change the snapshot', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 200 }), (steps) => {
        const trace = run(steps);
        for (const t of trace) {
          if (t.input.type === 'poll' && t.input.outcome.tier === 'T2') {
            expect(t.after).toBe(t.before);
            expect(t.effects).toEqual([]);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('the safety cadence is requested exactly when the stream goes live', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 200 }), (steps) => {
        const trace = run(steps);
        for (const t of trace) {
          const wentLive = t.before.state !== 'SSE_LIVE' && t.after.state === 'SSE_LIVE';
          const safety = t.effects.some((e) => e.type === 'poll' && e.cadence === 'safety');
          expect(safety).toBe(wentLive);
          if (wentLive) expect(t.before.state).toBe('SSE_CONNECTING');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('every state other than BOOT answers wake/online with a refetch and nothing else', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 100 }), (steps) => {
        const trace = run(steps);
        for (const t of trace) {
          if (t.input.type === 'wake' || t.input.type === 'online') {
            expect(t.after).toBe(t.before);
            expect(t.effects).toEqual([{ type: 'refetch' }]);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a stream is closed whenever the machine leaves a streaming state', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 200 }), (steps) => {
        const trace = run(steps);
        for (const t of trace) {
          const wasStreaming = t.before.state === 'SSE_CONNECTING' || t.before.state === 'SSE_LIVE';
          const isStreaming = t.after.state === 'SSE_CONNECTING' || t.after.state === 'SSE_LIVE';
          if (wasStreaming && !isStreaming) {
            expect(t.effects[0]).toEqual({ type: 'close-stream' });
          }
          if (!wasStreaming) {
            expect(t.effects.some((e) => e.type === 'close-stream')).toBe(false);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
