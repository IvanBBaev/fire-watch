import { describe, expect, it } from 'vitest';

import type { PollOutcome } from '../types.js';
import {
  INITIAL_SUPERVISOR_SNAPSHOT,
  createTransportSupervisor,
  reduceSupervisor,
  type SupervisorConfig,
  type SupervisorContext,
  type SupervisorEffect,
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

const NO_SSE: SupervisorConfig = { ...CONFIG, sseEnabled: false };

const ok = (overrides: Partial<Extract<PollOutcome, { kind: 'ok' }>> = {}): PollOutcome => ({
  kind: 'ok',
  tier: 'T1',
  full: true,
  generatedAt: null,
  ...overrides,
});

const unusable = (
  overrides: Partial<Extract<PollOutcome, { kind: 'unusable' }>> = {},
): PollOutcome => ({
  kind: 'unusable',
  tier: 'T1',
  status: 503,
  retryAfterMs: null,
  ...overrides,
});

/** A stepper: monotonic and server time move together from fixed origins. */
function history(config: SupervisorConfig = CONFIG) {
  let snapshot: SupervisorSnapshot = INITIAL_SUPERVISOR_SNAPSHOT;
  let now = 100_000;
  const effects: SupervisorEffect[] = [];
  const ctx = (): SupervisorContext => ({ now, serverNow: SERVER_T0 + now });
  const step = (input: Parameters<typeof reduceSupervisor>[1]) => {
    const out = reduceSupervisor(snapshot, input, ctx(), config);
    snapshot = out.next;
    effects.push(...out.effects);
    return out;
  };
  return {
    step,
    advance: (ms: number) => {
      now += ms;
    },
    get snapshot() {
      return snapshot;
    },
    effects,
    /** ISO `generated_at` this many ms behind the current server time. */
    generatedAgo: (ms: number) => new Date(SERVER_T0 + now - ms).toISOString(),
  };
}

describe('reduceSupervisor: boot', () => {
  it('starts in BOOT and enters POLLING with a poll effect on start', () => {
    const h = history();
    expect(h.snapshot.state).toBe('BOOT');
    const out = h.step({ type: 'start' });
    expect(out.next.state).toBe('POLLING');
    expect(out.effects).toEqual([{ type: 'poll', cadence: 'poll' }]);
  });

  it('ignores everything but start while in BOOT', () => {
    const h = history();
    for (const input of [
      { type: 'poll', outcome: ok() } as const,
      { type: 'stream', signal: { kind: 'open' } } as const,
      { type: 'wake' } as const,
      { type: 'online' } as const,
    ]) {
      const out = h.step(input);
      expect(out.next).toBe(INITIAL_SUPERVISOR_SNAPSHOT);
      expect(out.effects).toEqual([]);
    }
  });

  it('a second start is a no-op', () => {
    const h = history();
    h.step({ type: 'start' });
    const out = h.step({ type: 'start' });
    expect(out.effects).toEqual([]);
    expect(out.next.state).toBe('POLLING');
  });
});

describe('reduceSupervisor: SSE offer and silent fallback (A1.1)', () => {
  it('offers the stream on the first healthy poll when enabled', () => {
    const h = history();
    h.step({ type: 'start' });
    const out = h.step({ type: 'poll', outcome: ok() });
    expect(out.next.state).toBe('SSE_CONNECTING');
    expect(out.effects).toEqual([{ type: 'open-stream' }]);
  });

  it('never offers the stream when disabled (CI-7 configuration)', () => {
    const h = history(NO_SSE);
    h.step({ type: 'start' });
    for (let i = 0; i < 50; i += 1) {
      h.advance(CONFIG.pollIntervalMs);
      h.step({ type: 'poll', outcome: ok() });
    }
    expect(h.snapshot.state).toBe('POLLING');
    expect(h.effects.filter((e) => e.type === 'open-stream')).toEqual([]);
  });

  it('does not offer the stream on an unusable poll', () => {
    const h = history();
    h.step({ type: 'start' });
    const out = h.step({ type: 'poll', outcome: unusable() });
    expect(out.next.state).toBe('POLLING');
    expect(out.effects).toEqual([]);
  });

  it('goes live on open and moves the poller to the safety cadence', () => {
    const h = history();
    h.step({ type: 'start' });
    h.step({ type: 'poll', outcome: ok() });
    const out = h.step({ type: 'stream', signal: { kind: 'open' } });
    expect(out.next.state).toBe('SSE_LIVE');
    expect(out.effects).toEqual([{ type: 'poll', cadence: 'safety' }]);
  });

  it('falls back to polling silently on error and holds the re-offer for 30 minutes', () => {
    const h = history();
    h.step({ type: 'start' });
    h.step({ type: 'poll', outcome: ok() });
    h.step({ type: 'stream', signal: { kind: 'open' } });
    h.advance(MINUTE);
    const drop = h.step({ type: 'stream', signal: { kind: 'error' } });
    expect(drop.next.state).toBe('POLLING');
    expect(drop.effects).toEqual([{ type: 'close-stream' }, { type: 'poll', cadence: 'poll' }]);

    // Healthy polls inside the hold do not re-offer.
    for (let elapsed = 0; elapsed + CONFIG.pollIntervalMs < CONFIG.hysteresisMs;) {
      h.advance(CONFIG.pollIntervalMs);
      elapsed += CONFIG.pollIntervalMs;
      const out = h.step({ type: 'poll', outcome: ok() });
      expect(out.next.state).toBe('POLLING');
      expect(out.effects).toEqual([]);
    }
    // The first healthy poll at or past the hold re-offers.
    h.advance(CONFIG.pollIntervalMs);
    const reoffer = h.step({ type: 'poll', outcome: ok() });
    expect(reoffer.next.state).toBe('SSE_CONNECTING');
    expect(reoffer.effects).toEqual([{ type: 'open-stream' }]);
  });

  it('treats a server degrade frame exactly like an error', () => {
    const h = history();
    h.step({ type: 'start' });
    h.step({ type: 'poll', outcome: ok() });
    h.step({ type: 'stream', signal: { kind: 'open' } });
    const out = h.step({ type: 'stream', signal: { kind: 'degrade', reason: 'overloaded' } });
    expect(out.next.state).toBe('POLLING');
    expect(out.next.sseHoldUntil).toBe(100_000 + CONFIG.hysteresisMs);
    expect(out.effects).toEqual([{ type: 'close-stream' }, { type: 'poll', cadence: 'poll' }]);
  });

  it('a failed connect (error before open) also falls back and holds', () => {
    const h = history();
    h.step({ type: 'start' });
    h.step({ type: 'poll', outcome: ok() });
    const out = h.step({ type: 'stream', signal: { kind: 'error' } });
    expect(out.next.state).toBe('POLLING');
    expect(out.next.sseHoldUntil).toBeGreaterThan(0);
  });

  it('ignores stream signals while polling or in fallback', () => {
    const h = history();
    h.step({ type: 'start' });
    const out = h.step({ type: 'stream', signal: { kind: 'error' } });
    expect(out.next).toBe(h.snapshot);
    expect(out.effects).toEqual([]);
    expect(h.snapshot.sseHoldUntil).toBe(0);
  });

  it('a duplicate open while live changes nothing', () => {
    const h = history();
    h.step({ type: 'start' });
    h.step({ type: 'poll', outcome: ok() });
    h.step({ type: 'stream', signal: { kind: 'open' } });
    const out = h.step({ type: 'stream', signal: { kind: 'open' } });
    expect(out.effects).toEqual([]);
    expect(out.next.state).toBe('SSE_LIVE');
  });
});

describe('reduceSupervisor: static fallback (A1.2/A1.3)', () => {
  it('flips to T2 on three consecutive unusable responses spanning two poll intervals', () => {
    const h = history(NO_SSE);
    h.step({ type: 'start' });
    expect(h.step({ type: 'poll', outcome: unusable() }).next.state).toBe('POLLING');
    h.advance(CONFIG.pollIntervalMs);
    expect(h.step({ type: 'poll', outcome: unusable() }).next.state).toBe('POLLING');
    h.advance(CONFIG.pollIntervalMs);
    const out = h.step({ type: 'poll', outcome: unusable() });
    expect(out.next.state).toBe('STATIC_FALLBACK');
    expect(out.effects).toEqual([{ type: 'set-tier', tier: 'T2' }]);
  });

  it('three unusable responses inside one interval (retries) do not flip', () => {
    const h = history(NO_SSE);
    h.step({ type: 'start' });
    for (let i = 0; i < 3; i += 1) {
      h.advance(1_000);
      h.step({ type: 'poll', outcome: unusable() });
    }
    expect(h.snapshot.state).toBe('POLLING');
    expect(h.snapshot.unusableStreak).toBe(3);
    // The streak keeps counting; once the span is reached, the next one flips.
    h.advance(2 * CONFIG.pollIntervalMs);
    expect(h.step({ type: 'poll', outcome: unusable() }).next.state).toBe('STATIC_FALLBACK');
  });

  it('a usable response in between resets the streak', () => {
    const h = history(NO_SSE);
    h.step({ type: 'start' });
    h.step({ type: 'poll', outcome: unusable() });
    h.advance(CONFIG.pollIntervalMs);
    h.step({ type: 'poll', outcome: unusable() });
    h.advance(CONFIG.pollIntervalMs);
    h.step({ type: 'poll', outcome: ok() });
    expect(h.snapshot.unusableStreak).toBe(0);
    expect(h.snapshot.unusableSince).toBeNull();
    h.advance(CONFIG.pollIntervalMs);
    expect(h.step({ type: 'poll', outcome: unusable() }).next.state).toBe('POLLING');
  });

  it('counts 429 as unusable (A1.3) — the body is never consulted', () => {
    const h = history(NO_SSE);
    h.step({ type: 'start' });
    for (let i = 0; i < 3; i += 1) {
      h.step({ type: 'poll', outcome: unusable({ status: 429, retryAfterMs: 30_000 }) });
      h.advance(CONFIG.pollIntervalMs);
    }
    expect(h.snapshot.state).toBe('STATIC_FALLBACK');
  });

  it('flips at once on a snapshot older than the freshness bound in server time', () => {
    const h = history(NO_SSE);
    h.step({ type: 'start' });
    const fresh = h.step({
      type: 'poll',
      outcome: ok({ generatedAt: h.generatedAgo(4 * MINUTE) }),
    });
    expect(fresh.next.state).toBe('POLLING');
    const stale = h.step({
      type: 'poll',
      outcome: ok({ generatedAt: h.generatedAgo(5 * MINUTE + 1) }),
    });
    expect(stale.next.state).toBe('STATIC_FALLBACK');
    expect(stale.effects).toEqual([{ type: 'set-tier', tier: 'T2' }]);
  });

  it('a 304 (no generated_at) is usable and fresh', () => {
    const h = history(NO_SSE);
    h.step({ type: 'start' });
    for (let i = 0; i < 20; i += 1) {
      h.advance(CONFIG.pollIntervalMs);
      h.step({ type: 'poll', outcome: ok({ generatedAt: null, full: false }) });
    }
    expect(h.snapshot.state).toBe('POLLING');
  });

  it('closes a live stream first when flipping from SSE_LIVE', () => {
    const h = history();
    h.step({ type: 'start' });
    h.step({ type: 'poll', outcome: ok() });
    h.step({ type: 'stream', signal: { kind: 'open' } });
    const out = h.step({ type: 'poll', outcome: ok({ generatedAt: h.generatedAgo(6 * MINUTE) }) });
    expect(out.next.state).toBe('STATIC_FALLBACK');
    expect(out.effects).toEqual([
      { type: 'close-stream' },
      { type: 'poll', cadence: 'poll' },
      { type: 'set-tier', tier: 'T2' },
    ]);
  });

  it('returns to T1 after 30 continuous minutes of usable, fresh origin probes', () => {
    const h = history(NO_SSE);
    h.step({ type: 'start' });
    for (let i = 0; i < 3; i += 1) {
      h.step({ type: 'poll', outcome: unusable() });
      h.advance(CONFIG.pollIntervalMs);
    }
    expect(h.snapshot.state).toBe('STATIC_FALLBACK');

    let flipped = false;
    let elapsed = 0;
    while (!flipped) {
      const out = h.step({ type: 'poll', outcome: ok() });
      flipped = out.next.state === 'POLLING';
      if (flipped) {
        expect(out.effects).toEqual([{ type: 'set-tier', tier: 'T1' }]);
        expect(elapsed).toBeGreaterThanOrEqual(CONFIG.hysteresisMs);
      } else {
        expect(elapsed).toBeLessThan(CONFIG.hysteresisMs);
      }
      h.advance(CONFIG.pollIntervalMs);
      elapsed += CONFIG.pollIntervalMs;
    }
  });

  it('a single unusable or stale origin probe restarts the recovery window', () => {
    const h = history(NO_SSE);
    h.step({ type: 'start' });
    for (let i = 0; i < 3; i += 1) {
      h.step({ type: 'poll', outcome: unusable() });
      h.advance(CONFIG.pollIntervalMs);
    }
    h.step({ type: 'poll', outcome: ok() });
    h.advance(25 * MINUTE);
    h.step({ type: 'poll', outcome: ok({ generatedAt: h.generatedAgo(10 * MINUTE) }) });
    expect(h.snapshot.healthySince).toBeNull();
    h.advance(CONFIG.pollIntervalMs);
    h.step({ type: 'poll', outcome: ok() });
    h.advance(29 * MINUTE);
    expect(h.step({ type: 'poll', outcome: ok() }).next.state).toBe('STATIC_FALLBACK');
    h.advance(2 * MINUTE);
    expect(h.step({ type: 'poll', outcome: ok() }).next.state).toBe('POLLING');
  });

  it('ignores outcomes from the static copy itself — they say nothing about the origin', () => {
    const h = history(NO_SSE);
    h.step({ type: 'start' });
    for (let i = 0; i < 3; i += 1) {
      h.step({ type: 'poll', outcome: unusable() });
      h.advance(CONFIG.pollIntervalMs);
    }
    const before = h.snapshot;
    for (let i = 0; i < 60; i += 1) {
      h.advance(CONFIG.pollIntervalMs);
      h.step({ type: 'poll', outcome: ok({ tier: 'T2' }) });
      h.step({ type: 'poll', outcome: unusable({ tier: 'T2' }) });
    }
    expect(h.snapshot).toBe(before);
    expect(h.snapshot.state).toBe('STATIC_FALLBACK');
  });

  it('does not re-offer the stream from fallback on recovery until a healthy T1 poll arrives', () => {
    const h = history();
    h.step({ type: 'start' });
    for (let i = 0; i < 3; i += 1) {
      h.step({ type: 'poll', outcome: unusable() });
      h.advance(CONFIG.pollIntervalMs);
    }
    expect(h.snapshot.state).toBe('STATIC_FALLBACK');
    h.step({ type: 'poll', outcome: ok() });
    h.advance(CONFIG.hysteresisMs);
    const recovered = h.step({ type: 'poll', outcome: ok() });
    expect(recovered.next.state).toBe('POLLING');
    expect(recovered.effects).toEqual([{ type: 'set-tier', tier: 'T1' }]);
    const offered = h.step({ type: 'poll', outcome: ok() });
    expect(offered.next.state).toBe('SSE_CONNECTING');
  });
});

describe('reduceSupervisor: wake and online', () => {
  it('forces a refetch in every running state without changing state', () => {
    const h = history();
    h.step({ type: 'start' });
    for (const input of [{ type: 'wake' } as const, { type: 'online' } as const]) {
      const out = h.step(input);
      expect(out.next).toBe(h.snapshot);
      expect(out.effects).toEqual([{ type: 'refetch' }]);
    }
    h.step({ type: 'poll', outcome: ok() });
    h.step({ type: 'stream', signal: { kind: 'open' } });
    const live = h.step({ type: 'wake' });
    expect(live.next.state).toBe('SSE_LIVE');
    expect(live.effects).toEqual([{ type: 'refetch' }]);
  });
});

describe('createTransportSupervisor', () => {
  it('reads the clocks per dispatch and fans out transitions before effects', () => {
    let mono = 5_000;
    let server = SERVER_T0;
    const clock = { epochNow: () => 0, monotonicNow: () => mono };
    const supervisor = createTransportSupervisor({
      clock,
      serverNow: () => server,
      config: NO_SSE,
    });
    const log: string[] = [];
    const offTransition = supervisor.onTransition((to, from) => log.push(`${from}>${to}`));
    const offEffect = supervisor.onEffect((effect) => log.push(effect.type));

    expect(supervisor.state()).toBe('BOOT');
    supervisor.dispatch({ type: 'start' });
    expect(log).toEqual(['BOOT>POLLING', 'poll']);

    log.length = 0;
    for (let i = 0; i < 3; i += 1) {
      supervisor.dispatch({ type: 'poll', outcome: unusable() });
      mono += CONFIG.pollIntervalMs;
      server += CONFIG.pollIntervalMs;
    }
    expect(supervisor.state()).toBe('STATIC_FALLBACK');
    expect(log).toEqual(['POLLING>STATIC_FALLBACK', 'set-tier']);
    expect(supervisor.snapshot().unusableStreak).toBe(0);

    offTransition();
    offEffect();
    log.length = 0;
    supervisor.dispatch({ type: 'wake' });
    expect(log).toEqual([]);
  });
});
