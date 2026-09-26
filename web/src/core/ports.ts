/**
 * Platform ports. The lint rule that keeps `Date.now()` and `Math.random()` out of shipped
 * code is repo-wide (eslint `no-restricted-syntax`); the only implementations live in
 * `web/src/adapters/`, and everything else takes these as parameters — which is also what
 * makes the reconciler and the supervisor replayable in tests.
 */

export interface Clock {
  /** Wall-clock ms since epoch. Correct it with the server-time offset before comparing. */
  epochNow(): number;
  /** Monotonic ms (performance.now) — the only safe base for intervals and ages. */
  monotonicNow(): number;
}

export interface Rng {
  /** Uniform in [0, 1) — poll jitter quality, not cryptography. */
  next(): number;
}

/**
 * Epoch ms in *server* time (ADR-003 A1.6): Date header + Age + rtt/2, median of the last
 * five samples, offsets under 2 s treated as zero. Every staleness comparison uses this,
 * never the raw client clock.
 */
export type ServerNow = () => number;

/** One named SSE frame as the browser delivers it — name, `id:` cursor and raw `data:`. */
export interface StreamFrameEnvelope {
  readonly name: string;
  /** The frame's `id:` field (`EventSource.lastEventId`); empty when the frame had none. */
  readonly lastEventId: string;
  readonly data: string;
}

export interface StreamHandlers {
  onOpen(): void;
  onFrame(frame: StreamFrameEnvelope): void;
  /**
   * The connection failed or was closed by the server. The adapter reports it once and
   * stops — reconnecting is the supervisor's decision (ADR-003 A1.1: demotion is silent,
   * re-offer is hysteresis-damped), never the browser's built-in retry.
   */
  onError(): void;
}

export interface StreamConnection {
  close(): void;
}

/**
 * The SSE transport, as a port. The only implementation wraps `EventSource`
 * (`web/src/adapters/event-source.ts`); tests script frames straight into the handlers.
 * Named frames (`event.created`, `freshness`, ...) do not reach `onmessage`, so the adapter
 * must register a listener per name — the port hides that detail.
 */
export interface StreamSource {
  open(url: string, handlers: StreamHandlers): StreamConnection;
}

/**
 * Page visibility and connectivity, as a port (ADR-003 D3: "tab wake and `online` events
 * force a snapshot refetch before trusting any transport"). Each subscription returns its
 * unsubscribe function.
 */
export interface PageLifecycle {
  /** The document became visible again after being hidden. */
  onWake(callback: () => void): () => void;
  /** The browser regained connectivity. */
  onOnline(callback: () => void): () => void;
}

/**
 * The answer to one location request. Refusal and failure are separate outcomes because
 * the copy differs: a denied permission is the user's decision and must not be re-asked
 * or apologised for, while an unavailable fix is a transient failure worth retrying.
 */
export type GeoFixOutcome =
  | { readonly kind: 'fix'; readonly lon: number; readonly lat: number }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' };

/**
 * Device location, as a port.
 *
 * The coordinates it yields never leave the device: they choose where the map opens and
 * nothing else — no request carries them, no storage keeps them, no log prints them. The
 * only persisted trace is the resulting camera, at viewport precision (core/geo/camera.ts).
 *
 * `locate()` never rejects. A port whose failure mode is an exception invites a missing
 * catch on a path that only runs for users who denied permission — the outcome is data.
 */
export interface GeoLocator {
  locate(): Promise<GeoFixOutcome>;
}
