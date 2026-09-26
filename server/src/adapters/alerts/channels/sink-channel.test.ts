import { describe, expect, it } from 'vitest';

import { createSinkChannel } from './sink-channel.js';
import type { OutboundMessage, RenderedAlert } from '../../../core/ports/alert-channel.js';
import { ALERT_CHANNELS } from '../../../core/ports/alert-outbox-store.js';

/** The instant the sink's injected clock reports as the provider acknowledgement. */
const ACK_AT = 1_785_670_170_000;

const RENDERED: RenderedAlert = {
  title: 'New fire 3 km from Vitosha North',
  body: 'FIRMS detected a hotspot at 13:12 local time.',
  footer: 'Data: NASA FIRMS (LANCE). Not an emergency service.',
  url: 'https://example.test/events/fw-2026-00041',
};

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    outboxId: '4181',
    channel: 'push',
    endpoint: 'https://fcm.googleapis.com/fcm/send/eXaMpLe',
    rendered: RENDERED,
    locale: 'bg',
    ttlSeconds: 1740,
    ...overrides,
  };
}

describe('createSinkChannel', () => {
  it('stands in for exactly the channel it was built for', () => {
    for (const channel of ALERT_CHANNELS) {
      expect(createSinkChannel({ channel, now: () => ACK_AT }).channel).toBe(channel);
    }
  });

  it('refuses a retain that is not a positive integer', () => {
    for (const retain of [0, -1, 2.5, Number.NaN]) {
      expect(() => createSinkChannel({ channel: 'push', now: () => ACK_AT, retain })).toThrow(
        RangeError,
      );
    }
    expect(() => createSinkChannel({ channel: 'push', now: () => ACK_AT, retain: 0 })).toThrow(
      'retain must be a positive integer, got 0',
    );
  });
});

describe('createSinkChannel — deliver', () => {
  it('records the message and acknowledges from the injected clock', async () => {
    let clock = ACK_AT;
    const sink = createSinkChannel({ channel: 'push', now: () => clock });

    expect(await sink.deliver(message())).toEqual({ kind: 'delivered', providerAckAt: ACK_AT });
    // Read at call time and not at construction: a replayed shadow run moves the clock
    // between messages, and an ack stamped once would flatten every latency it produces.
    clock = ACK_AT + 5000;
    expect(await sink.deliver(message({ outboxId: '4182' }))).toEqual({
      kind: 'delivered',
      providerAckAt: ACK_AT + 5000,
    });
    expect(sink.delivered).toEqual([message(), message({ outboxId: '4182' })]);
  });

  // Rejects rather than throws: `deliver` is declared as returning a promise, so a caller
  // holding only a `.catch(...)` must still see the misroute.
  it('refuses a message routed to another channel', async () => {
    const sink = createSinkChannel({ channel: 'push', now: () => ACK_AT });

    await expect(sink.deliver(message({ channel: 'email' }))).rejects.toThrow(TypeError);
    await expect(sink.deliver(message({ channel: 'email' }))).rejects.toThrow(
      'sink for push received a message routed to email',
    );
    expect(sink.delivered).toEqual([]);
  });

  it('drops the oldest message once the retain cap is full', async () => {
    const sink = createSinkChannel({ channel: 'push', now: () => ACK_AT, retain: 2 });

    for (const outboxId of ['1', '2', '3']) {
      await sink.deliver(message({ outboxId }));
    }
    expect(sink.delivered.map((held) => held.outboxId)).toEqual(['2', '3']);
  });

  it('forgets the record on clear', async () => {
    const sink = createSinkChannel({ channel: 'push', now: () => ACK_AT });

    await sink.deliver(message());
    sink.clear();
    expect(sink.delivered).toEqual([]);

    await sink.deliver(message({ outboxId: '4182' }));
    expect(sink.delivered).toEqual([message({ outboxId: '4182' })]);
  });
});
