import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LIGHTNING_REFRESH_INTERVAL_MS } from '../core/lightning/lightning-refresh.js';
import { MemoryFeedStatus } from '../core/passes/__fixtures__/memory-feed-status.js';
import { MemoryPayloads } from '../core/passes/__fixtures__/memory-payloads.js';
import { VirtualClock } from '../core/ports/clock.js';
import type { LightningClient } from '../core/ports/lightning-client.js';
import type { LightningDecoder } from '../core/ports/lightning-decoder.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import { LIGHTNING_LOOP, startLightningLoops, wireLightningRefresh } from './lightning-wiring.js';

const NOW = Date.UTC(2026, 8, 30, 12, 40);

describe('startLightningLoops', () => {
  it('runs the refresh on its 5-minute cadence and reports a failed search as degraded', async () => {
    const payloads = new MemoryPayloads();
    let searches = 0;
    const client: LightningClient = {
      search: () => {
        searches += 1;
        return Promise.resolve({ ok: false, status: 503, error: 'HTTP 503' });
      },
      downloadBody: () => Promise.reject(new Error('not expected')),
    };
    const decoder: LightningDecoder = {
      decode: () => Promise.reject(new Error('not expected')),
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
    const loops = startLightningLoops(
      { client, decoder, payloads, reader: payloads, clock, feedStatus: new MemoryFeedStatus() },
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
    expect(loops.map(([name]) => name)).toEqual([LIGHTNING_LOOP]);
    await Promise.all(loops.map(([, stats]) => stats));

    expect(observed).toEqual([LIGHTNING_LOOP]);
    expect(pauses[0]).toBe(LIGHTNING_REFRESH_INTERVAL_MS);
    expect(searches).toBe(2);
    const parsed = lines.map(
      (line) =>
        JSON.parse(line) as { degraded: boolean; lightning_refresh: { searchError: string } },
    );
    expect(parsed.map((p) => p.degraded)).toEqual([true, true]);
    expect(parsed[0]?.lightning_refresh.searchError).toMatch(/503/);
  });
});

describe('wireLightningRefresh', () => {
  it('builds the real adapters over the state dir without touching the network', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fire-watch-lightning-wiring-'));
    try {
      const deps = wireLightningRefresh(
        {
          credentials: { consumerKey: 'k', consumerSecret: 's' },
          baseUrl: 'https://api.eumetsat.int',
        },
        stateDir,
        new VirtualClock(NOW),
      );
      expect(typeof deps.client.search).toBe('function');
      expect(typeof deps.decoder.decode).toBe('function');
      expect(deps.payloads).toBe(deps.reader);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('the lightning cycle with a database', () => {
  it('runs the context pass after the refresh, reports its error as degraded, and closes the pool', async () => {
    const payloads = new MemoryPayloads();
    const client: LightningClient = {
      search: () => Promise.resolve({ ok: true, products: [] }),
      downloadBody: () => Promise.reject(new Error('not expected')),
    } as unknown as LightningClient;
    const decoder: LightningDecoder = { decode: () => Promise.reject(new Error('not expected')) };
    const clock = new VirtualClock(NOW);
    const controller = new AbortController();
    const asked: string[] = [];
    let closed = 0;
    const lines: string[] = [];
    const loops = startLightningLoops(
      {
        client,
        decoder,
        payloads,
        reader: payloads,
        clock,
        feedStatus: new MemoryFeedStatus(),
        context: {
          deps: {
            store: {
              pendingEvents: (version) => {
                asked.push(version);
                return Promise.reject(new Error('db down'));
              },
              save: () => Promise.resolve(),
            },
            reader: payloads,
            clock,
          },
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        },
      },
      {
        clock,
        sleeper: {
          sleep: () => {
            controller.abort();
            return Promise.resolve();
          },
        },
        writeLine: (line) => lines.push(line),
      },
      controller.signal,
    );
    await Promise.all(loops.map(([, stats]) => stats));
    expect(asked).toEqual(['lightning_context_v1']);
    expect(closed).toBe(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as {
      degraded: boolean;
      lightning_refresh: { context: { error: string } };
    };
    expect(parsed.lightning_refresh.context.error).toBe('db down');
    expect(parsed.degraded).toBe(true);
  });
});
