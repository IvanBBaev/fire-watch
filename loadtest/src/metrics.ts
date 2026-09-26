/**
 * The run's raw measurements: a recorder with no I/O and no clock of its own. The driver
 * hands it each outcome with the instant it happened (ms since the run started); the
 * recorder only counts. Its JSON form is what a shard writes, and {@link mergeMetrics}
 * folds shards together by addition, so a sharded run is judged on all of its requests.
 *
 * Raw header values (the edge's cache-status) are kept as they came; classifying them is
 * `evaluate.ts`'s job, so a misclassification is fixed by re-evaluating a saved report,
 * not by re-running a 50× load test.
 */

import { Histogram, type HistogramData } from './histogram.js';
import { PHASES, REQUEST_STREAMS, type PhaseName, type RequestStream } from './scenario.js';

export interface StreamPhaseStats {
  /** Requests sent. */
  issued: number;
  /** Arrivals owed but not sent because the generator's in-flight cap was reached. */
  dropped: number;
  /** Responses received (any status). */
  completed: number;
  /** Requests that ended without a response: reset, refused, timeout. */
  networkErrors: number;
  status: Record<string, number>;
  /** Raw cache-status header values, upper-cased; `(none)` when the header was absent. */
  cacheStatus: Record<string, number>;
  latency: HistogramData;
}

export interface SseStats {
  attempts: number;
  opened: number;
  /** Peak concurrently open streams. Summed across shards: an upper bound, never an under-count. */
  peakOpen: number;
  /** Non-200 answers to a stream request, by status. */
  refused: Record<string, number>;
  /** 503/429 refusals that came without a `Retry-After` header. */
  refusedWithoutRetryAfter: number;
  degradeFrames: Record<string, number>;
  /** Streams the server ended after sending a `degrade` frame (the clean T0 → T1 path). */
  cleanCloses: number;
  /** Streams the server ended without a `degrade` frame, or that errored mid-stream. */
  uncleanCloses: number;
  /** Stream requests that got no response at all. */
  networkErrors: number;
}

export interface PhaseStats {
  /** Wall time the phase actually ran, ms. */
  durationMs: number;
  streams: Record<RequestStream, StreamPhaseStats>;
  sse: SseStats;
}

export interface MetricsData {
  phases: Record<PhaseName, PhaseStats>;
  /** Arrivals the scenario owed each request stream, for the generator-health row. */
  planned: Record<RequestStream, number>;
  t2: {
    /** Oldest T2 object seen during the origin-kill phase, seconds; `null` when none was dated. */
    maxObjectAgeSeconds: number | null;
    /** T2 answers with neither `x-amz-meta-generated-at` nor `Last-Modified`. */
    undated: number;
  };
  clientConfig: {
    observations: Record<string, number>;
    /** ms from the first `degrade` frame to the first client-config answer saying `poll`. */
    flipMs: number | null;
  };
}

export function emptyStreamStats(): StreamPhaseStats {
  return {
    issued: 0,
    dropped: 0,
    completed: 0,
    networkErrors: 0,
    status: {},
    cacheStatus: {},
    latency: new Histogram().toJSON(),
  };
}

export function emptySseStats(): SseStats {
  return {
    attempts: 0,
    opened: 0,
    peakOpen: 0,
    refused: {},
    refusedWithoutRetryAfter: 0,
    degradeFrames: {},
    cleanCloses: 0,
    uncleanCloses: 0,
    networkErrors: 0,
  };
}

export function emptyMetrics(): MetricsData {
  const phases = {} as Record<PhaseName, PhaseStats>;
  for (const phase of PHASES) {
    const streams = {} as Record<RequestStream, StreamPhaseStats>;
    for (const stream of REQUEST_STREAMS) streams[stream] = emptyStreamStats();
    phases[phase] = { durationMs: 0, streams, sse: emptySseStats() };
  }
  return {
    phases,
    planned: { snapshot: 0, clientConfig: 0, t2: 0 },
    t2: { maxObjectAgeSeconds: null, undated: 0 },
    clientConfig: { observations: {}, flipMs: null },
  };
}

export interface ResponseOutcome {
  readonly status: number;
  readonly latencyMs: number;
  /** The edge's cache-status header value, or `null` when absent. */
  readonly cacheStatus: string | null;
}

/**
 * The mutable recorder the driver writes into. Histograms stay live objects until
 * {@link MetricsRecorder.toJSON} so recording is O(1).
 */
export class MetricsRecorder {
  private readonly data = emptyMetrics();
  private readonly histograms = new Map<string, Histogram>();
  private openCount = 0;
  private firstDegradeMs: number | null = null;

  setPlanned(planned: Record<RequestStream, number>): void {
    this.data.planned = { ...planned };
  }

  setPhaseDuration(phase: PhaseName, durationMs: number): void {
    this.data.phases[phase].durationMs = durationMs;
  }

  issued(phase: PhaseName, stream: RequestStream): void {
    this.data.phases[phase].streams[stream].issued += 1;
  }

  dropped(phase: PhaseName, stream: RequestStream, count = 1): void {
    this.data.phases[phase].streams[stream].dropped += count;
  }

  response(phase: PhaseName, stream: RequestStream, outcome: ResponseOutcome): void {
    const stats = this.data.phases[phase].streams[stream];
    stats.completed += 1;
    bump(stats.status, String(outcome.status));
    bump(
      stats.cacheStatus,
      outcome.cacheStatus === null ? '(none)' : outcome.cacheStatus.trim().toUpperCase(),
    );
    this.histogram(phase, stream).record(outcome.latencyMs);
  }

  networkError(phase: PhaseName, stream: RequestStream): void {
    this.data.phases[phase].streams[stream].networkErrors += 1;
  }

  t2ObjectAge(ageSeconds: number | null): void {
    if (ageSeconds === null) {
      this.data.t2.undated += 1;
      return;
    }
    const current = this.data.t2.maxObjectAgeSeconds;
    if (current === null || ageSeconds > current) this.data.t2.maxObjectAgeSeconds = ageSeconds;
  }

  clientConfigTransport(transport: string, atMs: number): void {
    bump(this.data.clientConfig.observations, transport);
    if (
      transport === 'poll' &&
      this.firstDegradeMs !== null &&
      this.data.clientConfig.flipMs === null
    ) {
      this.data.clientConfig.flipMs = Math.max(0, atMs - this.firstDegradeMs);
    }
  }

  sseAttempt(phase: PhaseName): void {
    this.data.phases[phase].sse.attempts += 1;
  }

  /** A stream answered 200 and is now open. Peak concurrency is global, attributed to `phase`. */
  sseOpened(phase: PhaseName): void {
    const sse = this.data.phases[phase].sse;
    sse.opened += 1;
    this.openCount += 1;
    if (this.openCount > sse.peakOpen) sse.peakOpen = this.openCount;
  }

  /** An open stream ended in `phase`; `clean` when the server sent `degrade` first. */
  sseClosed(phase: PhaseName, clean: boolean): void {
    this.openCount = Math.max(0, this.openCount - 1);
    const sse = this.data.phases[phase].sse;
    if (clean) sse.cleanCloses += 1;
    else sse.uncleanCloses += 1;
  }

  /** An open stream the generator itself ended (phase change, run end): neither clean nor not. */
  sseAbandoned(): void {
    this.openCount = Math.max(0, this.openCount - 1);
  }

  openStreams(): number {
    return this.openCount;
  }

  sseRefused(phase: PhaseName, status: number, hasRetryAfter: boolean): void {
    const sse = this.data.phases[phase].sse;
    bump(sse.refused, String(status));
    if ((status === 503 || status === 429) && !hasRetryAfter) sse.refusedWithoutRetryAfter += 1;
  }

  sseNetworkError(phase: PhaseName): void {
    this.data.phases[phase].sse.networkErrors += 1;
  }

  sseDegrade(phase: PhaseName, reason: string, atMs: number): void {
    bump(this.data.phases[phase].sse.degradeFrames, reason);
    if (this.firstDegradeMs === null) this.firstDegradeMs = atMs;
  }

  toJSON(): MetricsData {
    const copy = structuredClone(this.data);
    for (const [key, histogram] of this.histograms) {
      const [phase, stream] = key.split('/') as [PhaseName, RequestStream];
      copy.phases[phase].streams[stream].latency = histogram.toJSON();
    }
    return copy;
  }

  private histogram(phase: PhaseName, stream: RequestStream): Histogram {
    const key = `${phase}/${stream}`;
    let histogram = this.histograms.get(key);
    if (histogram === undefined) {
      histogram = new Histogram();
      this.histograms.set(key, histogram);
    }
    return histogram;
  }
}

/**
 * Folds shard metrics together. Counts add; phase durations take the longest shard (the
 * window the combined traffic was spread over); the oldest T2 object and the slowest
 * client-config flip win, because the gate asks about the worst case.
 */
export function mergeMetrics(parts: readonly MetricsData[]): MetricsData {
  const out = emptyMetrics();
  for (const part of parts) {
    for (const phase of PHASES) {
      const target = out.phases[phase];
      const source = part.phases[phase];
      target.durationMs = Math.max(target.durationMs, source.durationMs);
      for (const stream of REQUEST_STREAMS) {
        const t = target.streams[stream];
        const s = source.streams[stream];
        t.issued += s.issued;
        t.dropped += s.dropped;
        t.completed += s.completed;
        t.networkErrors += s.networkErrors;
        addCounts(t.status, s.status);
        addCounts(t.cacheStatus, s.cacheStatus);
        const histogram = Histogram.from(t.latency);
        histogram.merge(s.latency);
        t.latency = histogram.toJSON();
      }
      const t = target.sse;
      const s = source.sse;
      t.attempts += s.attempts;
      t.opened += s.opened;
      t.peakOpen += s.peakOpen;
      addCounts(t.refused, s.refused);
      t.refusedWithoutRetryAfter += s.refusedWithoutRetryAfter;
      addCounts(t.degradeFrames, s.degradeFrames);
      t.cleanCloses += s.cleanCloses;
      t.uncleanCloses += s.uncleanCloses;
      t.networkErrors += s.networkErrors;
    }
    for (const stream of REQUEST_STREAMS) out.planned[stream] += part.planned[stream];
    out.t2.maxObjectAgeSeconds = maxNullable(
      out.t2.maxObjectAgeSeconds,
      part.t2.maxObjectAgeSeconds,
    );
    out.t2.undated += part.t2.undated;
    addCounts(out.clientConfig.observations, part.clientConfig.observations);
    out.clientConfig.flipMs = maxNullable(out.clientConfig.flipMs, part.clientConfig.flipMs);
  }
  return out;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function addCounts(target: Record<string, number>, source: Readonly<Record<string, number>>): void {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
