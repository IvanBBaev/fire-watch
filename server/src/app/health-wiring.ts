/**
 * The adapters the probe surface gets.
 *
 * Its own pool, deliberately — not the ingest pool. Two reasons, and both of them are the
 * difference between a probe that reports an outage and a probe that joins one:
 *
 *   * The ingest pool is sized at one connection and holds it for the length of a cycle.
 *     A health query queued behind a partition scan is a health query that times out while
 *     the system it is asking about is perfectly fine.
 *   * The statement timeout has to be a second, not thirty (OPERATIONS §2.2 rule 5), and a
 *     one-second cap on the ingest pool would abort legitimate archive work.
 *
 * `expected` is the set of rows this deployment claims to run. Today that is the live FIRMS
 * sources, taken from the same function the ingest cycle polls — so the endpoint cannot
 * report on a source nobody polls, and cannot go green by forgetting one.
 *
 * The snapshot (ADR-003 T1) gets a third pool, for the same reason the probes do not share
 * the ingest one: a burst of cold-cache snapshot reads queued on the probe pool's two
 * connections would make `/readyz` time out while the database is fine. Its statement
 * timeout is the read's budget, not a probe's — the active set is a few hundred rows
 * behind a partial index, and two seconds is far past what a healthy read takes while
 * still short enough that a stuck query sheds load instead of holding a connection.
 *
 * The stream (ADR-003 T0) gets a fourth, of one connection: the pump is a single serial
 * reader that never overlaps its own ticks, and sharing the snapshot pool would let a
 * cold-edge burst of snapshot reads delay the tick that every open stream is waiting on.
 * The two timers the pump needs — the tick and the keepalive — live here and not in core,
 * which is what keeps every pump test a hand-driven one. On shutdown the hub drains first
 * (a `retry:` spread over ten seconds, then the close), so that five thousand clients
 * reconnect to the next process over ten seconds rather than in the same millisecond, and
 * so that `app.close()` — which waits for active connections — has none left to wait for.
 *
 * Fleet control (ADR-003 D1 "server-side transport control", A1.1, A1.2; 04 §5.2.3) is
 * the fifth thing here. The demotion controller in core decides whether the fleet is
 * offered the stream; this module gives it what it cannot have — the event-loop and CPU
 * samplers, a timer to feed them on, the hub's size — and acts on what it answers: on a
 * demotion every open stream hears one `degrade` frame and is closed, the route refuses
 * new streams with `503 + Retry-After: 60`, and `/api/v1/client-config` says `poll` on
 * its next edge miss. On a re-offer nothing happens to anyone: the document flips back
 * to `sse` and clients find it on their next config refresh. Both are one log line.
 *
 * The imagery tripwire (ADR-001 A1.3/A2.3, G6) is the sixth, and it rides the same
 * document. The meter in core decides whether the `imagery` block is served; this module
 * gives it the fs store under the state dir and a timer, and logs every change of state.
 * A trip is the alarm A2.3 says still fires when the block goes away — one `imagery.tripped`
 * line, which is what an operator (or a meta-alert rule) keys on. Nothing is pushed to
 * clients: the block disappears on the next edge miss and a session with imagery on falls
 * back to the basemap at its next config refresh.
 */

import {
  MONITORED_SOURCE_IDS,
  isMonitoredFeedId,
  isMonitoredSourceId,
  type FreshnessRowId,
  type MonitoredSourceId,
} from '@fire-watch/contracts';
import type { Pool } from 'pg';

import { systemClock } from '../adapters/clock/system-clock.js';
import type { ZoneKeyring } from '../adapters/crypto/aes-gcm-zone-cipher.js';
import {
  createPgDatabaseProbe,
  createPgFreshnessReader,
} from '../adapters/db/pg-freshness-reader.js';
import { createPgChangeReader } from '../adapters/db/pg-change-reader.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createPgSnapshotReader } from '../adapters/db/pg-snapshot-reader.js';
import { createHealthServer } from '../adapters/http/health-server.js';
import type { ProblemLogEntry } from '../adapters/http/problem.js';
import { createFsFeedStatusStore } from '../adapters/storage/fs-feed-status-store.js';
import { createFsImageryMeterStore } from '../adapters/storage/fs-imagery-meter-store.js';
import {
  createEventLoopLagSampler,
  type EventLoopLagSampler,
} from '../adapters/system/event-loop-lag.js';
import { createHostCpuSampler, type HostCpuSampler } from '../adapters/system/host-cpu.js';
import { liveFirmsSources } from '../core/ingest/firms-poller.js';
import {
  SSE_REJECT_REASONS,
  type SseRejectReason,
  type TransportReading,
} from '../core/observability/metric-catalog.js';
import type { FreshnessObservation } from '../core/health/freshness.js';
import { createImageryMeter, type ImageryMeter } from '../core/imagery/imagery-meter.js';
import type { FreshnessReader } from '../core/ports/freshness-reader.js';
import type { ImageryMeterStore } from '../core/ports/imagery-meter-store.js';
import {
  KEEPALIVE_CHUNK,
  encodeFrame,
  encodeRetry,
  type DegradeFrameData,
} from '../core/stream/frames.js';
import { createStreamHub, drainRetryMs, type StreamHub } from '../core/stream/stream-hub.js';
import { createStreamPump } from '../core/stream/stream-pump.js';
import {
  CPU_THRESHOLD_FRACTION,
  LAG_P99_THRESHOLD_MS,
  REOFFER_MS,
  SUSTAIN_MS,
  createDemotionController,
  degradeReasonFor,
  type DemotionController,
} from '../core/transport/demotion.js';
import { wireAuthRoutes } from './auth-wiring.js';
import type { ServerConfig } from './config.js';
import { loadImageryConfig } from './imagery-config.js';
import type { ProcessLog } from './logging.js';

/** §2.2 rule 5. Half of it is the answer budget; the rest is connect, serialize and write. */
export const HEALTH_STATEMENT_TIMEOUT_MS = 1_000;

/**
 * Two: one for the request in flight, one so a slow query cannot make the *next* probe look
 * like a database outage. More would let a burst of probes become one.
 */
const HEALTH_POOL_MAX = 2;

/** See the module comment. Two is a poll with a stuck predecessor; four is a cold edge. */
const SNAPSHOT_POOL_MAX = 4;
export const SNAPSHOT_STATEMENT_TIMEOUT_MS = 2_000;

/** One serial reader; see the module comment. The seed read is the snapshot's, so its budget. */
const STREAM_POOL_MAX = 1;

/** ADR-003 D1, the T0 row: the hard cap, beyond which a connect is a 503 with `Retry-After`. */
export const STREAM_MAX_CONNECTIONS = 5_000;
/** A1.3: one person's tabs, not one person's script. Above this a connect is a 429. */
export const STREAM_MAX_PER_CLIENT = 6;
/** D1: about a thousand frames of replay before a reconnecting client needs a snapshot. */
export const STREAM_RING_CAPACITY = 1_000;
/** D1: the `retry:` sent on connect. */
export const STREAM_RETRY_MS = 5_000;
/** D1: `: hb` every 25 s, under every common idle-proxy cutoff. */
export const STREAM_KEEPALIVE_MS = 25_000;
/** How often the pump looks for changes. The lifecycle job runs on a coarser cadence. */
export const STREAM_TICK_MS = 2_000;
/** D2: a `freshness` frame at least this often, whether or not anything moved. */
export const STREAM_FRESHNESS_INTERVAL_MS = 30_000;
/** One change read's page. A burst larger than this costs round trips, not rows. */
const STREAM_BATCH_LIMIT = 200;
/** Full pages one tick may drain before it yields — a bound on how long a tick can hold the loop. */
const STREAM_MAX_BATCHES_PER_TICK = 5;
/** The spread of `retry:` values a draining process hands its clients (D1: drain semantics). */
export const DRAIN_RETRY_MIN_MS = 1_000;
export const DRAIN_RETRY_MAX_MS = 10_000;
/**
 * How often the demotion controller gets a sample (A1.1). Five seconds puts at most five
 * seconds of detection latency on the instant trigger and rounds the two sustained
 * windows up by at most one sample — well inside the "one config TTL, ≤ 30 s" a flip is
 * allowed (A1.1, L-2 criterion 1) — for one `os.cpus()` call and one histogram read.
 */
export const LOAD_SAMPLE_MS = 5_000;
/**
 * How often the imagery meter re-reads its state (G6). Thirty seconds is one config TTL:
 * a trip, a kill switch or an override is in the document within one TTL of the store
 * saying so, and the whole flip is visible fleet-wide within two. The read is four
 * `stat`s and one small file.
 */
export const IMAGERY_EVALUATE_MS = 30_000;

export interface HealthWiring {
  readonly listen: () => Promise<void>;
  readonly close: () => Promise<void>;
  /**
   * The reader and rows `/api/health/freshness` answers from, for the internal metrics
   * collector (C5). Valid until `close`, which ends the pool behind the reader.
   */
  readonly freshness: {
    readonly reader: FreshnessReader;
    readonly expected: readonly FreshnessRowId[];
  };
  /**
   * Fleet control as the metrics collector reads it (C5): the transport on offer, the
   * hub's size and the stream route's refusals so far. A plain read; it samples nothing,
   * so it cannot disturb the demotion controller's own lag and CPU windows.
   */
  readonly transport: () => TransportReading;
}

/** What the API process loaded besides `ServerConfig` and hands to the account routes. */
export interface HealthWiringOptions {
  /** `loadZonesConfig`: without it the zone and export routes are not registered (I2, I6). */
  readonly zoneKeyring?: ZoneKeyring | null;
}

export function wireHealthServer(
  config: ServerConfig,
  log: ProcessLog,
  options: HealthWiringOptions = {},
): HealthWiring {
  const pool: Pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
    max: HEALTH_POOL_MAX,
    statementTimeoutMs: HEALTH_STATEMENT_TIMEOUT_MS,
    // A probe must fail fast rather than wait out a TCP handshake against a dead host.
    connectionTimeoutMs: HEALTH_STATEMENT_TIMEOUT_MS,
  });
  const snapshotPool: Pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: `${config.applicationName}-snapshot`,
    max: SNAPSHOT_POOL_MAX,
    statementTimeoutMs: SNAPSHOT_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMs: SNAPSHOT_STATEMENT_TIMEOUT_MS,
  });
  const streamPool: Pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: `${config.applicationName}-stream`,
    max: STREAM_POOL_MAX,
    statementTimeoutMs: SNAPSHOT_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMs: SNAPSHOT_STATEMENT_TIMEOUT_MS,
  });

  const hub = createStreamHub({
    maxConnections: STREAM_MAX_CONNECTIONS,
    maxPerClient: STREAM_MAX_PER_CLIENT,
  });
  const pump = createStreamPump({
    snapshotReader: createPgSnapshotReader(streamPool),
    changeReader: createPgChangeReader(streamPool),
    hub,
    clock: systemClock,
    sources: MONITORED_SOURCE_IDS,
    ringCapacity: STREAM_RING_CAPACITY,
    batchLimit: STREAM_BATCH_LIMIT,
    maxBatchesPerTick: STREAM_MAX_BATCHES_PER_TICK,
    freshnessIntervalMs: STREAM_FRESHNESS_INTERVAL_MS,
  });
  const onProblem = (entry: ProblemLogEntry): void => {
    log.note(problemLogRecord(entry, log));
  };
  // C5: the stream route's refusals, counted here because the registry is the API's and is
  // built after this; the collector reads them through `transport`.
  const rejected = Object.fromEntries(SSE_REJECT_REASONS.map((reason) => [reason, 0])) as Record<
    SseRejectReason,
    number
  >;

  // A1.1: the controller in core, the two samplers it must not know about, and the watch
  // that feeds it on the timer below. The kill switch is the environment's, read once.
  const demotion = createDemotionController({
    clock: systemClock,
    config: {
      connectionCap: STREAM_MAX_CONNECTIONS,
      lagP99ThresholdMs: LAG_P99_THRESHOLD_MS,
      cpuThresholdFraction: CPU_THRESHOLD_FRACTION,
      sustainMs: SUSTAIN_MS,
      reofferMs: REOFFER_MS,
      sseEnabled: config.sseEnabled,
    },
  });
  const lag = createEventLoopLagSampler();
  const watchTransport = createTransportWatch({
    hub,
    controller: demotion,
    lag,
    cpu: createHostCpuSampler(),
    log,
  });

  // G6: the imagery meter. `loadConfig` validated its variables; the state-dir requirement
  // is this process's alone, and is still a ConfigError (exit code 2).
  const imageryConfig = loadImageryConfig(config);
  const imagery = createImageryMeter({
    clock: systemClock,
    config: imageryConfig,
    store:
      config.stateDir === null
        ? UNCONFIGURED_IMAGERY_STORE
        : createFsImageryMeterStore(config.stateDir),
  });
  const watchImagery = createImageryWatch({ meter: imagery, log });

  // With a state dir configured, this process answers for the C4 rows too: the worker on
  // the same VM writes `feed-status/` files there, and the fs reader answers for exactly
  // the rows the pg reader cannot (it skips registered sources; the pg reader skips
  // everything else), so combining them can never double-report a row.
  const pgReader = createPgFreshnessReader(pool);
  const reader =
    config.stateDir === null
      ? pgReader
      : combineFreshnessReaders([pgReader, createFsFeedStatusStore(config.stateDir)]);

  const expected = expectedRows(config.stateDir !== null);
  const app = createHealthServer({
    reader,
    probe: createPgDatabaseProbe(pool),
    clock: systemClock,
    expected,
    ...(config.apiClientIpHeader !== undefined ? { clientIpHeader: config.apiClientIpHeader } : {}),
    snapshot: {
      reader: createPgSnapshotReader(snapshotPool),
      clock: systemClock,
      // Every registered live source, whether or not this box polls it: the member tells a
      // consumer when each source last spoke, and a source that is silent because nobody
      // polls it should read as silent, not vanish from the list.
      sources: MONITORED_SOURCE_IDS,
      onProblem,
    },
    stream: {
      hub,
      pump,
      onProblem,
      retryMs: STREAM_RETRY_MS,
      offered: () => demotion.transport() === 'sse',
      onRefused: (reason) => {
        rejected[reason] += 1;
      },
    },
    // A1.2: the document is the fleet's transport plus the two things a client needs to
    // poll without this origin — its interval and, when one is published, the CDN copy.
    clientConfig: {
      // A2.3: the imagery block only while the meter says imagery is on; absent otherwise.
      document: () => {
        const block = imagery.block();
        return {
          transport: demotion.transport(),
          poll_interval_ms: config.clientPollIntervalMs,
          static_snapshot_url: config.staticSnapshotUrl,
          ...(block === undefined ? {} : { imagery: block }),
        };
      },
      onProblem,
    },
    // G4: served from the refresh job's state dir, so only on a box that has one.
    ...(config.stateDir === null ? {} : { effisOverlay: { stateDir: config.stateDir, onProblem } }),
  });

  // I1–I4, I6: registered only with FIRE_WATCH_AUTH_ENABLED and a complete mailer; the
  // zone and export routes also need the zone keyring (auth-wiring.ts).
  const auth = wireAuthRoutes(app, config, {
    onProblem,
    zoneKeyring: options.zoneKeyring ?? null,
  });

  // A failed tick is a log line, never a crash: the cursor stays put and the next tick
  // retries. The rendering goes through the redactor because a driver error can quote the
  // connection string.
  const tick = (): void => {
    pump.tick().catch((error: unknown) => {
      log.note({ stream: { tick_failed: log.redactor.error(error) } });
    });
  };
  const timers: ReturnType<typeof setInterval>[] = [];

  return {
    freshness: { reader, expected },
    transport: () => ({
      transport: demotion.transport(),
      connections: hub.size,
      rejected: { ...rejected },
    }),
    listen: async () => {
      await app.listen({ port: config.apiPort, host: config.apiHost });
      // Not awaited: with the database down the process must still come up, so that
      // `/readyz` can say so. The stream answers 503/`Retry-After: 5` until the seed lands.
      tick();
      timers.push(setInterval(tick, STREAM_TICK_MS));
      timers.push(
        setInterval(() => {
          hub.broadcast(KEEPALIVE_CHUNK);
        }, STREAM_KEEPALIVE_MS),
      );
      timers.push(setInterval(watchTransport, LOAD_SAMPLE_MS));
      // Not awaited either: the block stays absent until the first evaluation lands.
      watchImagery();
      timers.push(setInterval(watchImagery, IMAGERY_EVALUATE_MS));
    },
    close: async () => {
      for (const timer of timers.splice(0)) clearInterval(timer);
      lag.stop();
      hub.drain(drainRetryChunk);
      try {
        await app.close();
      } finally {
        // Unconditionally, even when the server refuses to close: pg keeps idle clients'
        // sockets ref'd, and a pool that is never ended is a process that never exits.
        await Promise.all([pool.end(), snapshotPool.end(), streamPool.end(), auth.close()]);
      }
    },
  };
}

/** The last thing the `index`-th of `total` draining clients hears: when to come back. */
export function drainRetryChunk(index: number, total: number): string {
  return encodeRetry(drainRetryMs(index, total, DRAIN_RETRY_MIN_MS, DRAIN_RETRY_MAX_MS));
}

/** The last thing a demoted stream hears (A1.1): why, and by implication "do not retry". */
export function degradeChunk(reason: DegradeFrameData['reason']): string {
  return encodeFrame({ event: 'degrade', data: { reason } });
}

export interface TransportWatchDeps {
  readonly hub: Pick<StreamHub, 'size' | 'drain'>;
  readonly controller: Pick<DemotionController, 'observe'>;
  readonly lag: Pick<EventLoopLagSampler, 'sampleP99Ms'>;
  readonly cpu: Pick<HostCpuSampler, 'sampleBusyFraction'>;
  readonly log: Pick<ProcessLog, 'note'>;
}

/**
 * One sampling tick of fleet control (A1.1): read the three things the controller
 * watches, feed them, and act on the answer. A demotion is the one moment with a side
 * effect on clients — every open stream gets the `degrade` frame and is closed, in that
 * order, which is what `hub.drain` guarantees per sink — and it is announced with the
 * trigger, the reason the clients were told, and the readings that fired it, so an
 * operator can tell a full hub from a hot box without a second log line. A re-offer is
 * silent to clients by design (the document flips; nobody is pushed) and is one line
 * here so the two events pair up in the log.
 */
export function createTransportWatch(deps: TransportWatchDeps): () => void {
  const { hub, controller, lag, cpu, log } = deps;
  return () => {
    const sample = {
      connections: hub.size,
      lagP99Ms: lag.sampleP99Ms(),
      cpuFraction: cpu.sampleBusyFraction(),
    };
    const transition = controller.observe(sample);
    if (transition === null) return;

    if (transition.type === 're-offered') {
      log.note({ transport: { re_offered: { connections: sample.connections } } });
      return;
    }
    const reason = degradeReasonFor(transition.trigger);
    const chunk = degradeChunk(reason);
    const closed = hub.size;
    hub.drain(() => chunk);
    log.note({
      transport: {
        demoted: {
          trigger: transition.trigger,
          reason,
          streams_closed: closed,
          connections: sample.connections,
          lag_p99_ms: sample.lagP99Ms,
          cpu_fraction: sample.cpuFraction,
        },
      },
    });
  };
}

/**
 * A store for the one case that never reads it: no state dir means no key (the imagery
 * config refuses a key without one), and the meter consults no store without a key.
 * Rejecting rather than answering "all clear" keeps that true if the rule ever changes.
 */
const UNCONFIGURED_IMAGERY_STORE: ImageryMeterStore = {
  read: () => Promise.reject(new Error('imagery store is not configured')),
  latchTrip: () => Promise.reject(new Error('imagery store is not configured')),
};

export interface ImageryWatchDeps {
  readonly meter: Pick<ImageryMeter, 'evaluate'>;
  readonly log: Pick<ProcessLog, 'note'>;
}

/**
 * One tick of the imagery tripwire (G6): evaluate, and turn a change of state into one log
 * line. A trip is its own line, `imagery.tripped`, because it is the alarm; every other
 * change — enabled, override, kill switch, rollover, a store that cannot be read — is an
 * `imagery.state` line naming both ends. A steady state logs nothing.
 */
export function createImageryWatch(deps: ImageryWatchDeps): () => void {
  const { meter, log } = deps;
  return () => {
    void meter.evaluate().then((transition) => {
      if (transition === null) return;
      const { from, to, period, tiles, tripped, detail } = transition;
      if (tripped) {
        log.note({ imagery: { tripped: { from, period, tiles } } });
        return;
      }
      log.note({
        imagery: {
          state: { from, to, period, tiles, ...(detail === undefined ? {} : { detail }) },
        },
      });
    });
  };
}

/**
 * The log line behind a problem+json refusal (ADR-003 A1.3): the same correlation id the
 * client was shown, the status, the route pattern, and the underlying error rendered by
 * the redactor — which is the only reason the error may appear here at all.
 */
export function problemLogRecord(
  entry: ProblemLogEntry,
  log: Pick<ProcessLog, 'redactor'>,
): Record<string, unknown> {
  return {
    problem: {
      correlation_id: entry.correlationId,
      status: entry.status,
      instance: entry.instance,
      error: log.redactor.error(entry.error),
    },
  };
}

/**
 * What this deployment is answerable for. Always the live FIRMS sources; the C4 rows —
 * the EFFIS and weather feeds and the EFFIS refresh job — only when this deployment has a
 * state dir, because that is exactly when a worker on this VM records them. Claiming them
 * on a box that runs no refresh would make its health endpoint permanently `warn` on rows
 * nobody runs, which is how a warn state stops meaning anything. Still absent because
 * nothing writes them yet: the cloud mask (C3), the backup jobs (C6), the snapshot push
 * (E3).
 */
export function expectedRows(feedsRecorded: boolean): readonly FreshnessRowId[] {
  // The filter is not defensive padding: `liveFirmsSources` speaks the registry's language,
  // which still contains `firms:modis`. A retired source must never acquire a budget by
  // accident, so the narrowing happens where the two vocabularies meet.
  const sources: readonly FreshnessRowId[] = liveFirmsSources().filter(
    (source): source is MonitoredSourceId =>
      isMonitoredFeedId(source) && isMonitoredSourceId(source),
  );
  if (!feedsRecorded) return sources;
  return [...sources, 'effis:layers', 'weather:context', 'effis-refresh'];
}

/**
 * One `FreshnessReader` out of several, for the deployment where the source rows live in
 * Postgres and the C4 rows live on disk. Each underlying reader already answers only for
 * the rows it owns (the pg reader filters to registered sources, the fs reader skips
 * them), so concatenation is safe; a throw from any reader propagates, because a partial
 * answer rendered as "the missing rows are unknown" would disguise a store outage as a
 * fleet of never-run feeds.
 */
export function combineFreshnessReaders(readers: readonly FreshnessReader[]): FreshnessReader {
  return {
    async readObservations(
      rows: readonly FreshnessRowId[],
    ): Promise<readonly FreshnessObservation[]> {
      const results = await Promise.all(readers.map((reader) => reader.readObservations(rows)));
      return results.flat();
    },
  };
}
