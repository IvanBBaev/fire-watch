/**
 * The T0 wire contract: what a frame is, and how it is written (ADR-003 D1, D3, D4, A1.1).
 *
 * Two kinds of frame, told apart by whether they carry an `id:`:
 *
 *   * **Event frames** (`event.created`, `event.updated`, `event.status_changed`,
 *     `event.merged`) carry `id:` = the event's global `seq`. They are the only frames the
 *     ring buffer keeps and the only ones a client may replay from, and that is why the
 *     `id:` is on them and on nothing else: a browser's `EventSource` remembers the last
 *     `id:` it saw and sends it back as `Last-Event-ID`, so whatever carries an `id:`
 *     defines what "resume from here" means. A `freshness` frame with an `id:` would let
 *     a client resume from an instant no event frame corresponds to.
 *   * **Control frames** (`freshness`, `reset`, `degrade`) carry no `id:`. They describe
 *     the stream, not an event, and are never replayed.
 *
 * Every event frame's data is the *whole* feature, in the same shape `/snapshot.json`
 * serves it (D4: `seq`, `status`, the score bucket, `generated_at` — the client computes
 * neither lifecycle nor confidence). One shape for both tiers is what lets the client's
 * reconciler treat a delta and a snapshot member identically (D3 rule 2). 02 §5.7's
 * slimmer per-type payloads were the sketch; the ADR's rule is the contract.
 *
 * `data:` is always one line: the payload is a JSON value and `JSON.stringify` never emits
 * a raw newline, so the multi-line `data:` form of the SSE grammar is never needed.
 */

import type { LifecycleState } from '@fire-watch/contracts';

import type { EventFeature, SnapshotSource } from '../snapshot/snapshot-builder.js';

export const REPLAYABLE_EVENT_TYPES = [
  'event.created',
  'event.updated',
  'event.status_changed',
  'event.merged',
] as const;
export type ReplayableEventType = (typeof REPLAYABLE_EVENT_TYPES)[number];

export const CONTROL_EVENT_TYPES = ['freshness', 'reset', 'degrade'] as const;
export type ControlEventType = (typeof CONTROL_EVENT_TYPES)[number];

export type StreamEventType = ReplayableEventType | ControlEventType;

/** The payload of every event frame: the feature as the snapshot would serve it, dated. */
export interface EventFrameData {
  readonly generated_at: string;
  readonly feature: EventFeature;
  /** Set on `event.status_changed` only: the status the client is moving away from. */
  readonly previous_status?: LifecycleState;
}

export interface EventFrame {
  /** The event's `seq` — the ring buffer's key and the client's `Last-Event-ID`. */
  readonly id: number;
  readonly event: ReplayableEventType;
  readonly data: EventFrameData;
}

/** D2: every payload carries `generated_at` and per-source freshness — this is the one for T0. */
export interface FreshnessFrameData {
  readonly generated_at: string;
  /**
   * The global seq high-water mark at `generated_at`. Above a client's own mark although
   * no event frame carried it, it means a change the stream does not deliver — an event
   * leaving the map — has happened, and a snapshot is the only way to learn it.
   */
  readonly max_seq: number;
  readonly sources: readonly SnapshotSource[];
}

export type ResetReason = 'too_old' | 'unknown';

/** D3 rule 3: the client discards its store and fetches a snapshot before applying more. */
export interface ResetFrameData {
  readonly reason: ResetReason;
}

/** A1.1: sent once before the server closes a stream it will not serve again for a while. */
export interface DegradeFrameData {
  readonly reason: 'capacity' | 'load';
}

export type ControlFrame =
  | { readonly event: 'freshness'; readonly data: FreshnessFrameData }
  | { readonly event: 'reset'; readonly data: ResetFrameData }
  | { readonly event: 'degrade'; readonly data: DegradeFrameData };

export type StreamFrame = EventFrame | ControlFrame;

/** The keepalive: a comment line the browser ignores and an idle proxy does not. */
export const KEEPALIVE_CHUNK = ': hb\n\n';

export function isEventFrame(frame: StreamFrame): frame is EventFrame {
  return 'id' in frame;
}

/** One frame in the SSE grammar: `id:` for event frames, `event:`, one `data:` line, blank line. */
export function encodeFrame(frame: StreamFrame): string {
  const head = isEventFrame(frame) ? `id: ${String(frame.id)}\n` : '';
  return `${head}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/**
 * The `retry:` line — the reconnection delay the browser will use from now on. Sent on
 * connect (D1) and again, per connection, when the process drains so that a fleet of
 * clients does not reconnect in the same millisecond.
 */
export function encodeRetry(retryMs: number): string {
  if (!Number.isSafeInteger(retryMs) || retryMs < 0) {
    throw new RangeError(
      `retry must be a non-negative integer of milliseconds, got ${String(retryMs)}`,
    );
  }
  return `retry: ${String(retryMs)}\n\n`;
}
