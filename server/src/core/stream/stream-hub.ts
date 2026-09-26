/**
 * The set of open stream connections, and the two caps over it (ADR-003 A1.1, A1.3).
 *
 * A sink is whatever the transport gives us to write a chunk into; the hub neither knows
 * nor cares that it is an HTTP response. It answers three questions and does nothing else:
 *
 *   * **May this client have a connection?** The global cap is 5,000 (A1.1 — beyond it the
 *     route answers 503 and the client silently stays on polling). The per-client cap
 *     (A1.3) stops one address from holding a meaningful share of that: a browser opens one
 *     stream per tab, so a handful is plenty and a hundred is a bug or an attack.
 *   * **Broadcast this chunk.** Every admitted sink gets it, in admission order. A sink that
 *     throws is released — a dead socket must not take the fan-out down with it.
 *   * **Drain.** On shutdown every sink gets one last chunk and is ended (ADR D1: send
 *     `retry:` and close; the clients resume through `Last-Event-ID`). The chunk is chosen
 *     per sink by index so the caller can spread the reconnects — five thousand clients
 *     all retrying at the same millisecond is a thundering herd the *next* process would
 *     have to absorb.
 *
 * No timers and no randomness: the hub is driven entirely by calls, which is what keeps it
 * in core and testable with nothing but a fake sink.
 */

export interface StreamSink {
  write(chunk: string): void;
  end(): void;
}

export interface StreamHubOptions {
  readonly maxConnections: number;
  readonly maxPerClient: number;
}

export type AdmissionRefusal = 'capacity' | 'client_cap';

export type Admission =
  | { readonly kind: 'admitted'; readonly release: () => void }
  | { readonly kind: 'refused'; readonly reason: AdmissionRefusal };

export interface StreamHub {
  admit(clientKey: string, sink: StreamSink): Admission;
  broadcast(chunk: string): void;
  /** Writes `chunkFor(index, total)` to every sink and ends it. The hub is empty afterwards. */
  drain(chunkFor: (index: number, total: number) => string): void;
  readonly size: number;
}

interface Member {
  readonly clientKey: string;
  readonly sink: StreamSink;
}

export function createStreamHub(options: StreamHubOptions): StreamHub {
  const { maxConnections, maxPerClient } = options;
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new RangeError('maxConnections must be a positive integer');
  }
  if (!Number.isInteger(maxPerClient) || maxPerClient < 1) {
    throw new RangeError('maxPerClient must be a positive integer');
  }

  // Insertion-ordered, so a broadcast reaches sinks in admission order and a drain can
  // number them. Per-client counts are kept alongside rather than recounted on every
  // admission: with thousands of members, a scan per connect is a cost paid at exactly
  // the moment (a reconnect storm) it can least be afforded.
  const members = new Set<Member>();
  const perClient = new Map<string, number>();

  const remove = (member: Member): void => {
    if (!members.delete(member)) return;
    const count = perClient.get(member.clientKey) ?? 0;
    if (count <= 1) perClient.delete(member.clientKey);
    else perClient.set(member.clientKey, count - 1);
  };

  return {
    admit(clientKey: string, sink: StreamSink): Admission {
      if (members.size >= maxConnections) return { kind: 'refused', reason: 'capacity' };
      const held = perClient.get(clientKey) ?? 0;
      if (held >= maxPerClient) return { kind: 'refused', reason: 'client_cap' };
      const member: Member = { clientKey, sink };
      members.add(member);
      perClient.set(clientKey, held + 1);
      return {
        kind: 'admitted',
        release: () => {
          remove(member);
        },
      };
    },

    broadcast(chunk: string): void {
      for (const member of [...members]) {
        try {
          member.sink.write(chunk);
        } catch {
          // A sink that cannot be written to is gone; the transport's own close handler
          // releases it too, and `remove` tolerates the double.
          remove(member);
        }
      }
    },

    drain(chunkFor: (index: number, total: number) => string): void {
      const draining = [...members];
      const total = draining.length;
      draining.forEach((member, index) => {
        remove(member);
        try {
          member.sink.write(chunkFor(index, total));
          member.sink.end();
        } catch {
          // Already gone; nothing left to close.
        }
      });
    },

    get size(): number {
      return members.size;
    },
  };
}

/**
 * The reconnect delay for the `index`-th of `total` draining clients, spread evenly over
 * `[minMs, maxMs]` so the herd arrives at the next process over seconds, not at once.
 * Deterministic on purpose: core has no `Math.random`, and a test can pin the spread.
 */
export function drainRetryMs(index: number, total: number, minMs: number, maxMs: number): number {
  if (total <= 1) return minMs;
  return minMs + Math.floor(((maxMs - minMs) * index) / (total - 1));
}
