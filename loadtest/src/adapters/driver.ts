/**
 * The load generator: drives a {@link Scenario} against a live target with Node's own
 * `fetch` and records every outcome into a {@link MetricsRecorder}.
 *
 * ## Open model
 *
 * A 10 ms tick asks each request stream how many arrivals it owes so far
 * (`cumulativeArrivals`) and fires the difference without awaiting anything. A slow
 * target therefore meets the same arrival rate as a fast one, and the latency recorded is
 * what a real client would have seen. When the generator's own in-flight cap is reached,
 * owed arrivals are counted as `dropped`, never silently skipped: the `validity` row then
 * says whether the run delivered its load.
 *
 * ## What each stream does (mirrors the web client, web `core/feed/*`)
 *
 * * `snapshot` — once a tag is known, a draw below `mix.cursorShare` sends the cursor
 *   request `?updated_after_seq=<mark>` and a draw below `mix.conditionalShare` adds
 *   `If-None-Match`. The mark is read back from the `"v1-<maxSeq>"` ETag. Latency is to
 *   the last body byte.
 * * `clientConfig` — a plain GET; the `transport` it answers is recorded with its instant,
 *   which is how the report measures how long the fleet took to be told `poll`.
 * * `t2` — a GET of the static copy; its age comes from `x-amz-meta-generated-at`, else
 *   `Last-Modified` (E3: never `Date`/`Age`, which are the edge's clock, not the object's).
 * * SSE — a pool of slots sized by `desiredSseConnections`. A refusal waits its
 *   `Retry-After`; an open stream is read frame by frame; a `degrade` frame marks the
 *   close that follows as clean, and the slot then stays on polling until a later
 *   client-config answer offers `sse` again — which is exactly what a map client does.
 */

import { performance } from 'node:perf_hooks';

import { MetricsRecorder, type MetricsData } from '../metrics.js';
import { createRng, shardSeed, type Rng } from '../rng.js';
import {
  RATE_PROFILE,
  REQUEST_STREAMS,
  cumulativeArrivals,
  desiredSseConnections,
  plannedArrivals,
  streamRate,
  type PhaseName,
  type RequestStream,
  type Scenario,
} from '../scenario.js';
import { SseParser } from '../sse-parser.js';

/** The target's routes (server `SNAPSHOT_PATH`, `CLIENT_CONFIG_PATH`, `STREAM_PATH`). */
export const ROUTES = {
  snapshot: '/snapshot.json',
  snapshotCursorParam: 'updated_after_seq',
  clientConfig: '/api/v1/client-config',
  stream: '/api/v1/stream',
} as const;

export interface DriverOptions {
  readonly scenario: Scenario;
  /** The edge (or origin) base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** The full URL of the T2 static snapshot object; required for an origin-kill phase. */
  readonly t2Url: string | null;
  /** Lower-case name of the edge's cache-status header. */
  readonly cacheStatusHeader: string;
  readonly seed: number;
  readonly maxInFlight: number;
  readonly tickMs?: number;
  readonly requestTimeoutMs?: number;
  /** Runs before a phase starts, and is awaited — the CLI kills the origin here. */
  readonly onPhaseStart?: (phase: PhaseName) => void | Promise<void>;
  readonly log?: (line: string) => void;
}

const DEFAULT_TICK_MS = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** How long a slot waits after a refusal that named no delay, or a failed connect. */
const DEFAULT_RETRY_MS = 5_000;
/** Settling time for in-flight requests after the last phase. */
const SETTLE_MS = 2_000;

interface SnapshotState {
  mark: number | null;
  etag: string | null;
}

interface TransportObservation {
  transport: string;
  atMs: number;
}

export async function runScenario(options: DriverOptions): Promise<MetricsData> {
  const { scenario } = options;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const log = options.log ?? (() => undefined);
  const rng = createRng(shardSeed(options.seed, scenario.shard.index));
  const recorder = new MetricsRecorder();
  recorder.setPlanned({
    snapshot: plannedArrivals(scenario, 'snapshot'),
    clientConfig: plannedArrivals(scenario, 'clientConfig'),
    t2: options.t2Url === null ? 0 : plannedArrivals(scenario, 't2'),
  });

  const runStart = performance.now();
  const sinceStart = (): number => performance.now() - runStart;
  const snapshotState: SnapshotState = { mark: null, etag: null };
  const lastConfig: { value: TransportObservation | null } = { value: null };
  const pending = new Set<Promise<void>>();
  const track = (promise: Promise<void>): void => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };
  const context: RequestContext = {
    options,
    recorder,
    rng,
    timeoutMs,
    sinceStart,
    snapshotState,
    lastConfig,
  };

  const slots: SseSlot[] = [];
  let currentPhase: PhaseName = scenario.phases[0]?.name ?? 'ramp';
  const phaseNow = (): PhaseName => currentPhase;

  const settle = (): Promise<unknown> =>
    Promise.race([Promise.allSettled([...pending]), sleep(Math.max(SETTLE_MS, timeoutMs))]);

  for (const phase of scenario.phases) {
    if (phase.name === 'origin-kill') {
      // Streams and in-flight T1 requests end *before* the kill: what the kill does to
      // them is the origin dying, not the fleet being demoted, and is not what L-3 judges.
      resizeSlots(slots, 0, () => startSlot(context, phaseNow));
      await settle();
    }
    await options.onPhaseStart?.(phase.name);
    currentPhase = phase.name;
    log(`phase ${phase.name} (${phase.durationMs / 1000}s)`);
    const phaseStart = performance.now();
    const issued: Record<RequestStream, number> = { snapshot: 0, clientConfig: 0, t2: 0 };

    for (;;) {
      const elapsed = performance.now() - phaseStart;
      const last = elapsed >= phase.durationMs;
      for (const stream of REQUEST_STREAMS) {
        if (stream === 't2' && options.t2Url === null) continue;
        const owed = Math.floor(
          cumulativeArrivals(
            RATE_PROFILE[stream][phase.name],
            streamRate(scenario, stream),
            phase.durationMs,
            elapsed,
          ),
        );
        while (issued[stream] < owed) {
          if (pending.size >= options.maxInFlight) {
            recorder.dropped(phase.name, stream, owed - issued[stream]);
            issued[stream] = owed;
            break;
          }
          issued[stream] += 1;
          recorder.issued(phase.name, stream);
          track(fire(context, phase.name, stream));
        }
      }
      resizeSlots(slots, desiredSseConnections(scenario, phase, elapsed), () =>
        startSlot(context, phaseNow),
      );
      if (last) break;
      await sleep(Math.min(tickMs, phase.durationMs - elapsed));
    }
    recorder.setPhaseDuration(phase.name, performance.now() - phaseStart);
  }

  resizeSlots(slots, 0, () => startSlot(context, phaseNow));
  await settle();
  return recorder.toJSON();
}

interface RequestContext {
  readonly options: DriverOptions;
  readonly recorder: MetricsRecorder;
  readonly rng: Rng;
  readonly timeoutMs: number;
  readonly sinceStart: () => number;
  readonly snapshotState: SnapshotState;
  readonly lastConfig: { value: TransportObservation | null };
}

async function fire(ctx: RequestContext, phase: PhaseName, stream: RequestStream): Promise<void> {
  const { options, recorder, rng, snapshotState } = ctx;
  let url: string;
  const headers: Record<string, string> = {};
  if (stream === 'snapshot') {
    url = `${options.baseUrl}${ROUTES.snapshot}`;
    if (snapshotState.mark !== null && rng() < options.scenario.mix.cursorShare) {
      url += `?${ROUTES.snapshotCursorParam}=${snapshotState.mark}`;
    }
    if (snapshotState.etag !== null && rng() < options.scenario.mix.conditionalShare) {
      headers['if-none-match'] = snapshotState.etag;
    }
  } else if (stream === 'clientConfig') {
    url = `${options.baseUrl}${ROUTES.clientConfig}`;
  } else {
    url = options.t2Url ?? '';
  }

  const started = performance.now();
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(ctx.timeoutMs) });
    const body = await response.text();
    const latencyMs = performance.now() - started;
    recorder.response(phase, stream, {
      status: response.status,
      latencyMs,
      cacheStatus: response.headers.get(options.cacheStatusHeader),
    });
    if (stream === 'snapshot') {
      const etag = response.headers.get('etag');
      const mark = etag === null ? null : markOf(etag);
      if (etag !== null && mark !== null) {
        snapshotState.etag = etag;
        snapshotState.mark = mark;
      }
    } else if (stream === 'clientConfig' && response.ok) {
      const transport = transportOf(body);
      if (transport !== null) {
        const atMs = ctx.sinceStart();
        ctx.lastConfig.value = { transport, atMs };
        recorder.clientConfigTransport(transport, atMs);
      }
    } else if (stream === 't2' && response.ok) {
      recorder.t2ObjectAge(objectAgeSeconds(response.headers, Date.now()));
    }
  } catch {
    recorder.networkError(phase, stream);
  }
}

/** `"v1-1042"` (or a weak `W/"v1-1042"`) → 1042. */
export function markOf(etag: string): number | null {
  const match = /-(\d+)"$/.exec(etag);
  return match === null ? null : Number(match[1]);
}

function transportOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'transport' in parsed) {
      const transport = parsed.transport;
      return typeof transport === 'string' ? transport : null;
    }
  } catch {
    // Not JSON: not an observation.
  }
  return null;
}

/** E3: the object's own generation instant, never the edge's `Date`/`Age`. */
export function objectAgeSeconds(headers: Headers, nowMs: number): number | null {
  const stamp = headers.get('x-amz-meta-generated-at') ?? headers.get('last-modified');
  if (stamp === null) return null;
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return null;
  return Math.max(0, (nowMs - at) / 1000);
}

interface SseSlot {
  stop(): void;
}

function resizeSlots(slots: SseSlot[], desired: number, start: () => SseSlot): void {
  while (slots.length < desired) slots.push(start());
  while (slots.length > desired) slots.pop()?.stop();
}

function startSlot(ctx: RequestContext, phaseNow: () => PhaseName): SseSlot {
  const controller = new AbortController();
  const { signal } = controller;
  void (async () => {
    let degradedAtMs: number | null = null;
    while (!signal.aborted) {
      if (degradedAtMs !== null) {
        // Demoted: stay on polling until the config document offers the stream again.
        const seen = ctx.lastConfig.value;
        if (seen === null || seen.transport !== 'sse' || seen.atMs <= degradedAtMs) {
          await sleep(1_000, signal);
          continue;
        }
        degradedAtMs = null;
      }
      const outcome = await connect(ctx, phaseNow, signal);
      if (outcome.kind === 'degraded') degradedAtMs = outcome.atMs;
      else if (outcome.kind === 'retry') await sleep(outcome.afterMs, signal);
    }
  })();
  return { stop: () => controller.abort() };
}

type ConnectOutcome =
  | { readonly kind: 'degraded'; readonly atMs: number }
  | { readonly kind: 'retry'; readonly afterMs: number }
  | { readonly kind: 'stopped' };

async function connect(
  ctx: RequestContext,
  phaseNow: () => PhaseName,
  signal: AbortSignal,
): Promise<ConnectOutcome> {
  const { recorder, options } = ctx;
  recorder.sseAttempt(phaseNow());
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${ROUTES.stream}`, {
      headers: { accept: 'text/event-stream' },
      signal,
    });
  } catch {
    if (signal.aborted) return { kind: 'stopped' };
    recorder.sseNetworkError(phaseNow());
    return { kind: 'retry', afterMs: DEFAULT_RETRY_MS };
  }

  if (response.status !== 200 || response.body === null) {
    const retryAfter = response.headers.get('retry-after');
    recorder.sseRefused(phaseNow(), response.status, retryAfter !== null);
    await response.body?.cancel().catch(() => undefined);
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    return { kind: 'retry', afterMs: Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_RETRY_MS };
  }

  recorder.sseOpened(phaseNow());
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let degradedAtMs: number | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        if (frame.event === 'degrade') {
          degradedAtMs = ctx.sinceStart();
          recorder.sseDegrade(phaseNow(), reasonOf(frame.data), degradedAtMs);
        }
      }
    }
  } catch {
    if (signal.aborted) {
      recorder.sseAbandoned();
      return { kind: 'stopped' };
    }
    recorder.sseClosed(phaseNow(), false);
    return { kind: 'retry', afterMs: DEFAULT_RETRY_MS };
  }
  if (degradedAtMs !== null) {
    recorder.sseClosed(phaseNow(), true);
    return { kind: 'degraded', atMs: degradedAtMs };
  }
  recorder.sseClosed(phaseNow(), false);
  return { kind: 'retry', afterMs: DEFAULT_RETRY_MS };
}

function reasonOf(data: string): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null && 'reason' in parsed) {
      const reason = parsed.reason;
      if (typeof reason === 'string') return reason;
    }
  } catch {
    // Fall through.
  }
  return 'unknown';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(done, Math.max(0, ms));
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
