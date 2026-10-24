import { describe, expect, it } from 'vitest';

import {
  BULGARIA_FEED_EMPTY,
  RECORDED_AT_MS,
} from '../core/meteoalarm/__fixtures__/meteoalarm-feeds.js';
import { METEOALARM_CURRENT_PATH } from '../core/meteoalarm/meteoalarm-document.js';
import { METEOALARM_REFRESH_INTERVAL_MS } from '../core/meteoalarm/meteoalarm-refresh.js';
import { MemoryFeedStatus } from '../core/passes/__fixtures__/memory-feed-status.js';
import { MemoryPayloads } from '../core/passes/__fixtures__/memory-payloads.js';
import { VirtualClock } from '../core/ports/clock.js';
import type { MeteoalarmClient } from '../core/ports/meteoalarm-client.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import {
  METEOALARM_LOOP,
  reportMeteoalarmRefresh,
  startMeteoalarmLoops,
} from './meteoalarm-wiring.js';

describe('startMeteoalarmLoops', () => {
  it('polls every 15 minutes with one job, so the second cycle sends validators', async () => {
    const payloads = new MemoryPayloads();
    const validators: unknown[] = [];
    const client: MeteoalarmClient = {
      fetchFeed: (_slug, sent) => {
        validators.push(sent);
        return Promise.resolve(
          sent === null
            ? {
                kind: 'ok',
                body: BULGARIA_FEED_EMPTY,
                validators: { etag: '"e"', lastModified: null },
              }
            : { kind: 'not-modified' },
        );
      },
      fetchCap: () => Promise.resolve({ body: null, error: 'unused' }),
    };
    const clock = new VirtualClock(RECORDED_AT_MS);
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
    const loops = startMeteoalarmLoops(
      {
        client,
        payloads,
        clock,
        feedStatus: new MemoryFeedStatus(),
        countries: [{ code: 'BG', slug: 'bulgaria' }],
      },
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
    expect(loops.map(([name]) => name)).toEqual([METEOALARM_LOOP]);
    await Promise.all(loops.map(([, stats]) => stats));

    expect(observed).toEqual([METEOALARM_LOOP]);
    expect(pauses[0]).toBe(METEOALARM_REFRESH_INTERVAL_MS);
    expect(validators).toEqual([null, { etag: '"e"', lastModified: null }]);
    expect(payloads.files.has(METEOALARM_CURRENT_PATH)).toBe(true);
    expect(lines.map((line) => (JSON.parse(line) as { degraded: boolean }).degraded)).toEqual([
      false,
      false,
    ]);
  });
});

describe('reportMeteoalarmRefresh', () => {
  it('writes one line for a run that threw', () => {
    const lines: string[] = [];
    reportMeteoalarmRefresh(
      { startedAt: 1, finishedAt: 2, value: undefined, error: new Error('boom') },
      { writeLine: (line) => lines.push(line) },
    );
    expect(JSON.parse(lines[0]!)).toEqual({ meteoalarm_refresh_failed: { error: 'boom', at: 2 } });
  });
});
