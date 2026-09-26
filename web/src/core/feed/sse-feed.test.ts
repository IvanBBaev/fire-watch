import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock, StreamFrameEnvelope, StreamHandlers, StreamSource } from '../ports.js';
import type { FeedMessage, FeedStatus, SseSignal } from '../types.js';
import { DEFAULT_CONNECT_TIMEOUT_MS, createSseFeed } from './sse-feed.js';

const STREAM_URL = '/api/v1/stream';

const CLOCK: Clock = { epochNow: () => 0, monotonicNow: () => 0 };

interface OpenedConnection {
  readonly url: string;
  readonly handlers: StreamHandlers;
  closeCalls: number;
}

/**
 * A scripted `StreamSource`: records every `open`, exposes the handlers so a test can
 * play frames straight into the feed, and counts `close` calls per connection.
 */
function stubStreamSource(onOpen?: (handlers: StreamHandlers) => void): {
  readonly source: StreamSource;
  readonly opened: OpenedConnection[];
  last(): OpenedConnection;
} {
  const opened: OpenedConnection[] = [];
  return {
    source: {
      open: (url, handlers) => {
        const entry: OpenedConnection = { url, handlers, closeCalls: 0 };
        opened.push(entry);
        onOpen?.(handlers);
        return {
          close: () => {
            entry.closeCalls += 1;
          },
        };
      },
    },
    opened,
    last: () => {
      const entry = opened.at(-1);
      if (entry === undefined) throw new Error('no connection was opened');
      return entry;
    },
  };
}

/** A wire feature exactly as `/snapshot.json` serves one (the shape E2 frames carry). */
function wireFeature(seq: number): Record<string, unknown> {
  return {
    type: 'Feature',
    id: 'fw-2026-q7f3d',
    geometry: { type: 'Point', coordinates: [25.9, 41.93] },
    properties: {
      id: 'fw-2026-q7f3d',
      seq,
      status: 'active',
      score_bucket: 'confirmed',
      merged_into: null,
      first_observed_at: '2026-08-07T11:14:00Z',
      last_observed_at: '2026-08-09T09:47:00Z',
      detection_count: 14,
      place_name_bg: 'Харманли',
      place_name_en: 'Harmanli',
      area_ha: 320,
      next_pass_window: null,
    },
  };
}

const GENERATED_AT = '2026-08-09T09:58:00Z';

function eventFrame(name: string, seq: number): StreamFrameEnvelope {
  return {
    name,
    lastEventId: String(seq),
    data: JSON.stringify({ generated_at: GENERATED_AT, feature: wireFeature(seq) }),
  };
}

function controlFrame(name: string, data: unknown): StreamFrameEnvelope {
  return { name, lastEventId: '', data: JSON.stringify(data) };
}

/** A feed under test with every observable channel recorded. */
function harness(options: { connectTimeoutMs?: number; failOnOpen?: boolean } = {}) {
  const stream = stubStreamSource(
    options.failOnOpen === true ? (handlers) => handlers.onError() : undefined,
  );
  const feed = createSseFeed({
    config: { streamUrl: STREAM_URL },
    streamSource: stream.source,
    clock: CLOCK,
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
  });
  const messages: FeedMessage[] = [];
  const statuses: FeedStatus[] = [];
  const signals: SseSignal[] = [];
  feed.onMessage((message) => messages.push(message));
  feed.onStatus((status) => statuses.push(status));
  feed.onSignal((signal) => signals.push(signal));
  return { feed, stream, messages, statuses, signals };
}

describe('createSseFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connecting', () => {
    it('opens the stream with the cursor as ?last_event_id=', () => {
      const { feed, stream } = harness();
      feed.start({ lastSeq: 1042 });
      expect(stream.last().url).toBe(`${STREAM_URL}?last_event_id=1042`);
    });

    it('opens the bare stream URL without a cursor (the route answers with a reset)', () => {
      const { feed, stream } = harness();
      feed.start({ lastSeq: null });
      expect(stream.last().url).toBe(STREAM_URL);
    });

    it('starts connecting and goes live with an open signal on onOpen', () => {
      const { feed, stream, statuses, signals } = harness();
      feed.start({ lastSeq: 1 });
      expect(statuses).toEqual(['connecting']);

      stream.last().handlers.onOpen();
      expect(statuses).toEqual(['connecting', 'live']);
      expect(signals).toEqual([{ kind: 'open' }]);
    });

    it('is idempotent while a connection is open or pending', () => {
      const { feed, stream } = harness();
      feed.start({ lastSeq: 1 });
      feed.start({ lastSeq: 2 });
      stream.last().handlers.onOpen();
      feed.start({ lastSeq: 3 });
      expect(stream.opened).toHaveLength(1);
    });

    it('closes the connection, turns degraded and signals error when open never comes', () => {
      const { feed, stream, statuses, signals } = harness({ connectTimeoutMs: 5_000 });
      feed.start({ lastSeq: 1 });

      vi.advanceTimersByTime(4_999);
      expect(stream.last().closeCalls).toBe(0);
      expect(signals).toEqual([]);

      vi.advanceTimersByTime(1);
      expect(stream.last().closeCalls).toBe(1);
      expect(statuses).toEqual(['connecting', 'degraded']);
      expect(signals).toEqual([{ kind: 'error' }]);
    });

    it('defaults the connect deadline to 20 s', () => {
      const { feed, signals } = harness();
      feed.start({ lastSeq: 1 });
      vi.advanceTimersByTime(DEFAULT_CONNECT_TIMEOUT_MS - 1);
      expect(signals).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(signals).toEqual([{ kind: 'error' }]);
    });

    it('cancels the connect deadline once the stream is open', () => {
      const { feed, stream, signals, statuses } = harness({ connectTimeoutMs: 5_000 });
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onOpen();

      vi.advanceTimersByTime(60_000);
      expect(stream.last().closeCalls).toBe(0);
      expect(signals).toEqual([{ kind: 'open' }]);
      expect(statuses).toEqual(['connecting', 'live']);
    });
  });

  describe('failure', () => {
    it('closes, turns degraded and signals error once on onError', () => {
      const { feed, stream, statuses, signals } = harness();
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onOpen();

      stream.last().handlers.onError();
      stream.last().handlers.onError();
      expect(stream.last().closeCalls).toBe(1);
      expect(statuses).toEqual(['connecting', 'live', 'degraded']);
      expect(signals).toEqual([{ kind: 'open' }, { kind: 'error' }]);
    });

    it('never signals error twice for one run — a late timeout after onError is inert', () => {
      const { feed, stream, signals } = harness({ connectTimeoutMs: 5_000 });
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onError();
      vi.advanceTimersByTime(10_000);
      expect(signals).toEqual([{ kind: 'error' }]);
      expect(stream.last().closeCalls).toBe(1);
    });

    it('never reconnects by itself after a failure', () => {
      const { feed, stream } = harness({ connectTimeoutMs: 5_000 });
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onError();
      vi.advanceTimersByTime(10 * 60_000);
      expect(stream.opened).toHaveLength(1);
    });

    it('survives a source that fails synchronously from inside open', () => {
      const { feed, stream, statuses, signals } = harness({ failOnOpen: true });
      feed.start({ lastSeq: 1 });
      expect(stream.last().closeCalls).toBe(1);
      expect(statuses).toEqual(['connecting', 'degraded']);
      expect(signals).toEqual([{ kind: 'error' }]);

      // Nothing is left pending: the deadline must not fire a second error later.
      vi.advanceTimersByTime(DEFAULT_CONNECT_TIMEOUT_MS + 1);
      expect(signals).toEqual([{ kind: 'error' }]);
    });

    it('lets stop() after a failure settle on dead', () => {
      const { feed, stream, statuses } = harness();
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onError();
      feed.stop();
      expect(statuses).toEqual(['connecting', 'degraded', 'dead']);
      expect(stream.last().closeCalls).toBe(1);
    });

    it('opens a fresh run on start() after a failure', () => {
      const { feed, stream, statuses, signals } = harness();
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onError();

      feed.start({ lastSeq: 7 });
      expect(stream.opened).toHaveLength(2);
      expect(stream.last().url).toBe(`${STREAM_URL}?last_event_id=7`);
      stream.last().handlers.onOpen();
      expect(statuses).toEqual(['connecting', 'degraded', 'connecting', 'live']);
      expect(signals).toEqual([{ kind: 'error' }, { kind: 'open' }]);
    });
  });

  describe('frames', () => {
    it.each([['event.created'], ['event.updated'], ['event.status_changed'], ['event.merged']])(
      'maps %s to a one-event delta stamped with the frame generated_at',
      (name) => {
        const { feed, stream, messages } = harness();
        feed.start({ lastSeq: 1 });
        stream.last().handlers.onOpen();

        stream.last().handlers.onFrame(eventFrame(name, 43));
        expect(messages).toEqual([
          {
            kind: 'delta',
            generatedAt: GENERATED_AT,
            events: [expect.objectContaining({ id: 'fw-2026-q7f3d', seq: 43, status: 'active' })],
          },
        ]);
      },
    );

    it('maps freshness to stream-freshness', () => {
      const { feed, stream, messages } = harness();
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onFrame(
        controlFrame('freshness', {
          generated_at: GENERATED_AT,
          max_seq: 1042,
          sources: [{ source_id: 'firms:viirs:snpp', last_observed_at: null }],
        }),
      );
      expect(messages).toEqual([
        {
          kind: 'stream-freshness',
          generatedAt: GENERATED_AT,
          maxSeq: 1042,
          sources: [{ sourceId: 'firms:viirs:snpp', lastObservedAt: null }],
        },
      ]);
    });

    it('maps reset to a reset message and keeps the stream open', () => {
      const { feed, stream, messages, statuses } = harness();
      feed.start({ lastSeq: null });
      stream.last().handlers.onOpen();
      stream.last().handlers.onFrame(controlFrame('reset', { reason: 'unknown' }));
      expect(messages).toEqual([{ kind: 'reset' }]);
      expect(stream.last().closeCalls).toBe(0);
      expect(statuses).toEqual(['connecting', 'live']);
    });

    it('closes on degrade before the server does, turns degraded and signals the reason', () => {
      const { feed, stream, messages, statuses, signals } = harness();
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onOpen();

      stream.last().handlers.onFrame(controlFrame('degrade', { reason: 'capacity' }));
      expect(stream.last().closeCalls).toBe(1);
      expect(statuses).toEqual(['connecting', 'live', 'degraded']);
      expect(signals).toEqual([{ kind: 'open' }, { kind: 'degrade', reason: 'capacity' }]);
      expect(messages).toEqual([]);

      // The socket the server then drops must not read as a second failure.
      stream.last().handlers.onError();
      expect(signals).toHaveLength(2);
      expect(stream.last().closeCalls).toBe(1);
    });

    it('drops a malformed frame on its own and keeps delivering', () => {
      const { feed, stream, messages, statuses, signals } = harness();
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onOpen();

      stream.last().handlers.onFrame({ name: 'event.updated', lastEventId: '5', data: '{oops' });
      stream.last().handlers.onFrame({ name: 'hb', lastEventId: '', data: '' });
      stream.last().handlers.onFrame(eventFrame('event.updated', 44));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ kind: 'delta' });
      expect(statuses).toEqual(['connecting', 'live']);
      expect(signals).toEqual([{ kind: 'open' }]);
      expect(stream.last().closeCalls).toBe(0);
    });

    it('rethrows a non-parse failure from a message consumer instead of swallowing it', () => {
      const { feed, stream } = harness();
      feed.onMessage(() => {
        throw new Error('consumer bug');
      });
      feed.start({ lastSeq: 1 });
      expect(() => stream.last().handlers.onFrame(eventFrame('event.created', 2))).toThrow(
        'consumer bug',
      );
    });
  });

  describe('stop and restart', () => {
    it('closes the connection, clears the deadline and turns dead; idempotent', () => {
      const { feed, stream, statuses, signals } = harness({ connectTimeoutMs: 5_000 });
      feed.start({ lastSeq: 1 });
      feed.stop();
      feed.stop();

      expect(stream.last().closeCalls).toBe(1);
      expect(statuses).toEqual(['connecting', 'dead']);
      vi.advanceTimersByTime(10_000);
      expect(signals).toEqual([]);
    });

    it('ignores frames, open and error arriving after stop()', () => {
      const { feed, stream, messages, statuses, signals } = harness();
      feed.start({ lastSeq: 1 });
      const { handlers } = stream.last();
      feed.stop();

      handlers.onOpen();
      handlers.onFrame(eventFrame('event.created', 2));
      handlers.onError();
      expect(messages).toEqual([]);
      expect(signals).toEqual([]);
      expect(statuses).toEqual(['connecting', 'dead']);
      expect(stream.last().closeCalls).toBe(1);
    });

    it('ignores frames from a connection that has already been closed', () => {
      const { feed, stream, messages } = harness();
      feed.start({ lastSeq: 1 });
      const stale = stream.last();
      stale.handlers.onError();

      feed.start({ lastSeq: 9 });
      stale.handlers.onFrame(eventFrame('event.created', 10));
      expect(messages).toEqual([]);

      stream.last().handlers.onFrame(eventFrame('event.created', 10));
      expect(messages).toHaveLength(1);
    });

    it('restarts after stop() with a new connection at the new cursor', () => {
      const { feed, stream, statuses } = harness();
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onOpen();
      feed.stop();

      feed.start({ lastSeq: 55 });
      expect(stream.opened).toHaveLength(2);
      expect(stream.last().url).toBe(`${STREAM_URL}?last_event_id=55`);
      expect(stream.opened[0]?.closeCalls).toBe(1);
      expect(stream.last().closeCalls).toBe(0);
      expect(statuses).toEqual(['connecting', 'live', 'dead', 'connecting']);
    });
  });

  describe('subscriptions', () => {
    it('delivers the current status immediately to a late subscriber', () => {
      const { feed, stream } = harness();
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onOpen();

      const late: FeedStatus[] = [];
      feed.onStatus((status) => late.push(status));
      expect(late).toEqual(['live']);

      feed.stop();
      expect(late).toEqual(['live', 'dead']);
    });

    it('reports connecting to a subscriber attached before start()', () => {
      const stream = stubStreamSource();
      const feed = createSseFeed({
        config: { streamUrl: STREAM_URL },
        streamSource: stream.source,
        clock: CLOCK,
      });
      const seen: FeedStatus[] = [];
      feed.onStatus((status) => seen.push(status));
      expect(seen).toEqual(['connecting']);
    });

    it('does not replay signals or messages to late subscribers', () => {
      const { feed, stream } = harness();
      feed.start({ lastSeq: 1 });
      stream.last().handlers.onOpen();
      stream.last().handlers.onFrame(eventFrame('event.created', 2));

      const signals: SseSignal[] = [];
      const messages: FeedMessage[] = [];
      feed.onSignal((signal) => signals.push(signal));
      feed.onMessage((message) => messages.push(message));
      expect(signals).toEqual([]);
      expect(messages).toEqual([]);
    });
  });
});
