/**
 * The T0 stream transport behind `DataFeedPort` (ADR-003 D1 T0, D3, A1.1; E2 on the
 * server side). It speaks the same `FeedMessage` vocabulary as the polling feed, so the
 * store never learns which transport a message came from; what it adds is `onSignal`,
 * the side channel the supervisor decides on.
 *
 * ## One connection, no retries
 *
 * The feed opens exactly one connection per `start()` and **never reconnects by
 * itself**. The browser's built-in `EventSource` retry loop is the wrong tool here: it
 * would hammer a `503 + Retry-After` (A1.1 "demotion is silent, re-offer is
 * hysteresis-damped"), and it would resume with a cursor the store may have moved past.
 * Reconnecting is the supervisor's decision, and it makes it on this feed's signals:
 *
 * - `{ kind: 'open' }` — the stream is up; status `'live'`.
 * - `{ kind: 'error' }` — the connect deadline passed without `open`, or the connection
 *   failed. The feed has already closed it and cleared its timers; status `'degraded'`
 *   (it is no longer delivering, but nobody has told it to stop). At most one per run.
 * - `{ kind: 'degrade', reason }` — the server asked every stream to step down. The
 *   server closes the socket right after the frame, so the feed closes first, on its
 *   side — the native retry must never meet the 503 that follows (A1.1).
 *
 * `'dead'` is reserved for `stop()`. A `start()` after a failure opens a fresh run.
 *
 * ## Cursor
 *
 * `start({ lastSeq })` sends the cursor as `?last_event_id=` — `EventSource` cannot set
 * headers, so the first cursor travels in the URL. No cursor means no query string, and
 * the route answers a cursorless client with a `reset` frame on purpose: the store
 * raises `needsSnapshot`, the coordinator answers with a full fetch, and the stream is
 * trusted only from there (D3 rule 3).
 *
 * ## Frames
 *
 * Each frame goes through the wire guard (`stream-frames.ts`). A frame that fails it is
 * **dropped, alone** — the stream goes on. One malformed frame must not cost the
 * connection, and the store's seq-gap detection already covers a change the client did
 * not get to apply. Frames that arrive after `stop()`, after a failure or after a
 * `degrade` are ignored: every run has a generation, and a handler from an older one is
 * a no-op.
 */

import type { ClientConfig } from '../config.js';
import type { Clock, StreamConnection, StreamHandlers, StreamSource } from '../ports.js';
import type { DataFeedPort, FeedMessage, FeedStatus, SseSignal } from '../types.js';
import { ParseError } from './parse-snapshot.js';
import { parseStreamFrame, type StreamFrame } from './stream-frames.js';

/** The route's first-connection cursor parameter (`server/.../stream-route.ts`). */
const CURSOR_PARAM = 'last_event_id';

/** How long a connection may sit without `open` before it counts as failed. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

export interface SseFeedOptions {
  readonly config: Pick<ClientConfig, 'streamUrl'>;
  readonly streamSource: StreamSource;
  /**
   * Accepted so both transports take the same shape of dependencies and the composition
   * root wires them alike. The stream has no time arithmetic of its own: server time is
   * the polling feed's business (A1.6), and the connect deadline is a host timer.
   */
  readonly clock: Clock;
  readonly connectTimeoutMs?: number;
}

export interface SseFeed extends DataFeedPort {
  /** The supervisor's side channel — see the module comment for the three signals. */
  onSignal(callback: (signal: SseSignal) => void): void;
}

export function createSseFeed(opts: SseFeedOptions): SseFeed {
  const { config, streamSource } = opts;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const messageCallbacks = new Set<(message: FeedMessage) => void>();
  const statusCallbacks = new Set<(status: FeedStatus) => void>();
  const signalCallbacks = new Set<(signal: SseSignal) => void>();

  let status: FeedStatus = 'connecting';
  /** Bumped on every open and every close; a handler from an older generation is a no-op. */
  let generation = 0;
  let connection: StreamConnection | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (next: FeedStatus): void => {
    if (next === status) return;
    status = next;
    for (const callback of statusCallbacks) callback(next);
  };

  const emit = (message: FeedMessage): void => {
    for (const callback of messageCallbacks) callback(message);
  };

  const signal = (value: SseSignal): void => {
    for (const callback of signalCallbacks) callback(value);
  };

  /** Close whatever is open and retire its generation; safe to call when nothing is. */
  const teardown = (): void => {
    generation += 1;
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    const open = connection;
    connection = null;
    open?.close();
  };

  const fail = (): void => {
    teardown();
    setStatus('degraded');
    signal({ kind: 'error' });
  };

  const handleFrame = (frame: StreamFrame): void => {
    switch (frame.kind) {
      case 'event':
        emit({ kind: 'delta', events: [frame.feature], generatedAt: frame.generatedAt });
        return;
      case 'freshness':
        emit({
          kind: 'stream-freshness',
          generatedAt: frame.generatedAt,
          maxSeq: frame.maxSeq,
          sources: frame.sources,
        });
        return;
      case 'reset':
        emit({ kind: 'reset' });
        return;
      case 'degrade':
        teardown();
        setStatus('degraded');
        signal({ kind: 'degrade', reason: frame.reason });
        return;
    }
  };

  const handlersFor = (gen: number): StreamHandlers => ({
    onOpen: () => {
      if (gen !== generation) return;
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      setStatus('live');
      signal({ kind: 'open' });
    },
    onFrame: (envelope) => {
      if (gen !== generation) return;
      let frame: StreamFrame;
      try {
        frame = parseStreamFrame(envelope);
      } catch (error) {
        // A malformed frame is dropped on its own; anything else is a bug and surfaces.
        if (error instanceof ParseError) return;
        throw error;
      }
      handleFrame(frame);
    },
    onError: () => {
      if (gen !== generation) return;
      fail();
    },
  });

  const streamUrl = (lastSeq: number | null): string =>
    lastSeq === null
      ? config.streamUrl
      : `${config.streamUrl}?${CURSOR_PARAM}=${encodeURIComponent(String(lastSeq))}`;

  return {
    start: ({ lastSeq }) => {
      if (connection !== null) return;
      generation += 1;
      const gen = generation;
      setStatus('connecting');
      const opened = streamSource.open(streamUrl(lastSeq), handlersFor(gen));
      if (gen !== generation) {
        // The source reported failure synchronously, from inside `open`: the run is
        // already torn down, and the handle it returned is the one thing left to close.
        opened.close();
        return;
      }
      connection = opened;
      connectTimer = setTimeout(() => {
        connectTimer = null;
        if (gen !== generation) return;
        fail();
      }, connectTimeoutMs);
    },
    stop: () => {
      teardown();
      setStatus('dead');
    },
    onMessage: (callback) => {
      messageCallbacks.add(callback);
    },
    onStatus: (callback) => {
      statusCallbacks.add(callback);
      // Late-subscriber safety: the current status is delivered immediately, so wiring
      // order between the feed and its consumers cannot lose the initial state.
      callback(status);
    },
    onSignal: (callback) => {
      signalCallbacks.add(callback);
    },
  };
}
