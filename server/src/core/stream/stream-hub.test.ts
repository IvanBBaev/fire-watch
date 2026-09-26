import { describe, expect, it } from 'vitest';

import { type StreamSink, createStreamHub, drainRetryMs } from './stream-hub.js';

interface FakeSink extends StreamSink {
  readonly chunks: string[];
  ended: boolean;
}

function sink(overrides: Partial<StreamSink> = {}): FakeSink {
  const fake: FakeSink = {
    chunks: [],
    ended: false,
    write(chunk) {
      fake.chunks.push(chunk);
    },
    end() {
      fake.ended = true;
    },
    ...overrides,
  };
  return fake;
}

describe('createStreamHub', () => {
  it('admits up to the global cap and refuses the next one as capacity (A1.1)', () => {
    const hub = createStreamHub({ maxConnections: 2, maxPerClient: 5 });
    expect(hub.admit('a', sink()).kind).toBe('admitted');
    expect(hub.admit('b', sink()).kind).toBe('admitted');
    expect(hub.admit('c', sink())).toEqual({ kind: 'refused', reason: 'capacity' });
    expect(hub.size).toBe(2);
  });

  it('caps one client below the global cap and refuses the next as client_cap (A1.3)', () => {
    const hub = createStreamHub({ maxConnections: 10, maxPerClient: 2 });
    hub.admit('same', sink());
    hub.admit('same', sink());
    expect(hub.admit('same', sink())).toEqual({ kind: 'refused', reason: 'client_cap' });
    expect(hub.admit('other', sink()).kind).toBe('admitted');
  });

  it('reports capacity before the client cap when both apply', () => {
    // The 503 is the answer a client acts on (stay on polling for a minute); a 429 for the
    // same connection would have it retry sooner against a server that is full.
    const hub = createStreamHub({ maxConnections: 1, maxPerClient: 1 });
    hub.admit('same', sink());
    expect(hub.admit('same', sink())).toEqual({ kind: 'refused', reason: 'capacity' });
  });

  it('frees both the slot and the client count on release, and tolerates a double release', () => {
    const hub = createStreamHub({ maxConnections: 1, maxPerClient: 1 });
    const admitted = hub.admit('a', sink());
    if (admitted.kind !== 'admitted') throw new Error('expected admission');
    admitted.release();
    admitted.release();
    expect(hub.size).toBe(0);
    expect(hub.admit('a', sink()).kind).toBe('admitted');
  });

  it('broadcasts to every member in admission order', () => {
    const hub = createStreamHub({ maxConnections: 5, maxPerClient: 5 });
    const order: string[] = [];
    for (const name of ['first', 'second', 'third']) {
      hub.admit(name, sink({ write: () => order.push(name) }));
    }
    hub.broadcast('x');
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('drops a sink that throws on write and keeps writing to the others', () => {
    const hub = createStreamHub({ maxConnections: 5, maxPerClient: 5 });
    const healthy = sink();
    hub.admit(
      'bad',
      sink({
        write: () => {
          throw new Error('EPIPE');
        },
      }),
    );
    hub.admit('good', healthy);
    hub.broadcast('x');
    expect(healthy.chunks).toEqual(['x']);
    expect(hub.size).toBe(1);
    // The dead client's slot is free again immediately.
    expect(hub.admit('bad', sink()).kind).toBe('admitted');
  });

  it('drains every member with its own chunk, ends them, and is empty afterwards', () => {
    const hub = createStreamHub({ maxConnections: 5, maxPerClient: 5 });
    const sinks = [sink(), sink(), sink()];
    for (const s of sinks) hub.admit('k', s);
    hub.drain((index, total) => `retry: ${String(index)}/${String(total)}\n\n`);
    expect(sinks.map((s) => s.chunks)).toEqual([
      ['retry: 0/3\n\n'],
      ['retry: 1/3\n\n'],
      ['retry: 2/3\n\n'],
    ]);
    expect(sinks.every((s) => s.ended)).toBe(true);
    expect(hub.size).toBe(0);
    // A late broadcast after the drain reaches nobody.
    hub.broadcast('late');
    expect(sinks.map((s) => s.chunks.length)).toEqual([1, 1, 1]);
  });

  it('drains past a sink that throws on end', () => {
    const hub = createStreamHub({ maxConnections: 5, maxPerClient: 5 });
    const after = sink();
    hub.admit(
      'a',
      sink({
        end: () => {
          throw new Error('already closed');
        },
      }),
    );
    hub.admit('b', after);
    hub.drain(() => 'bye');
    expect(after.ended).toBe(true);
    expect(hub.size).toBe(0);
  });

  it('refuses nonsensical caps', () => {
    expect(() => createStreamHub({ maxConnections: 0, maxPerClient: 1 })).toThrow(RangeError);
    expect(() => createStreamHub({ maxConnections: 1, maxPerClient: 0 })).toThrow(RangeError);
  });
});

describe('drainRetryMs', () => {
  it('spreads the reconnects evenly across the range, first at min and last at max', () => {
    expect(drainRetryMs(0, 4, 1_000, 10_000)).toBe(1_000);
    expect(drainRetryMs(1, 4, 1_000, 10_000)).toBe(4_000);
    expect(drainRetryMs(2, 4, 1_000, 10_000)).toBe(7_000);
    expect(drainRetryMs(3, 4, 1_000, 10_000)).toBe(10_000);
  });

  it('gives a lone client the minimum', () => {
    expect(drainRetryMs(0, 1, 1_000, 10_000)).toBe(1_000);
    expect(drainRetryMs(0, 0, 1_000, 10_000)).toBe(1_000);
  });
});
