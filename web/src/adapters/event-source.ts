/**
 * The browser's `EventSource` behind the {@link StreamSource} port — the one place
 * shipped web code touches the native SSE client.
 *
 * Two things the port hides: named frames never reach `onmessage`, so a listener is
 * registered per frame name (the list is the core's, so the adapter and the guard cannot
 * drift apart); and the native retry loop is disabled by construction — on `error` the
 * source is closed *before* the feed hears of it, so the browser never reconnects on its
 * own into a `503` the supervisor meant to back away from (ADR-003 A1.1). Reconnecting
 * is the feed's caller's decision, made through `open` again.
 */

import { STREAM_FRAME_NAMES } from '../core/feed/stream-frames.js';
import type { StreamSource } from '../core/ports.js';

export function createEventSourceStreamSource(): StreamSource {
  return {
    open(url, handlers) {
      const source = new EventSource(url);
      const forward = (event: Event): void => {
        const frame = event as MessageEvent<string>;
        handlers.onFrame({ name: frame.type, lastEventId: frame.lastEventId, data: frame.data });
      };
      for (const name of STREAM_FRAME_NAMES) source.addEventListener(name, forward);
      source.onopen = () => {
        handlers.onOpen();
      };
      source.onerror = () => {
        // Closed first: a closed EventSource fires nothing more and never retries.
        source.close();
        handlers.onError();
      };
      return {
        close: () => {
          source.close();
        },
      };
    },
  };
}
