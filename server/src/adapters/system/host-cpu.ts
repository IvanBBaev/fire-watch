/**
 * Host CPU, as the demotion controller wants it (ADR-003 A1.1 trigger 3): the busy share
 * of every core over the interval since the previous reading, `0..1`.
 *
 * **Host**, not process, on purpose: A1.1 says "host CPU > 80 %", and on the one VM this
 * runs on (OPERATIONS §9.1) the API process shares the cores with Postgres and the ingest
 * worker. A box saturated by a partition scan makes the stream slow whether or not the
 * stream's own process is busy, and the fleet must be moved off the stream either way.
 * `os.cpus()` reads the kernel's per-core counters, which are the host's counters even
 * from inside a container — exactly the reading wanted.
 *
 * The counters are cumulative, so a reading is a delta between two calls: the first call
 * has nothing to subtract from and answers `null`, and so does a call made before any
 * tick was accounted (a zero-length interval has no busy share).
 */

import { cpus } from 'node:os';

/** The five counters Node exposes per core, cumulative ms since boot. */
export interface CpuTimes {
  readonly user: number;
  readonly nice: number;
  readonly sys: number;
  readonly idle: number;
  readonly irq: number;
}

export interface HostCpuSampler {
  /** The host's busy fraction since the previous call, or `null` when there is no interval yet. */
  sampleBusyFraction(): number | null;
}

/** What the sampler reads; injectable so a test can script the counters. */
export type CpuTimesReader = () => readonly CpuTimes[];

export const osCpuTimes: CpuTimesReader = () => cpus().map((core) => core.times);

export function createHostCpuSampler(read: CpuTimesReader = osCpuTimes): HostCpuSampler {
  let previous: Totals | null = null;

  return {
    sampleBusyFraction() {
      const current = totals(read());
      const last = previous;
      previous = current;
      if (last === null) return null;
      const elapsed = current.total - last.total;
      if (elapsed <= 0) return null;
      const idle = current.idle - last.idle;
      return Math.min(1, Math.max(0, 1 - idle / elapsed));
    },
  };
}

interface Totals {
  readonly total: number;
  readonly idle: number;
}

/** Summed over every core, so one saturated core out of four reads as a quarter. */
function totals(cores: readonly CpuTimes[]): Totals {
  let total = 0;
  let idle = 0;
  for (const core of cores) {
    total += core.user + core.nice + core.sys + core.idle + core.irq;
    idle += core.idle;
  }
  return { total, idle };
}
