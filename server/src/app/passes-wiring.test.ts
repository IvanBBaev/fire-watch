import { describe, expect, it } from 'vitest';

import { MemoryFeedStatus } from '../core/passes/__fixtures__/memory-feed-status.js';
import { MemoryPayloads } from '../core/passes/__fixtures__/memory-payloads.js';
import { TLE_HALT_PATH, TLE_REFRESH_INTERVAL_MS } from '../core/passes/tle-refresh.js';
import { VirtualClock } from '../core/ports/clock.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import type { TleClient } from '../core/ports/tle-client.js';
import { reportTleRefresh, startPassesLoops, TLE_LOOP } from './passes-wiring.js';

const NOW = Date.UTC(2026, 8, 30, 13, 16);

describe('startPassesLoops', () => {
  it('runs the TLE refresh on its 12-hour cadence and reports a halt as degraded', async () => {
    const payloads = new MemoryPayloads();
    const asked: number[] = [];
    const client: TleClient = {
      fetchElements: (noradId) => {
        asked.push(noradId);
        return Promise.resolve({ body: null, status: 403, availableAt: null, error: 'HTTP 403' });
      },
    };
    const clock = new VirtualClock(NOW);
    const controller = new AbortController();
    const pauses: number[] = [];
    const sleeper: Sleeper = {
      sleep: (ms) => {
        pauses.push(ms);
        if (pauses.length === 2) controller.abort();
        clock.advanceMs(ms);
        return Promise.resolve();
      },
    };
    const lines: string[] = [];
    const observed: string[] = [];
    const loops = startPassesLoops(
      { client, payloads, clock, feedStatus: new MemoryFeedStatus() },
      {
        clock,
        sleeper,
        writeLine: (line) => lines.push(line),
        observe: (loop, report) => {
          observed.push(loop);
          return report;
        },
      },
      controller.signal,
    );
    expect(loops.map(([name]) => name)).toEqual([TLE_LOOP]);
    await Promise.all(loops.map(([, stats]) => stats));

    expect(observed).toEqual([TLE_LOOP]);
    expect(pauses[0]).toBe(TLE_REFRESH_INTERVAL_MS);
    // The first cycle asked once and latched; the second asked nothing.
    expect(asked).toEqual([43013]);
    expect(payloads.files.has(TLE_HALT_PATH)).toBe(true);
    expect(lines.map((line) => (JSON.parse(line) as { degraded: boolean }).degraded)).toEqual([
      true,
      true,
    ]);
  });
});

describe('reportTleRefresh', () => {
  it('writes one line for a run that threw', () => {
    const lines: string[] = [];
    reportTleRefresh(
      { startedAt: NOW, finishedAt: NOW, value: undefined, error: new Error('boom') },
      { writeLine: (line) => lines.push(line) },
    );
    expect(JSON.parse(lines[0]!)).toEqual({ tle_refresh_failed: { error: 'boom', at: NOW } });
  });
});
