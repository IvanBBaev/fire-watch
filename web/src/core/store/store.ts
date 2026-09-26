/**
 * The client store: reconciler state plus the feed-side fields, behind a plain listener
 * set (ADR-005 D4 — framework-free by boundary rule; `ui/` bridges to signals, `map/`
 * subscribes directly).
 *
 * Every write goes through the pure reconciler and every message is a no-op when nothing
 * changed, so change detection is reference equality on the *exposed* shape: listeners
 * hear exactly one call per state change and none for a message that changed nothing.
 * The reconciler also keeps bookkeeping no consumer renders — noted absences, tombstone
 * instants, the settled floor — and a message that moves only those is persisted here
 * but not announced: nothing on screen could change, so nothing on screen should
 * re-evaluate.
 *
 * The one dependency is server time (`serverNow`, ADR-003 A1.6): tombstones age out
 * against it after every batch, and the store consults no clock of its own.
 */

import type { ServerNow } from '../ports.js';
import type { FeedMessage, FeedStatus, FireEventStore, StoreState } from '../types.js';
import type { ReconcilerState } from './reconciler.js';
import {
  applyConfirmation,
  applyDelta,
  applyReset,
  applySnapshot,
  applyStreamFreshness,
  createInitialReconcilerState,
  expireTombstones,
} from './reconciler.js';

export interface FireEventStoreDeps {
  readonly serverNow: ServerNow;
}

export function createFireEventStore(deps: FireEventStoreDeps): FireEventStore {
  let reconciled: ReconcilerState = createInitialReconcilerState();
  let current: StoreState = {
    ...exposedOf(reconciled),
    freshness: null,
    feedStatus: 'connecting',
  };
  const listeners = new Set<() => void>();

  function notify(): void {
    // Iterate a copy: a listener may unsubscribe (itself or another) mid-notification.
    for (const listener of [...listeners]) listener();
  }

  function publish(next: StoreState): void {
    if (next === current) return;
    current = next;
    notify();
  }

  /** Persist a reconciler result; announce it only if a field anyone can see moved. */
  function commit(next: ReconcilerState): void {
    if (next === reconciled) return;
    const exposedChanged =
      next.events !== reconciled.events ||
      next.maxSeq !== reconciled.maxSeq ||
      next.lastSnapshotAt !== reconciled.lastSnapshotAt ||
      next.needsSnapshot !== reconciled.needsSnapshot ||
      next.sources !== reconciled.sources;
    reconciled = next;
    if (exposedChanged) publish({ ...current, ...exposedOf(next) });
  }

  function dispatch(message: FeedMessage): void {
    switch (message.kind) {
      case 'snapshot':
        commit(expireTombstones(applySnapshot(reconciled, message.snapshot), deps.serverNow()));
        return;
      case 'delta':
        commit(
          expireTombstones(
            applyDelta(reconciled, message.events, message.generatedAt),
            deps.serverNow(),
          ),
        );
        return;
      case 'reset':
        commit(applyReset(reconciled));
        return;
      case 'freshness':
        // The side-poll re-delivers the same report between server refreshes; a report is
        // immutable per `generatedAt`, so an equal instant is the same report.
        if (
          message.report === current.freshness ||
          message.report.generatedAt === current.freshness?.generatedAt
        ) {
          return;
        }
        publish({ ...current, freshness: message.report });
        return;
      case 'stream-freshness':
        commit(
          applyStreamFreshness(reconciled, message.maxSeq, message.generatedAt, message.sources),
        );
        return;
      case 'snapshot-confirmed':
        commit(applyConfirmation(reconciled, message.generatedAt));
        return;
    }
  }

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch,
    setFeedStatus(status: FeedStatus) {
      if (status === current.feedStatus) return;
      publish({ ...current, feedStatus: status });
    },
    acknowledgeSnapshotNeed() {
      if (!reconciled.needsSnapshot) return;
      reconciled = { ...reconciled, needsSnapshot: false };
      publish({ ...current, needsSnapshot: false });
    },
  };
}

/** The reconciler fields `StoreState` shows; the rest stays in the store. */
function exposedOf(
  state: ReconcilerState,
): Pick<StoreState, 'events' | 'maxSeq' | 'lastSnapshotAt' | 'needsSnapshot' | 'sources'> {
  return {
    events: state.events,
    maxSeq: state.maxSeq,
    lastSnapshotAt: state.lastSnapshotAt,
    needsSnapshot: state.needsSnapshot,
    sources: state.sources,
  };
}
