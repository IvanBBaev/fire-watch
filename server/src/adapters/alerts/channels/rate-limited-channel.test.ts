import { describe, expect, it } from 'vitest';

import type {
  AlertChannelAdapter,
  DeliveryOutcome,
  OutboundMessage,
} from '../../../core/ports/alert-channel.js';
import type { Sleeper } from '../../../core/ports/sleeper.js';
import { createRateLimitedChannel } from './rate-limited-channel.js';
import { createTokenBucket } from './token-bucket.js';

function manualClock(start = 1_758_200_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number): void {
      now += ms;
    },
  };
}

interface FakeSleeper extends Sleeper {
  readonly pauses: number[];
}

/** Sleeping advances the clock by exactly the requested amount and returns at once. */
function fakeSleeper(clock: ReturnType<typeof manualClock>, onSleep?: () => void): FakeSleeper {
  const pauses: number[] = [];
  return {
    pauses,
    sleep(ms: number): Promise<void> {
      pauses.push(ms);
      clock.advance(ms);
      onSleep?.();
      return Promise.resolve();
    },
  };
}

function message(outboxId: string): OutboundMessage {
  return {
    outboxId,
    channel: 'telegram',
    endpoint: '12345',
    rendered: { title: 't', body: 'b', footer: 'f', url: null },
    locale: 'bg',
    ttlSeconds: 21_600,
  };
}

function recordingInner(outcome: DeliveryOutcome = { kind: 'delivered', providerAckAt: 1 }) {
  const seen: string[] = [];
  const adapter: AlertChannelAdapter = {
    channel: 'telegram',
    deliver(m: OutboundMessage): Promise<DeliveryOutcome> {
      seen.push(m.outboxId);
      return Promise.resolve(outcome);
    },
  };
  return { adapter, seen };
}

describe('createRateLimitedChannel', () => {
  it('reports the inner channel, so the gateway routes to it unchanged', () => {
    const clock = manualClock();
    const { adapter } = recordingInner();
    const wrapped = createRateLimitedChannel({
      inner: adapter,
      bucket: createTokenBucket({ ratePerSecond: 25, now: clock.now }),
      sleeper: fakeSleeper(clock),
      maxWaitMs: 2_000,
    });
    expect(wrapped.channel).toBe('telegram');
  });

  it('passes sends straight through while the bucket has tokens', async () => {
    const clock = manualClock();
    const sleeper = fakeSleeper(clock);
    const { adapter, seen } = recordingInner();
    const wrapped = createRateLimitedChannel({
      inner: adapter,
      bucket: createTokenBucket({ ratePerSecond: 25, burst: 3, now: clock.now }),
      sleeper,
      maxWaitMs: 2_000,
    });

    for (const id of ['1', '2', '3']) {
      await expect(wrapped.deliver(message(id))).resolves.toEqual({
        kind: 'delivered',
        providerAckAt: 1,
      });
    }
    expect(seen).toEqual(['1', '2', '3']);
    expect(sleeper.pauses).toEqual([]);
  });

  it('sleeps through a short wait and then sends', async () => {
    const clock = manualClock();
    const sleeper = fakeSleeper(clock);
    const { adapter, seen } = recordingInner();
    const wrapped = createRateLimitedChannel({
      inner: adapter,
      bucket: createTokenBucket({ ratePerSecond: 25, burst: 1, now: clock.now }),
      sleeper,
      maxWaitMs: 2_000,
    });

    await wrapped.deliver(message('1'));
    const outcome = await wrapped.deliver(message('2'));

    expect(outcome.kind).toBe('delivered');
    expect(seen).toEqual(['1', '2']);
    expect(sleeper.pauses).toEqual([40]); // 25/s → one token every 40 ms
  });

  it('releases the row as transient instead of waiting past the ceiling', async () => {
    const clock = manualClock();
    const sleeper = fakeSleeper(clock);
    const { adapter, seen } = recordingInner();
    const wrapped = createRateLimitedChannel({
      inner: adapter,
      // One token per five seconds: any wait is longer than the 2 s ceiling.
      bucket: createTokenBucket({ ratePerSecond: 0.2, burst: 1, now: clock.now }),
      sleeper,
      maxWaitMs: 2_000,
    });

    await wrapped.deliver(message('1'));
    const outcome = await wrapped.deliver(message('2'));

    expect(outcome).toEqual({
      kind: 'transient',
      error: 'rate_limited:telegram: next token in 5000 ms',
    });
    expect(seen).toEqual(['1']);
    expect(sleeper.pauses).toEqual([]);
  });

  it('counts accumulated waits against the ceiling, not each wait alone', async () => {
    const clock = manualClock();
    // A sleeper that lies: it returns without advancing time, so every wake finds the
    // bucket still dry and the wrapper must give up on the total rather than loop.
    const pauses: number[] = [];
    const stuck: Sleeper = {
      sleep(ms: number): Promise<void> {
        pauses.push(ms);
        return Promise.resolve();
      },
    };
    const { adapter, seen } = recordingInner();
    const wrapped = createRateLimitedChannel({
      inner: adapter,
      bucket: createTokenBucket({ ratePerSecond: 10, burst: 1, now: clock.now }),
      sleeper: stuck,
      maxWaitMs: 250,
    });

    await wrapped.deliver(message('1'));
    const outcome = await wrapped.deliver(message('2'));

    expect(outcome.kind).toBe('transient');
    expect(pauses).toEqual([100, 100]); // a third 100 would exceed 250
    expect(seen).toEqual(['1']);
  });

  it('releases the row when shutdown interrupts the wait', async () => {
    const clock = manualClock();
    const controller = new AbortController();
    // Abort arrives during the sleep, and the sleep returns without advancing time —
    // exactly how the system sleeper behaves on a SIGTERM.
    const pauses: number[] = [];
    const interrupted: Sleeper = {
      sleep(ms: number): Promise<void> {
        pauses.push(ms);
        controller.abort();
        return Promise.resolve();
      },
    };
    const { adapter, seen } = recordingInner();
    const wrapped = createRateLimitedChannel({
      inner: adapter,
      bucket: createTokenBucket({ ratePerSecond: 25, burst: 1, now: clock.now }),
      sleeper: interrupted,
      maxWaitMs: 2_000,
      signal: controller.signal,
    });

    await wrapped.deliver(message('1'));
    const outcome = await wrapped.deliver(message('2'));

    expect(outcome).toEqual({ kind: 'transient', error: 'rate_limited:telegram: shutting down' });
    expect(pauses).toEqual([40]);
    expect(seen).toEqual(['1']);
  });

  it('does not take a token for a row it releases', async () => {
    const clock = manualClock();
    const sleeper = fakeSleeper(clock);
    const { adapter, seen } = recordingInner();
    const bucket = createTokenBucket({ ratePerSecond: 0.2, burst: 1, now: clock.now });
    const wrapped = createRateLimitedChannel({ inner: adapter, bucket, sleeper, maxWaitMs: 100 });

    await wrapped.deliver(message('1'));
    await wrapped.deliver(message('2')); // released
    clock.advance(5_000);
    await wrapped.deliver(message('3')); // the refilled token goes to whoever asks next

    expect(seen).toEqual(['1', '3']);
  });

  it('lets the inner outcome through untouched, including permanent ones', async () => {
    const clock = manualClock();
    const permanent: DeliveryOutcome = {
      kind: 'permanent',
      error: 'telegram 403 bot was blocked by the user',
      subscription: 'prune',
    };
    const { adapter } = recordingInner(permanent);
    const wrapped = createRateLimitedChannel({
      inner: adapter,
      bucket: createTokenBucket({ ratePerSecond: 25, now: clock.now }),
      sleeper: fakeSleeper(clock),
      maxWaitMs: 2_000,
    });
    await expect(wrapped.deliver(message('1'))).resolves.toEqual(permanent);
  });

  it('rejects a negative ceiling at construction', () => {
    const clock = manualClock();
    const { adapter } = recordingInner();
    expect(() =>
      createRateLimitedChannel({
        inner: adapter,
        bucket: createTokenBucket({ ratePerSecond: 25, now: clock.now }),
        sleeper: fakeSleeper(clock),
        maxWaitMs: -1,
      }),
    ).toThrow(RangeError);
  });
});
