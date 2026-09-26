import { describe, expect, it } from 'vitest';

import type {
  FeedMessage,
  FeedStatus,
  FireEventStore,
  PollOutcome,
  Snapshot,
  SseSignal,
  StoreState,
} from '../types.js';
import {
  createFeedCoordinator,
  type CoordinatedPolling,
  type CoordinatedStream,
} from './feed-coordinator.js';
import { createTransportSupervisor, type SupervisorConfig } from './supervisor.js';

const MINUTE = 60_000;
const SERVER_T0 = Date.parse('2026-07-14T10:00:00Z');

const CONFIG: SupervisorConfig = {
  pollIntervalMs: 45_000,
  staticFlipStaleMs: 5 * MINUTE,
  hysteresisMs: 30 * MINUTE,
  sseEnabled: true,
};

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  generatedAt: '2026-07-14T10:00:00Z',
  maxSeq: 7,
  partial: false,
  events: [],
  sources: [],
};

/** A store double that records what reaches it and lets a test raise `needsSnapshot`. */
function fakeStore() {
  const listeners = new Set<() => void>();
  let state: StoreState = {
    events: new Map(),
    maxSeq: 0,
    lastSnapshotAt: null,
    freshness: null,
    feedStatus: 'connecting',
    needsSnapshot: false,
    sources: [],
  };
  const messages: FeedMessage[] = [];
  const statuses: FeedStatus[] = [];
  let acknowledged = 0;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const store: FireEventStore = {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (message) => {
      messages.push(message);
      if (message.kind === 'snapshot') {
        state = { ...state, maxSeq: message.snapshot.maxSeq };
        notify();
      }
    },
    setFeedStatus: (status) => {
      statuses.push(status);
      state = { ...state, feedStatus: status };
    },
    acknowledgeSnapshotNeed: () => {
      acknowledged += 1;
      state = { ...state, needsSnapshot: false };
      notify(); // synchronous, reentrant — the coordinator must stay quiet
    },
  };
  return {
    store,
    messages,
    statuses,
    acknowledged: () => acknowledged,
    raiseNeed: () => {
      state = { ...state, needsSnapshot: true };
      notify();
    },
    setMaxSeq: (maxSeq: number) => {
      state = { ...state, maxSeq };
    },
  };
}

function fakePolling() {
  const calls: string[] = [];
  let onMessage: (m: FeedMessage) => void = () => {};
  let onStatus: (s: FeedStatus) => void = () => {};
  let onOutcome: (o: PollOutcome) => void = () => {};
  const feed: CoordinatedPolling = {
    start: (cursor) => {
      calls.push(`start:${String(cursor.lastSeq)}:${cursor.cadence ?? 'poll'}`);
    },
    stop: () => {
      calls.push('stop');
    },
    refetchNow: () => {
      calls.push('refetch');
    },
    setTier: (tier) => {
      calls.push(`tier:${tier}`);
    },
    onMessage: (cb) => {
      onMessage = cb;
    },
    onStatus: (cb) => {
      onStatus = cb;
    },
    onOutcome: (cb) => {
      onOutcome = cb;
    },
  };
  return {
    feed,
    calls,
    emitMessage: (m: FeedMessage) => onMessage(m),
    emitStatus: (s: FeedStatus) => onStatus(s),
    emitOutcome: (o: PollOutcome) => onOutcome(o),
  };
}

function fakeStream() {
  const calls: string[] = [];
  let onMessage: (m: FeedMessage) => void = () => {};
  let onStatus: (s: FeedStatus) => void = () => {};
  let onSignal: (s: SseSignal) => void = () => {};
  const feed: CoordinatedStream = {
    start: (cursor) => {
      calls.push(`start:${String(cursor.lastSeq)}`);
    },
    stop: () => {
      calls.push('stop');
    },
    onMessage: (cb) => {
      onMessage = cb;
    },
    onStatus: (cb) => {
      onStatus = cb;
    },
    onSignal: (cb) => {
      onSignal = cb;
    },
  };
  return {
    feed,
    calls,
    emitMessage: (m: FeedMessage) => onMessage(m),
    emitStatus: (s: FeedStatus) => onStatus(s),
    emitSignal: (s: SseSignal) => onSignal(s),
  };
}

function fakeLifecycle() {
  const wake = new Set<() => void>();
  const online = new Set<() => void>();
  return {
    lifecycle: {
      onWake: (cb: () => void) => {
        wake.add(cb);
        return () => {
          wake.delete(cb);
        };
      },
      onOnline: (cb: () => void) => {
        online.add(cb);
        return () => {
          online.delete(cb);
        };
      },
    },
    wake: () => {
      for (const cb of wake) cb();
    },
    online: () => {
      for (const cb of online) cb();
    },
    subscribers: () => wake.size + online.size,
  };
}

const ok: PollOutcome = { kind: 'ok', tier: 'T1', full: true, generatedAt: null };
const unusable: PollOutcome = { kind: 'unusable', tier: 'T1', status: 503, retryAfterMs: null };

function setup(config: SupervisorConfig = CONFIG, withStream = true) {
  let mono = 0;
  const clock = { epochNow: () => 0, monotonicNow: () => mono };
  const supervisor = createTransportSupervisor({
    clock,
    serverNow: () => SERVER_T0 + mono,
    config,
  });
  const store = fakeStore();
  const polling = fakePolling();
  const stream = fakeStream();
  const lifecycle = fakeLifecycle();
  const coordinator = createFeedCoordinator({
    store: store.store,
    polling: polling.feed,
    stream: withStream ? stream.feed : null,
    supervisor,
    lifecycle: lifecycle.lifecycle,
  });
  return {
    coordinator,
    supervisor,
    store,
    polling,
    stream,
    lifecycle,
    advance: (ms: number) => {
      mono += ms;
    },
  };
}

describe('createFeedCoordinator', () => {
  it('start boots the supervisor, which starts the poller with a full fetch', () => {
    const t = setup();
    t.coordinator.start();
    expect(t.supervisor.state()).toBe('POLLING');
    expect(t.polling.calls).toEqual(['start:null:poll']);
    expect(t.stream.calls).toEqual([]);
  });

  it('forwards messages from both transports to the store', () => {
    const t = setup();
    t.coordinator.start();
    t.polling.emitMessage({ kind: 'snapshot', snapshot: SNAPSHOT });
    t.stream.emitMessage({ kind: 'reset' });
    expect(t.store.messages.map((m) => m.kind)).toEqual(['snapshot', 'reset']);
  });

  it('opens the stream from the store mark on the first healthy poll, then moves to safety cadence', () => {
    const t = setup();
    t.coordinator.start();
    t.polling.emitMessage({ kind: 'snapshot', snapshot: SNAPSHOT });
    t.polling.emitOutcome(ok);
    expect(t.supervisor.state()).toBe('SSE_CONNECTING');
    expect(t.stream.calls).toEqual(['start:7']);
    t.stream.emitSignal({ kind: 'open' });
    expect(t.supervisor.state()).toBe('SSE_LIVE');
    expect(t.polling.calls).toEqual(['start:null:poll', 'start:null:safety']);
  });

  it('opens the stream without a cursor when the store holds nothing', () => {
    const t = setup();
    t.coordinator.start();
    t.polling.emitOutcome(ok);
    expect(t.stream.calls).toEqual(['start:null']);
  });

  it('on a stream error closes it and restarts the poller with a full fetch', () => {
    const t = setup();
    t.coordinator.start();
    t.polling.emitOutcome(ok);
    t.stream.emitSignal({ kind: 'open' });
    t.stream.emitSignal({ kind: 'error' });
    expect(t.supervisor.state()).toBe('POLLING');
    expect(t.stream.calls).toEqual(['start:null', 'stop']);
    expect(t.polling.calls.at(-1)).toBe('start:null:poll');
  });

  it('applies tier effects to the poller', () => {
    const t = setup({ ...CONFIG, sseEnabled: false });
    t.coordinator.start();
    for (let i = 0; i < 3; i += 1) {
      t.polling.emitOutcome(unusable);
      t.advance(CONFIG.pollIntervalMs);
    }
    expect(t.supervisor.state()).toBe('STATIC_FALLBACK');
    expect(t.polling.calls).toEqual(['start:null:poll', 'tier:T2']);
    t.polling.emitOutcome(ok);
    t.advance(CONFIG.hysteresisMs);
    t.polling.emitOutcome(ok);
    expect(t.polling.calls.at(-1)).toBe('tier:T1');
  });

  it('turns a needsSnapshot rising edge into acknowledge + one forced refetch', () => {
    const t = setup();
    t.coordinator.start();
    t.store.raiseNeed();
    expect(t.store.acknowledged()).toBe(1);
    expect(t.polling.calls.filter((c) => c === 'refetch')).toHaveLength(1);
    // Level stays high or is re-notified: nothing more happens until the flag drops and rises.
    t.store.raiseNeed();
    t.store.raiseNeed();
    expect(t.store.acknowledged()).toBe(3);
    expect(t.polling.calls.filter((c) => c === 'refetch')).toHaveLength(3);
  });

  it('a stream reset that raises needsSnapshot forces a full fetch while live', () => {
    const t = setup();
    t.coordinator.start();
    t.polling.emitOutcome(ok);
    t.stream.emitSignal({ kind: 'open' });
    t.store.raiseNeed();
    expect(t.supervisor.state()).toBe('SSE_LIVE');
    expect(t.polling.calls.at(-1)).toBe('refetch');
  });

  it('wake and online force a refetch through the supervisor', () => {
    const t = setup();
    t.coordinator.start();
    t.lifecycle.wake();
    t.lifecycle.online();
    expect(t.polling.calls).toEqual(['start:null:poll', 'refetch', 'refetch']);
  });

  it('publishes the poller status except while the stream is live', () => {
    const t = setup();
    t.coordinator.start();
    t.polling.emitStatus('live');
    t.stream.emitStatus('degraded'); // not trusted yet
    expect(t.store.store.state().feedStatus).toBe('live');
    t.polling.emitOutcome(ok);
    t.stream.emitSignal({ kind: 'open' });
    t.stream.emitStatus('live');
    t.polling.emitStatus('degraded'); // the safety poller's opinion does not show while live
    expect(t.store.store.state().feedStatus).toBe('live');
    t.stream.emitSignal({ kind: 'error' });
    // Back on polling: its last status is the truth again.
    expect(t.store.store.state().feedStatus).toBe('degraded');
  });

  it('works with no stream at all', () => {
    const t = setup(CONFIG, false);
    t.coordinator.start();
    t.polling.emitOutcome(ok);
    // The supervisor still "offers" (config says enabled) but there is nothing to open.
    expect(t.supervisor.state()).toBe('SSE_CONNECTING');
    expect(t.stream.calls).toEqual([]);
  });

  it('stop unsubscribes everything and stops both transports; outcomes after stop are ignored', () => {
    const t = setup();
    t.coordinator.start();
    t.polling.emitOutcome(ok);
    expect(t.lifecycle.subscribers()).toBe(2);
    t.coordinator.stop();
    expect(t.lifecycle.subscribers()).toBe(0);
    expect(t.stream.calls.at(-1)).toBe('stop');
    expect(t.polling.calls.at(-1)).toBe('stop');
    const before = t.supervisor.snapshot();
    t.stream.emitSignal({ kind: 'error' });
    t.polling.emitOutcome(unusable);
    t.store.raiseNeed();
    expect(t.supervisor.snapshot()).toBe(before);
    expect(t.store.acknowledged()).toBe(0);
  });

  it('start and stop are idempotent', () => {
    const t = setup();
    t.coordinator.start();
    t.coordinator.start();
    expect(t.polling.calls).toEqual(['start:null:poll']);
    t.coordinator.stop();
    t.coordinator.stop();
    expect(t.polling.calls.filter((c) => c === 'stop')).toHaveLength(1);
  });
});
