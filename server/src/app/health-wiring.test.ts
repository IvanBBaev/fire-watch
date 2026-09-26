import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClientConfigDocument, ClientImageryBlock } from '@fire-watch/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { CLIENT_CONFIG_PATH } from '../adapters/http/client-config-route.js';
import { createHealthServer } from '../adapters/http/health-server.js';
import {
  IMAGERY_STATE_DIR,
  IMAGERY_USAGE_FILE,
  createFsImageryMeterStore,
  imageryOverrideFile,
} from '../adapters/storage/fs-imagery-meter-store.js';

import { budgetFor } from '../core/config/freshness-budgets.js';
import type { FreshnessObservation } from '../core/health/freshness.js';
import { createImageryMeter } from '../core/imagery/imagery-meter.js';
import { liveFirmsSources } from '../core/ingest/firms-poller.js';
import { VirtualClock } from '../core/ports/clock.js';
import type { FreshnessReader } from '../core/ports/freshness-reader.js';
import { createStreamHub, type StreamSink } from '../core/stream/stream-hub.js';
import {
  CPU_THRESHOLD_FRACTION,
  LAG_P99_THRESHOLD_MS,
  REOFFER_MS,
  SUSTAIN_MS,
  createDemotionController,
} from '../core/transport/demotion.js';
import {
  DRAIN_RETRY_MAX_MS,
  DRAIN_RETRY_MIN_MS,
  IMAGERY_EVALUATE_MS,
  LOAD_SAMPLE_MS,
  STREAM_KEEPALIVE_MS,
  STREAM_MAX_CONNECTIONS,
  STREAM_RING_CAPACITY,
  STREAM_RETRY_MS,
  combineFreshnessReaders,
  createImageryWatch,
  createTransportWatch,
  degradeChunk,
  drainRetryChunk,
  expectedRows,
} from './health-wiring.js';

describe('expectedRows', () => {
  it('claims only rows the shipped budget table can score', () => {
    // An expected row without a budget makes the evaluator throw on *every* request — a
    // permanent 500 that would otherwise be discovered by the prober, at runtime, after a
    // deploy. This pins the invariant where it is cheap: at test time. Both deployment
    // shapes are pinned, because the C4 rows join the claim only where a worker records
    // them.
    for (const row of [...expectedRows(false), ...expectedRows(true)]) {
      expect(budgetFor(row), `no freshness budget for ${row}`).toBeDefined();
    }
  });

  it('claims exactly the sources a live cycle polls when no feeds are recorded', () => {
    // No more and no less: an extra row is a deployment permanently warn on work nobody
    // runs, and a missing one is a source that can stop without the endpoint noticing.
    // The narrowing filter inside expectedRows() must therefore drop nothing today —
    // the day it drops a live source, this fails before the endpoint goes quiet.
    expect(expectedRows(false)).toEqual(liveFirmsSources());
  });

  it('adds exactly the C4 rows when this deployment records feeds', () => {
    expect(expectedRows(true)).toEqual([
      ...liveFirmsSources(),
      'effis:layers',
      'weather:context',
      'effis-refresh',
    ]);
  });
});

describe('combineFreshnessReaders', () => {
  const observation = (row: FreshnessObservation['row']): FreshnessObservation => ({
    row,
    lastAttemptAt: 1_700_000_000_000,
    lastSuccessAt: 1_700_000_000_000,
    lastDataAt: null,
    consecutiveFailures: 0,
  });

  const answering = (rows: readonly FreshnessObservation['row'][]): FreshnessReader => ({
    readObservations: (requested) =>
      Promise.resolve(requested.filter((row) => rows.includes(row)).map(observation)),
  });

  it('concatenates what each reader answers for', async () => {
    const reader = combineFreshnessReaders([
      answering(['firms:viirs:noaa20']),
      answering(['effis:layers', 'effis-refresh']),
    ]);
    const rows = await reader.readObservations([
      'firms:viirs:noaa20',
      'effis:layers',
      'effis-refresh',
      'weather:context',
    ]);
    expect(rows.map((row) => row.row).sort()).toEqual([
      'effis-refresh',
      'effis:layers',
      'firms:viirs:noaa20',
    ]);
  });

  it('propagates a reader failure instead of rendering it as unknown rows', async () => {
    const failing: FreshnessReader = {
      readObservations: () => Promise.reject(new Error('feed status store unreadable')),
    };
    const reader = combineFreshnessReaders([answering(['firms:viirs:noaa20']), failing]);
    await expect(reader.readObservations(['firms:viirs:noaa20'])).rejects.toThrow(
      'feed status store unreadable',
    );
  });
});

describe('stream wiring', () => {
  it('pins the T0 row of ADR-003 D1', () => {
    expect(STREAM_MAX_CONNECTIONS).toBe(5_000);
    expect(STREAM_RING_CAPACITY).toBe(1_000);
    expect(STREAM_RETRY_MS).toBe(5_000);
    expect(STREAM_KEEPALIVE_MS).toBe(25_000);
  });

  it('spreads the drain retry from the first client to the last, as retry lines', () => {
    expect(drainRetryChunk(0, 1)).toBe(`retry: ${String(DRAIN_RETRY_MIN_MS)}\n\n`);
    expect(drainRetryChunk(0, 3)).toBe(`retry: ${String(DRAIN_RETRY_MIN_MS)}\n\n`);
    expect(drainRetryChunk(2, 3)).toBe(`retry: ${String(DRAIN_RETRY_MAX_MS)}\n\n`);
    const middle = /^retry: (\d+)\n\n$/.exec(drainRetryChunk(1, 3))?.[1];
    expect(Number(middle)).toBeGreaterThan(DRAIN_RETRY_MIN_MS);
    expect(Number(middle)).toBeLessThan(DRAIN_RETRY_MAX_MS);
  });
});

describe('fleet control wiring (A1.1)', () => {
  it('samples on a cadence that keeps a flip inside one config TTL', () => {
    expect(LOAD_SAMPLE_MS).toBeGreaterThanOrEqual(5_000);
    expect(LOAD_SAMPLE_MS).toBeLessThanOrEqual(10_000);
  });

  it('encodes the degrade frame as a control frame with the reason and no id', () => {
    expect(degradeChunk('capacity')).toBe('event: degrade\ndata: {"reason":"capacity"}\n\n');
    expect(degradeChunk('load')).toBe('event: degrade\ndata: {"reason":"load"}\n\n');
  });

  /** A sink that records what it heard, in order, with the close as a final marker. */
  const recordingSink = (): StreamSink & { readonly heard: string[] } => {
    const heard: string[] = [];
    return {
      heard,
      write: (chunk) => {
        heard.push(chunk);
      },
      end: () => {
        heard.push('<end>');
      },
    };
  };

  const CAP = 3;

  /** The watch over a real hub and a real controller, with the samplers scripted. */
  const rig = (sseEnabled = true) => {
    const clock = new VirtualClock('2027-07-01T12:00:00Z');
    const hub = createStreamHub({ maxConnections: CAP, maxPerClient: CAP });
    const controller = createDemotionController({
      clock,
      config: {
        connectionCap: CAP,
        lagP99ThresholdMs: LAG_P99_THRESHOLD_MS,
        cpuThresholdFraction: CPU_THRESHOLD_FRACTION,
        sustainMs: SUSTAIN_MS,
        reofferMs: REOFFER_MS,
        sseEnabled,
      },
    });
    const readings = { lagP99Ms: 5 as number | null, cpuFraction: 0.2 as number | null };
    const notes: Record<string, unknown>[] = [];
    const sample = createTransportWatch({
      hub,
      controller,
      lag: { sampleP99Ms: () => readings.lagP99Ms },
      cpu: { sampleBusyFraction: () => readings.cpuFraction },
      log: {
        note: (record) => {
          notes.push(record);
        },
      },
    });
    const sinks = [recordingSink(), recordingSink()];
    sinks.forEach((sink, index) => {
      expect(hub.admit(`client-${String(index)}`, sink).kind).toBe('admitted');
    });
    /**
     * Ticks the watch as the timer would, once per `LOAD_SAMPLE_MS`, for `durationMs`. A
     * sustained window is measured from its first over-threshold sample, so a window of
     * `W` needs `W / LOAD_SAMPLE_MS + 1` samples to fire — the tests spell that out.
     */
    const tickFor = (durationMs: number): void => {
      for (let elapsed = 0; elapsed < durationMs; elapsed += LOAD_SAMPLE_MS) {
        clock.advanceMs(LOAD_SAMPLE_MS);
        sample();
      }
    };
    return { clock, hub, controller, readings, notes, sample, sinks, tickFor };
  };

  it('leaves a quiet fleet alone: no frame, no close, no log line', () => {
    const { hub, controller, notes, sinks, tickFor } = rig();
    tickFor(60 * 60_000);
    expect(controller.transport()).toBe('sse');
    expect(hub.size).toBe(2);
    expect(sinks.map((sink) => sink.heard)).toEqual([[], []]);
    expect(notes).toEqual([]);
  });

  it('on a full hub, writes the degrade frame to every stream and then closes it (capacity)', () => {
    const { hub, controller, notes, sinks, sample } = rig();
    const third = recordingSink();
    expect(hub.admit('client-2', third).kind).toBe('admitted');
    expect(hub.size).toBe(CAP);

    sample();

    expect(controller.transport()).toBe('poll');
    expect(hub.size).toBe(0);
    for (const sink of [...sinks, third]) {
      expect(sink.heard).toEqual([degradeChunk('capacity'), '<end>']);
    }
    expect(notes).toEqual([
      {
        transport: {
          demoted: {
            trigger: 'connections',
            reason: 'capacity',
            streams_closed: CAP,
            connections: CAP,
            lag_p99_ms: 5,
            cpu_fraction: 0.2,
          },
        },
      },
    ]);
  });

  it('on sustained lag, degrades with reason load and names the trigger and reading', () => {
    const { controller, notes, readings, sinks, tickFor } = rig();
    readings.lagP99Ms = 340;
    tickFor(SUSTAIN_MS);
    expect(controller.transport()).toBe('sse');
    expect(notes).toEqual([]);

    tickFor(LOAD_SAMPLE_MS);
    expect(controller.transport()).toBe('poll');
    for (const sink of sinks) expect(sink.heard).toEqual([degradeChunk('load'), '<end>']);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      transport: {
        demoted: { trigger: 'event_loop_lag', reason: 'load', streams_closed: 2, lag_p99_ms: 340 },
      },
    });
  });

  it('on sustained host CPU, degrades with reason load', () => {
    const { controller, notes, readings, tickFor } = rig();
    readings.cpuFraction = 0.93;
    tickFor(SUSTAIN_MS + LOAD_SAMPLE_MS);
    expect(controller.transport()).toBe('poll');
    expect(notes[0]).toMatchObject({
      transport: { demoted: { trigger: 'host_cpu', reason: 'load', cpu_fraction: 0.93 } },
    });
  });

  it('re-offers silently after thirty clear minutes: one log line, nothing pushed to anyone', () => {
    const { hub, controller, notes, readings, tickFor } = rig();
    readings.cpuFraction = 0.93;
    tickFor(SUSTAIN_MS + LOAD_SAMPLE_MS);
    expect(controller.transport()).toBe('poll');
    notes.splice(0);

    // A client that polls its way back in while demoted is admitted by the hub (the
    // route, not the hub, refuses while demoted) and must not be touched by the re-offer.
    const late = recordingSink();
    expect(hub.admit('client-late', late).kind).toBe('admitted');

    readings.cpuFraction = 0.2;
    tickFor(REOFFER_MS);
    expect(controller.transport()).toBe('poll');
    expect(notes).toEqual([]);

    tickFor(LOAD_SAMPLE_MS);
    expect(controller.transport()).toBe('sse');
    expect(notes).toEqual([{ transport: { re_offered: { connections: 1 } } }]);
    expect(late.heard).toEqual([]);
    expect(hub.size).toBe(1);
  });

  it('under the operator kill, starts on poll and never drains or logs', () => {
    const { controller, notes, sinks, tickFor } = rig(false);
    expect(controller.transport()).toBe('poll');
    tickFor(2 * REOFFER_MS);
    expect(controller.transport()).toBe('poll');
    expect(sinks.map((sink) => sink.heard)).toEqual([[], []]);
    expect(notes).toEqual([]);
  });
});

describe('imagery tripwire wiring (G6, ADR-001 A2.3)', () => {
  const HANDLES: ClientImageryBlock = {
    tile_url_template: 'https://tiles.example.test/imagery/tile/{z}/{y}/{x}',
    api_key: 'AAPK-test',
  };
  const temporaries: string[] = [];
  afterEach(() => {
    for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('re-reads the meter within one config TTL', () => {
    expect(IMAGERY_EVALUATE_MS).toBeLessThanOrEqual(30_000);
  });

  /**
   * The chain as `wireHealthServer` builds it — fs store, meter, watch, route — with a
   * temp state dir and a virtual clock, so a quota exhaustion is simulated exactly as it
   * would be on a staging box: by writing `usage.json`.
   */
  const rig = () => {
    const root = mkdtempSync(join(tmpdir(), 'fw-imagery-wiring-'));
    temporaries.push(root);
    mkdirSync(join(root, IMAGERY_STATE_DIR));
    const clock = new VirtualClock('2026-09-23T10:00:00Z');
    const meter = createImageryMeter({
      clock,
      config: { handles: HANDLES, ceilingTiles: 1_500_000 },
      store: createFsImageryMeterStore(root),
    });
    const notes: Record<string, unknown>[] = [];
    const watch = createImageryWatch({
      meter,
      log: { note: (record) => notes.push(record) },
    });
    /** The timer's tick, then a turn of the loop so the watch's log line has landed. */
    const tick = async (): Promise<void> => {
      watch();
      await meter.evaluate();
      await new Promise((resolve) => setImmediate(resolve));
    };
    const app = createHealthServer({
      reader: { readObservations: () => Promise.resolve([]) },
      probe: { ping: () => Promise.resolve() },
      clock,
      expected: ['firms:viirs:noaa20'],
      clientConfig: {
        document: () => {
          const block = meter.block();
          return {
            transport: 'poll',
            poll_interval_ms: 45_000,
            static_snapshot_url: null,
            ...(block === undefined ? {} : { imagery: block }),
          };
        },
      },
    });
    const document = async (): Promise<ClientConfigDocument> =>
      (await app.inject({ method: 'GET', url: CLIENT_CONFIG_PATH })).json();
    const usage = (period: string, tiles: number): void => {
      writeFileSync(
        join(root, IMAGERY_STATE_DIR, IMAGERY_USAGE_FILE),
        JSON.stringify({ period, tiles }),
      );
    };
    return { root, app, notes, tick, document, usage };
  };

  it('hides the imagery block on simulated quota exhaustion, and logs the trip once', async () => {
    const { app, notes, tick, document, usage } = rig();
    expect((await document()).imagery).toBeUndefined();

    usage('2026-09', 1_000);
    await tick();
    expect((await document()).imagery).toEqual(HANDLES);
    expect(notes).toEqual([
      {
        imagery: { state: { from: 'no_reading', to: 'enabled', period: '2026-09', tiles: 1_000 } },
      },
    ]);

    usage('2026-09', 1_500_000);
    await tick();
    expect((await document()).imagery).toBeUndefined();
    expect(notes.at(-1)).toEqual({
      imagery: { tripped: { from: 'enabled', period: '2026-09', tiles: 1_500_000 } },
    });

    // A dip does not bring it back, and says nothing.
    usage('2026-09', 10);
    await tick();
    expect((await document()).imagery).toBeUndefined();
    expect(notes).toHaveLength(2);
    await app.close();
  });

  it('brings the block back within the period only through the ops override file', async () => {
    const { root, app, tick, document, usage } = rig();
    usage('2026-09', 2_000_000);
    await tick();
    expect((await document()).imagery).toBeUndefined();

    writeFileSync(join(root, IMAGERY_STATE_DIR, imageryOverrideFile('2026-09')), '');
    await tick();
    expect((await document()).imagery).toEqual(HANDLES);
    await app.close();
  });
});
