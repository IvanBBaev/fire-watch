import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../ports/clock.js';
import type { TleClient, TleFetch } from '../ports/tle-client.js';
import { CELESTRAK_FETCHED_AT_MS, OMM_BY_NORAD, OMM_SNPP } from './__fixtures__/celestrak-omm.js';
import { MemoryFeedStatus } from './__fixtures__/memory-feed-status.js';
import { MemoryPayloads } from './__fixtures__/memory-payloads.js';
import { PASS_PLATFORMS } from './pass-platforms.js';
import {
  TLE_HALT_PATH,
  runTleRefresh,
  tleElementsPath,
  tleMetaPath,
  tleRefreshFailed,
} from './tle-refresh.js';

type Answer = TleFetch | Error;

class ScriptedClient implements TleClient {
  readonly asked: number[] = [];
  constructor(private readonly answers: Readonly<Record<number, Answer>>) {}

  fetchElements(noradId: number): Promise<TleFetch> {
    this.asked.push(noradId);
    const answer = this.answers[noradId];
    if (answer === undefined) throw new Error(`test asked for unscripted NORAD ${String(noradId)}`);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }
}

const ok = (body: string): TleFetch => ({
  body,
  status: 200,
  availableAt: CELESTRAK_FETCHED_AT_MS,
  error: null,
});
const status = (code: number): TleFetch => ({
  body: null,
  status: code,
  availableAt: null,
  error: `HTTP ${String(code)}`,
});
const noResponse: TleFetch = { body: null, status: null, availableAt: null, error: 'timeout' };

function allOk(): Record<number, Answer> {
  return Object.fromEntries(PASS_PLATFORMS.map((p) => [p.noradId, ok(OMM_BY_NORAD[p.noradId]!)]));
}

function setup(answers: Record<number, Answer>) {
  const payloads = new MemoryPayloads();
  const client = new ScriptedClient(answers);
  const clock = new VirtualClock(CELESTRAK_FETCHED_AT_MS);
  const feedStatus = new MemoryFeedStatus();
  return {
    payloads,
    client,
    clock,
    feedStatus,
    run: () => runTleRefresh({ client, payloads, clock, feedStatus }),
  };
}

describe('runTleRefresh', () => {
  it('stores every platform’s body verbatim with a provenance sidecar', async () => {
    const { payloads, run } = setup(allOk());
    const report = await run();

    expect(report.platforms.map((r) => r.outcome)).toEqual(PASS_PLATFORMS.map(() => 'stored'));
    expect(tleRefreshFailed(report)).toBe(false);
    expect(payloads.text(tleElementsPath(37849))).toBe(OMM_SNPP);
    const meta = JSON.parse(payloads.text(tleMetaPath(37849))!) as Record<string, unknown>;
    expect(meta).toMatchObject({
      provider: 'celestrak',
      norad_id: 37849,
      platform: 'snpp',
      object_name: 'SUOMI NPP',
      available_at: '2026-09-30T13:16:00Z',
    });
    expect(meta['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(meta['epoch']).toBe(report.platforms.find((r) => r.noradId === 37849)?.epoch);
    // Payload first, then its sidecar: a reader never sees a sidecar for bytes not yet there.
    const writes = payloads.writes;
    expect(writes.indexOf(tleElementsPath(37849))).toBeLessThan(writes.indexOf(tleMetaPath(37849)));
  });

  it.each([301, 403, 404, 429, 500])(
    'latches the halt on HTTP %i and makes no further request',
    async (code) => {
      const answers = allOk();
      answers[PASS_PLATFORMS[1]!.noradId] = status(code);
      const { payloads, client, run } = setup(answers);
      const report = await run();

      expect(report.haltedNow).toBe(true);
      expect(tleRefreshFailed(report)).toBe(true);
      expect(client.asked).toEqual(PASS_PLATFORMS.slice(0, 2).map((p) => p.noradId));
      expect(report.platforms.map((r) => r.outcome)).toEqual([
        'stored',
        'refused',
        'not_attempted',
        'not_attempted',
        'not_attempted',
      ]);
      const halt = JSON.parse(payloads.text(TLE_HALT_PATH)!) as Record<string, unknown>;
      expect(halt).toMatchObject({ provider: 'celestrak', status: code, norad_id: 37849 });
    },
  );

  it('makes no request at all while the latch is set, cycle after cycle', async () => {
    const { payloads, client, clock, run } = setup(allOk());
    await payloads.writeText(TLE_HALT_PATH, '{}\n');
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const report = await run();
      expect(report.halted).toBe(true);
      expect(tleRefreshFailed(report)).toBe(true);
      clock.advanceHours(12);
    }
    expect(client.asked).toEqual([]);
  });

  it('treats an unreadable latch as set', async () => {
    const { payloads, client, run } = setup(allOk());
    payloads.existsThrows = true;
    const report = await run();
    expect(report.halted).toBe(true);
    expect(report.haltError).toMatch(/unreadable/);
    expect(client.asked).toEqual([]);
  });

  it('reports a latch it could not write', async () => {
    const answers = allOk();
    answers[43013] = status(403);
    const { payloads, run } = setup(answers);
    payloads.failWritesOn = /halt/;
    const report = await run();
    expect(report.haltedNow).toBe(true);
    expect(report.haltError).toMatch(/not written/);
  });

  it('does not latch on a transport failure; the next cycle retries', async () => {
    const answers = allOk();
    answers[43013] = noResponse;
    answers[54234] = new Error('socket hang up');
    const { payloads, run } = setup(answers);
    const report = await run();
    expect(report.haltedNow).toBe(false);
    expect(payloads.files.has(TLE_HALT_PATH)).toBe(false);
    expect(report.platforms.map((r) => r.outcome)).toEqual([
      'fetch_failed',
      'stored',
      'fetch_failed',
      'stored',
      'stored',
    ]);
    expect(tleRefreshFailed(report)).toBe(false);
  });

  it('stores nothing for a 200 that is not this satellite’s elements', async () => {
    const answers = allOk();
    answers[43013] = ok(OMM_SNPP);
    answers[37849] = ok('No GP data found');
    const { payloads, run } = setup(answers);
    const report = await run();
    expect(report.platforms[0]).toMatchObject({ outcome: 'invalid', error: /expected 43013/ });
    expect(report.platforms[1]).toMatchObject({ outcome: 'invalid' });
    expect(payloads.files.has(tleElementsPath(43013))).toBe(false);
    expect(payloads.files.has(TLE_HALT_PATH)).toBe(false);
  });

  it('keeps the other platforms when one write fails, and is degraded only if none stored', async () => {
    const { payloads, run } = setup(allOk());
    payloads.failWritesOn = /43013/;
    const report = await run();
    expect(report.platforms[0]?.outcome).toBe('write_failed');
    expect(report.platforms.slice(1).every((r) => r.outcome === 'stored')).toBe(true);
    expect(tleRefreshFailed(report)).toBe(false);

    payloads.failWritesOn = /tle/;
    expect(tleRefreshFailed(await run())).toBe(true);
  });

  describe('the celestrak:elements feed row', () => {
    it('records a success when every platform stored current elements', async () => {
      const { feedStatus, run } = setup(allOk());
      const report = await run();
      expect(report.feedStatusError).toBeNull();
      expect(feedStatus.attempts).toEqual([
        {
          row: 'celestrak:elements',
          attemptAt: CELESTRAK_FETCHED_AT_MS,
          succeeded: true,
          hadData: true,
          error: null,
        },
      ]);
    });

    it('records a partial cycle as a failure that still brought data home', async () => {
      const answers = allOk();
      answers[43013] = noResponse;
      const { feedStatus, run } = setup(answers);
      await run();
      expect(feedStatus.attempts[0]).toMatchObject({
        succeeded: false,
        hadData: true,
        error: expect.stringMatching(/^noaa20: timeout$/) as string,
      });
    });

    it('records stored-but-stale elements as a failure: the row watches the epoch', async () => {
      const { feedStatus, clock, run } = setup(allOk());
      clock.advanceHours(24 * 30);
      await run();
      expect(feedStatus.attempts[0]).toMatchObject({
        succeeded: false,
        hadData: true,
        error: expect.stringMatching(/older than 72 h/) as string,
      });
    });

    it('records a failure every cycle while the latch is set, with no request made', async () => {
      const { payloads, client, clock, feedStatus, run } = setup(allOk());
      await payloads.writeText(TLE_HALT_PATH, '{}\n');
      await run();
      clock.advanceHours(12);
      await run();
      expect(client.asked).toEqual([]);
      expect(feedStatus.attempts.map((a) => [a.succeeded, a.hadData, a.error])).toEqual([
        [false, false, 'halted: the CelesTrak halt latch is set'],
        [false, false, 'halted: the CelesTrak halt latch is set'],
      ]);
    });

    it('records the unreadable latch as the reason', async () => {
      const { payloads, feedStatus, run } = setup(allOk());
      payloads.existsThrows = true;
      await run();
      expect(feedStatus.attempts[0]?.error).toMatch(/halt latch unreadable/);
    });

    it('reports a store failure as degraded without throwing out of the job', async () => {
      const { feedStatus, run } = setup(allOk());
      feedStatus.throws = true;
      const report = await run();
      expect(report.feedStatusError).toMatch(/unwritable/);
      expect(tleRefreshFailed(report)).toBe(true);
    });
  });
});
