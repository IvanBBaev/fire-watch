import { describe, expect, it } from 'vitest';

import { CEMS_CURRENT_PATH } from '../core/cems/cems-document.js';
import { CEMS_REFRESH_INTERVAL_MS } from '../core/cems/cems-refresh.js';
import { MemoryFeedStatus } from '../core/passes/__fixtures__/memory-feed-status.js';
import { MemoryPayloads } from '../core/passes/__fixtures__/memory-payloads.js';
import type { CemsClient } from '../core/ports/cems-client.js';
import { VirtualClock } from '../core/ports/clock.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import { CEMS_LOOP, reportCemsRefresh, startCemsLoops } from './cems-wiring.js';

const NOW = Date.UTC(2026, 9, 24, 9, 0);

describe('startCemsLoops', () => {
  it('runs the activation refresh hourly and reports a refused list as degraded', async () => {
    const payloads = new MemoryPayloads();
    let listed = 0;
    const client: CemsClient = {
      listActivations: () => {
        listed += 1;
        return Promise.resolve({ body: null, status: 503, availableAt: null, error: 'HTTP 503' });
      },
      activationDetail: () => Promise.reject(new Error('not expected')),
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
    const loops = startCemsLoops(
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
    expect(loops.map(([name]) => name)).toEqual([CEMS_LOOP]);
    await Promise.all(loops.map(([, stats]) => stats));

    expect(observed).toEqual([CEMS_LOOP]);
    expect(pauses[0]).toBe(CEMS_REFRESH_INTERVAL_MS);
    expect(listed).toBe(2);
    expect(payloads.files.has(CEMS_CURRENT_PATH)).toBe(false);
    expect(lines.map((line) => (JSON.parse(line) as { degraded: boolean }).degraded)).toEqual([
      true,
      true,
    ]);
  });
});

describe('reportCemsRefresh', () => {
  it('writes one line for a run that threw', () => {
    const lines: string[] = [];
    reportCemsRefresh(
      { startedAt: NOW, finishedAt: NOW, value: undefined, error: new Error('boom') },
      { writeLine: (line) => lines.push(line) },
    );
    expect(JSON.parse(lines[0]!)).toEqual({ cems_refresh_failed: { error: 'boom', at: NOW } });
  });
});
