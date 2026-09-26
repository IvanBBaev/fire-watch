import { describe, expect, it } from 'vitest';

import { createHostCpuSampler, osCpuTimes, type CpuTimes } from './host-cpu.js';

function core(busy: number, idle: number): CpuTimes {
  return { user: busy, nice: 0, sys: 0, idle, irq: 0 };
}

describe('createHostCpuSampler', () => {
  it('has no interval to report on at the first reading', () => {
    const sampler = createHostCpuSampler(() => [core(100, 100)]);
    expect(sampler.sampleBusyFraction()).toBeNull();
  });

  it('reports the busy share of the interval between two readings, over every core', () => {
    const readings: CpuTimes[][] = [
      [core(0, 0), core(0, 0)],
      // One core fully busy for 100 ticks, the other fully idle: half the host.
      [core(100, 0), core(0, 100)],
      // Then both idle for 100 ticks: nothing.
      [core(100, 100), core(0, 200)],
      // Then both busy: everything.
      [core(200, 100), core(100, 200)],
    ];
    const sampler = createHostCpuSampler(() => readings.shift() ?? []);

    expect(sampler.sampleBusyFraction()).toBeNull();
    expect(sampler.sampleBusyFraction()).toBeCloseTo(0.5, 6);
    expect(sampler.sampleBusyFraction()).toBeCloseTo(0, 6);
    expect(sampler.sampleBusyFraction()).toBeCloseTo(1, 6);
  });

  it('answers null for a zero-length interval rather than dividing by it', () => {
    const sampler = createHostCpuSampler(() => [core(50, 50)]);
    sampler.sampleBusyFraction();
    expect(sampler.sampleBusyFraction()).toBeNull();
  });

  it('answers null on a platform that reports no cores at all', () => {
    const sampler = createHostCpuSampler(() => []);
    sampler.sampleBusyFraction();
    expect(sampler.sampleBusyFraction()).toBeNull();
  });

  it('reads the real counters in the shape it expects', () => {
    for (const times of osCpuTimes()) {
      expect(Number.isFinite(times.user + times.nice + times.sys + times.idle + times.irq)).toBe(
        true,
      );
    }
  });
});
