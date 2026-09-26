/**
 * The store→VDOM bridge (ADR-005 D1/D2): the framework-free store notifies plain
 * listeners; this hook mirrors `state()` into component state. Components read store
 * state ONLY through this hook — the map subscribes directly and never comes here.
 */

import { useEffect, useState } from 'preact/hooks';

import type { FireEventStore, StoreState } from '../core/types.js';

export function useStoreState(store: FireEventStore): StoreState {
  const [state, setState] = useState<StoreState>(() => store.state());
  useEffect(() => {
    // Catch anything dispatched between first render and effect flush.
    setState(store.state());
    return store.subscribe(() => {
      setState(store.state());
    });
  }, [store]);
  return state;
}
