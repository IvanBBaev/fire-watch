import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../ports/clock.js';
import {
  CPU_THRESHOLD_FRACTION,
  LAG_P99_THRESHOLD_MS,
  REOFFER_MS,
  SUSTAIN_MS,
  createDemotionController,
  degradeReasonFor,
  initialDemotionSnapshot,
  stepDemotion,
  type DemotionConfig,
  type DemotionSample,
  type DemotionSnapshot,
  type DemotionTransition,
} from './demotion.js';

const CONFIG: DemotionConfig = {
  connectionCap: 5_000,
  lagP99ThresholdMs: LAG_P99_THRESHOLD_MS,
  cpuThresholdFraction: CPU_THRESHOLD_FRACTION,
  sustainMs: SUSTAIN_MS,
  reofferMs: REOFFER_MS,
  sseEnabled: true,
};

const MINUTE = 60_000;

/** A sampling cadence, as the wiring drives it. */
const SAMPLE_MS = 5_000;

const QUIET: DemotionSample = { connections: 12, lagP99Ms: 8, cpuFraction: 0.3 };
const LAGGING: DemotionSample = { ...QUIET, lagP99Ms: 250 };
const HOT: DemotionSample = { ...QUIET, cpuFraction: 0.95 };
const FULL: DemotionSample = { ...QUIET, connections: 5_000 };

/**
 * Drives the reducer with one sample per `SAMPLE_MS` from `fromMs` for `durationMs`,
 * returning the last state and every transition seen, so a test reads like a timeline.
 */
function run(
  start: DemotionSnapshot,
  sample: DemotionSample,
  fromMs: number,
  durationMs: number,
  config = CONFIG,
): {
  readonly at: number;
  readonly state: DemotionSnapshot;
  readonly transitions: DemotionTransition[];
} {
  let state = start;
  const transitions: DemotionTransition[] = [];
  let at = fromMs;
  for (; at <= fromMs + durationMs; at += SAMPLE_MS) {
    const step = stepDemotion(state, sample, at, config);
    state = step.next;
    if (step.transition !== null) transitions.push(step.transition);
  }
  return { at: at - SAMPLE_MS, state, transitions };
}

describe('stepDemotion: the triggers', () => {
  const offered = initialDemotionSnapshot(CONFIG);

  it('starts by offering the stream', () => {
    expect(offered.transport).toBe('sse');
  });

  it('stays offered on quiet samples, however long they run', () => {
    const { state, transitions } = run(offered, QUIET, 0, 60 * MINUTE);
    expect(state.transport).toBe('sse');
    expect(transitions).toEqual([]);
  });

  it('demotes the instant the hub is full (trigger 1)', () => {
    const step = stepDemotion(offered, FULL, 1_000, CONFIG);
    expect(step.next.transport).toBe('poll');
    expect(step.transition).toEqual({ type: 'demoted', trigger: 'connections' });
  });

  it('demotes on event-loop lag only once it has held for the whole window (trigger 2)', () => {
    // Four minutes and fifty-five seconds of lag is not five minutes.
    const nearly = run(offered, LAGGING, 0, SUSTAIN_MS - SAMPLE_MS);
    expect(nearly.state.transport).toBe('sse');
    expect(nearly.transitions).toEqual([]);

    const step = stepDemotion(nearly.state, LAGGING, SUSTAIN_MS, CONFIG);
    expect(step.next.transport).toBe('poll');
    expect(step.transition).toEqual({ type: 'demoted', trigger: 'event_loop_lag' });
  });

  it('demotes on host CPU only once it has held for the whole window (trigger 3)', () => {
    const { state, transitions } = run(offered, HOT, 0, SUSTAIN_MS);
    expect(state.transport).toBe('poll');
    expect(transitions).toEqual([{ type: 'demoted', trigger: 'host_cpu' }]);
  });

  it('does not demote on a spike shorter than the window, and restarts the window after it', () => {
    // Three minutes of lag, one quiet sample, three more minutes of lag: never five in a row.
    const first = run(offered, LAGGING, 0, 3 * MINUTE);
    const breath = stepDemotion(first.state, QUIET, first.at + SAMPLE_MS, CONFIG);
    expect(breath.next.lagHighSince).toBeNull();
    const second = run(breath.next, LAGGING, first.at + 2 * SAMPLE_MS, 3 * MINUTE);

    expect(second.state.transport).toBe('sse');
    expect(second.transitions).toEqual([]);
  });

  it('demotes when a lag run older than the window meets one more high sample, whatever the gap', () => {
    // A blocked loop can starve the sampler itself; when it comes back still lagging, the
    // run began before the window and the answer is a demotion, not a fresh window.
    const begun = stepDemotion(offered, LAGGING, 0, CONFIG);
    const step = stepDemotion(begun.next, LAGGING, SUSTAIN_MS + 4 * MINUTE, CONFIG);
    expect(step.transition).toEqual({ type: 'demoted', trigger: 'event_loop_lag' });
  });

  it('treats a missing measurement as no evidence rather than as a threshold breach', () => {
    const blind: DemotionSample = { connections: 0, lagP99Ms: null, cpuFraction: null };
    const { state, transitions } = run(offered, blind, 0, 10 * MINUTE);
    expect(state.transport).toBe('sse');
    expect(state.lagHighSince).toBeNull();
    expect(state.cpuHighSince).toBeNull();
    expect(transitions).toEqual([]);
  });

  it('names the full hub before either load trigger when several fire at once', () => {
    const lagging = run(offered, LAGGING, 0, SUSTAIN_MS - SAMPLE_MS).state;
    const step = stepDemotion(lagging, { ...LAGGING, connections: 5_000 }, SUSTAIN_MS, CONFIG);
    expect(step.transition).toEqual({ type: 'demoted', trigger: 'connections' });
  });
});

describe('stepDemotion: re-offer hysteresis', () => {
  const demoted = stepDemotion(initialDemotionSnapshot(CONFIG), FULL, 0, CONFIG).next;

  it('does not re-offer before thirty quiet minutes have elapsed', () => {
    const { state, transitions } = run(demoted, QUIET, SAMPLE_MS, REOFFER_MS - SAMPLE_MS);
    expect(state.transport).toBe('poll');
    expect(transitions).toEqual([]);
  });

  it('re-offers once every threshold has been clear for thirty minutes', () => {
    const { state, transitions } = run(demoted, QUIET, SAMPLE_MS, REOFFER_MS);
    expect(state.transport).toBe('sse');
    expect(state.clearSince).toBeNull();
    expect(transitions).toEqual([{ type: 're-offered' }]);
  });

  it('restarts the clear window on any excursion, however brief', () => {
    // Twenty-nine minutes clear, one hot sample, then thirty more minutes are needed.
    const almost = run(demoted, QUIET, SAMPLE_MS, 29 * MINUTE);
    const blip = stepDemotion(almost.state, HOT, almost.at + SAMPLE_MS, CONFIG);
    expect(blip.next.clearSince).toBeNull();
    expect(blip.next.transport).toBe('poll');

    const notYet = run(blip.next, QUIET, almost.at + 2 * SAMPLE_MS, REOFFER_MS - SAMPLE_MS);
    expect(notYet.state.transport).toBe('poll');
    expect(notYet.transitions).toEqual([]);

    const step = stepDemotion(notYet.state, QUIET, notYet.at + SAMPLE_MS, CONFIG);
    expect(step.transition).toEqual({ type: 're-offered' });
  });

  it('counts a still-full hub as an excursion, so a fleet that never left cannot be re-offered', () => {
    const { state, transitions } = run(demoted, FULL, SAMPLE_MS, 2 * REOFFER_MS);
    expect(state.transport).toBe('poll');
    expect(transitions).toEqual([]);
  });

  it('can demote again after a re-offer, so the ladder is a cycle and not a one-shot', () => {
    const reoffered = run(demoted, QUIET, SAMPLE_MS, REOFFER_MS);
    const again = run(reoffered.state, HOT, reoffered.at + SAMPLE_MS, SUSTAIN_MS);
    expect(again.state.transport).toBe('poll');
    expect(again.transitions).toEqual([{ type: 'demoted', trigger: 'host_cpu' }]);
  });
});

describe('stepDemotion: the operator kill', () => {
  const killed: DemotionConfig = { ...CONFIG, sseEnabled: false };

  it('starts on polling', () => {
    expect(initialDemotionSnapshot(killed).transport).toBe('poll');
  });

  it('never re-offers, however quiet the box is', () => {
    const { state, transitions } = run(
      initialDemotionSnapshot(killed),
      QUIET,
      0,
      3 * REOFFER_MS,
      killed,
    );
    expect(state.transport).toBe('poll');
    expect(state.clearSince).toBeNull();
    expect(transitions).toEqual([]);
  });

  it('pins polling even over a state that says otherwise, and announces nothing', () => {
    // Belt and braces: the kill is read from the environment, so no live state can say
    // `sse` under it — but if one did, the kill wins and nothing is drained or logged.
    const stray: DemotionSnapshot = { ...initialDemotionSnapshot(CONFIG), transport: 'sse' };
    const step = stepDemotion(stray, QUIET, 0, killed);
    expect(step.next.transport).toBe('poll');
    expect(step.transition).toBeNull();
  });
});

describe('degradeReasonFor', () => {
  it('maps the full hub to capacity and the two load triggers to load', () => {
    expect(degradeReasonFor('connections')).toBe('capacity');
    expect(degradeReasonFor('event_loop_lag')).toBe('load');
    expect(degradeReasonFor('host_cpu')).toBe('load');
  });
});

describe('createDemotionController', () => {
  it('reads the clock once per sample and answers the transition it caused', () => {
    const clock = new VirtualClock('2027-07-01T12:00:00Z');
    const controller = createDemotionController({ clock, config: CONFIG });
    expect(controller.transport()).toBe('sse');

    expect(controller.observe(LAGGING)).toBeNull();
    clock.advanceMinutes(4);
    expect(controller.observe(LAGGING)).toBeNull();
    clock.advanceMinutes(1);
    expect(controller.observe(LAGGING)).toEqual({ type: 'demoted', trigger: 'event_loop_lag' });
    expect(controller.transport()).toBe('poll');

    clock.advanceMinutes(1);
    expect(controller.observe(QUIET)).toBeNull();
    clock.advanceMinutes(30);
    expect(controller.observe(QUIET)).toEqual({ type: 're-offered' });
    expect(controller.transport()).toBe('sse');
    expect(controller.snapshot().clearSince).toBeNull();
  });

  it('refuses a configuration no window could be measured against', () => {
    const clock = new VirtualClock(0);
    expect(() =>
      createDemotionController({ clock, config: { ...CONFIG, connectionCap: 0 } }),
    ).toThrow(RangeError);
    expect(() =>
      createDemotionController({ clock, config: { ...CONFIG, cpuThresholdFraction: 1.5 } }),
    ).toThrow(RangeError);
    expect(() => createDemotionController({ clock, config: { ...CONFIG, sustainMs: 0 } })).toThrow(
      RangeError,
    );
  });
});
