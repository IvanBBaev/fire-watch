/**
 * Keeps the imagery handles current (ADR-001 A2.3): "clients refetch client-config on tab
 * wake / reconnect; a session with imagery on falls back to the basemap on its next fetch".
 *
 * One fetch on start, one on every wake and every reconnect — nothing on a timer, because
 * A2.3 accepts that an open, focused tab keeps drawing imagery until its next wake: that
 * lag is what the ceiling's headroom below the free tier pays for.
 *
 * Failure policy, the one asymmetry with the transport reader: a fetch that fails
 * (network, non-2xx, a body that is not JSON) keeps whatever is current, since a flaky
 * connection is not news about the quota; a document that *answers* without a valid block
 * turns imagery off, since that is exactly how the server says so. Responses that arrive
 * out of order are dropped, so a slow early answer never undoes a later one.
 */

import type { PageLifecycle } from '../ports.js';
import type { ImageryHandles } from './imagery-config.js';
import { parseImageryHandles, sameImageryHandles } from './imagery-config.js';

export interface ImageryRefreshDeps {
  readonly fetchFn: typeof fetch;
  /** The client-config document (`ClientConfig.clientConfigUrl`). */
  readonly url: string;
  readonly lifecycle: PageLifecycle;
  /** Called with the new handles only when they actually change. */
  readonly onChange: (handles: ImageryHandles | null) => void;
}

export interface ImageryRefresh {
  /** Fetch once now; resolves when the answer (if any) has been applied. Never rejects. */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
  current(): ImageryHandles | null;
}

export function createImageryRefresh(deps: ImageryRefreshDeps): ImageryRefresh {
  let current: ImageryHandles | null = null;
  let issued = 0;
  let applied = 0;
  let unsubscribe: (() => void)[] = [];

  const read = async (): Promise<{ readonly handles: ImageryHandles | null } | null> => {
    try {
      const response = await deps.fetchFn(deps.url, { headers: { accept: 'application/json' } });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return { handles: parseImageryHandles(body) };
    } catch {
      return null;
    }
  };

  const refresh = async (): Promise<void> => {
    issued += 1;
    const sequence = issued;
    const answer = await read();
    if (answer === null || sequence < applied) return;
    applied = sequence;
    if (sameImageryHandles(current, answer.handles)) return;
    current = answer.handles;
    deps.onChange(current);
  };

  const onSignal = (): void => {
    void refresh();
  };

  return {
    refresh,
    start(): void {
      if (unsubscribe.length > 0) return;
      unsubscribe = [deps.lifecycle.onWake(onSignal), deps.lifecycle.onOnline(onSignal)];
      void refresh();
    },
    stop(): void {
      for (const off of unsubscribe) off();
      unsubscribe = [];
    },
    current: () => current,
  };
}
