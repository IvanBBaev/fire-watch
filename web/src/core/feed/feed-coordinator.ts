/**
 * The feed coordinator: the one place where the store, the two transports, the transport
 * supervisor and the page lifecycle meet (ADR-003 D3, review 08 §5.2.3/§5.2.4). It owns
 * no policy — the supervisor decides, the reconciler decides — it only wires:
 *
 * - every message from either transport goes to `store.dispatch`;
 * - every poll outcome and every stream signal goes to the supervisor;
 * - every supervisor effect becomes a call on the transport it names;
 * - the store's `needsSnapshot` rising edge (a seq gap, a stream `reset`) becomes one
 *   forced full fetch, acknowledged first so a reentrant notification stays quiet;
 * - tab wake and `online` become supervisor inputs (D3: "force a snapshot refetch before
 *   trusting any transport").
 *
 * Feed status shown to the user follows the transport the supervisor trusts: the stream
 * while `SSE_LIVE`, the poller otherwise. The user never learns which tier they are on
 * (D2/A1.1) — status is `connecting | live | degraded | dead`, never "polling".
 */

import type { PageLifecycle } from '../ports.js';
import type {
  DataFeedPort,
  FeedStatus,
  FireEventStore,
  PollCadence,
  PollOutcome,
  PollingTier,
  SseSignal,
} from '../types.js';
import type { SupervisorEffect, TransportSupervisor } from './supervisor.js';

/** What the coordinator needs from the poller — the `PollingFeed` surface it drives. */
export interface CoordinatedPolling extends DataFeedPort {
  start(cursor: { readonly lastSeq: number | null; readonly cadence?: PollCadence }): void;
  refetchNow(): void;
  setTier(tier: PollingTier): void;
  onOutcome(callback: (outcome: PollOutcome) => void): void;
}

/** What the coordinator needs from the stream — the `SseFeed` surface it drives. */
export interface CoordinatedStream extends DataFeedPort {
  onSignal(callback: (signal: SseSignal) => void): void;
}

export interface FeedCoordinatorDeps {
  readonly store: FireEventStore;
  readonly polling: CoordinatedPolling;
  /** `null` when the build ships no stream at all; `sseEnabled: false` also never opens one. */
  readonly stream: CoordinatedStream | null;
  readonly supervisor: TransportSupervisor;
  readonly lifecycle: PageLifecycle;
}

export interface FeedCoordinator {
  start(): void;
  stop(): void;
}

export function createFeedCoordinator(deps: FeedCoordinatorDeps): FeedCoordinator {
  const { store, polling, stream, supervisor, lifecycle } = deps;
  let pollingStatus: FeedStatus = 'connecting';
  let streamStatus: FeedStatus = 'connecting';
  let running = false;
  let subscriptions: Array<() => void> = [];

  const publishStatus = () => {
    store.setFeedStatus(supervisor.state() === 'SSE_LIVE' ? streamStatus : pollingStatus);
  };

  /** The stream resumes from the store's mark; a mark of 0 holds nothing worth resuming. */
  const streamCursor = () => {
    const { maxSeq } = store.state();
    return { lastSeq: maxSeq > 0 ? maxSeq : null };
  };

  const applyEffect = (effect: SupervisorEffect) => {
    switch (effect.type) {
      case 'poll':
        polling.start({ lastSeq: null, cadence: effect.cadence });
        return;
      case 'set-tier':
        polling.setTier(effect.tier);
        return;
      case 'open-stream':
        stream?.start(streamCursor());
        return;
      case 'close-stream':
        stream?.stop();
        return;
      case 'refetch':
        polling.refetchNow();
        return;
    }
  };

  // Registered once: the feeds keep their callbacks across start/stop cycles.
  polling.onMessage((message) => {
    store.dispatch(message);
  });
  polling.onStatus((status) => {
    pollingStatus = status;
    publishStatus();
  });
  polling.onOutcome((outcome) => {
    if (running) supervisor.dispatch({ type: 'poll', outcome });
  });
  stream?.onMessage((message) => {
    store.dispatch(message);
  });
  stream?.onStatus((status) => {
    streamStatus = status;
    publishStatus();
  });
  stream?.onSignal((signal) => {
    if (running) supervisor.dispatch({ type: 'stream', signal });
  });

  return {
    start: () => {
      if (running) return;
      running = true;
      // Edge-triggered on purpose: the store notifies on every change and
      // `acknowledgeSnapshotNeed()` notifies synchronously, so a level check would refetch
      // once per notification instead of once per gap.
      let previousNeed = store.state().needsSnapshot;
      subscriptions = [
        supervisor.onEffect(applyEffect),
        supervisor.onTransition(publishStatus),
        store.subscribe(() => {
          const need = store.state().needsSnapshot;
          const rising = need && !previousNeed;
          previousNeed = need;
          if (!rising) return;
          store.acknowledgeSnapshotNeed();
          polling.refetchNow();
        }),
        lifecycle.onWake(() => {
          supervisor.dispatch({ type: 'wake' });
        }),
        lifecycle.onOnline(() => {
          supervisor.dispatch({ type: 'online' });
        }),
      ];
      supervisor.dispatch({ type: 'start' });
    },
    stop: () => {
      if (!running) return;
      running = false;
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions = [];
      stream?.stop();
      polling.stop();
    },
  };
}
