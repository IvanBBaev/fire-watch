import { describe, expect, it } from 'vitest';

import { createNotificationGateway } from './notification-gateway.js';
import type {
  ContentLint,
  DispatchCycleReport,
  GatewayEvent,
  NotificationGateway,
} from './notification-gateway.js';
import { createSinkChannel } from '../channels/sink-channel.js';
import { createTemplateRenderer } from '../templates/template-renderer.js';
import {
  CLAIM_LEASE_MS,
  CLAIM_SEND_WINDOW_MS,
  LEASE_EXHAUSTED_REASON,
  type ClaimLease,
} from '../../../core/alerts/claim-lease.js';
import type { SinkChannel } from '../channels/sink-channel.js';
import { DELIVERY_PARAMS } from '../../../core/config/delivery-params.js';
import type {
  AlertChannelAdapter,
  DeliveryOutcome,
  OutboundMessage,
  RenderedAlert,
  SubscriptionDisposition,
} from '../../../core/ports/alert-channel.js';
import type {
  AlertDispatchQueue,
  ClaimedOutboxRow,
  SettleOutcome,
} from '../../../core/ports/alert-dispatch-queue.js';
import type { AlertRenderer, RenderRequest } from '../../../core/ports/alert-renderer.js';
import type {
  RecipientResolver,
  ResolvedRecipient,
} from '../../../core/ports/recipient-resolver.js';

const PARAMS = DELIVERY_PARAMS.values;

/** The same instant `dispatch-decision.test.ts` decides at, so the suites read as one story. */
const DECIDED_AT = 1_785_670_170_000;
/** One minute later. Every cycle below claims and dispatches here. */
const NOW = DECIDED_AT + 60_000;
/** The sink's clock, deliberately not the gateway's: an ack must not pass for a dispatch. */
const ACK_AT = NOW + 7;
/** D6's push TTL in milliseconds. */
const PUSH_TTL_MS = 1_800_000;
/** The life a row decided a minute ago has left: ceil((1_800_000 - 60_000) / 1000). */
const TTL_SECONDS = 1740;
const BATCH_SIZE = 25;
const SUBSCRIPTION_ID = '3f2b0a5e-0000-4000-8000-000000000001';

function claimedRow(overrides: Partial<ClaimedOutboxRow> = {}): ClaimedOutboxRow {
  return {
    id: '4181',
    watchZoneId: '11111111-0000-4000-8000-000000000001',
    fireEventId: '9007199254740993',
    alertType: 'new_fire',
    alertSubkey: 'once',
    triggerType: 'new_fire',
    triggerRefSeq: '41',
    ruleVersion: 'alert_gating_v1',
    templateId: 'new_fire.bg.v3',
    templateParams: { distanceKm: 3 },
    channel: 'push',
    channelSubscriptionId: SUBSCRIPTION_ID,
    priority: 10,
    budgetSeq: null,
    status: 'claimed',
    actorId: null,
    approverId: null,
    approvalMode: null,
    approvedAt: null,
    budgetOverride: false,
    decidedAt: DECIDED_AT,
    claimedAt: NOW,
    locale: 'bg',
    ...overrides,
  };
}

const LIVE: ResolvedRecipient = {
  live: true,
  endpoint: 'https://fcm.googleapis.com/fcm/send/eXaMpLe',
  channel: 'push',
  timeZone: 'Europe/Sofia',
};

const LIVE_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/eXaMpLe';

const RENDERED: RenderedAlert = {
  title: 'New fire 3 km from Vitosha North',
  body: 'FIRMS detected a hotspot at 13:12 local time.',
  footer: 'Data: NASA FIRMS (LANCE). Not an emergency service.',
  url: 'https://example.test/events/fw-2026-00041',
};

interface ClaimCall {
  readonly limit: number;
  readonly now: number;
}

interface SettleCall {
  readonly id: string;
  readonly outcome: SettleOutcome;
}

interface FakeQueue extends AlertDispatchQueue {
  readonly claims: readonly ClaimCall[];
  readonly settles: readonly SettleCall[];
}

function fakeQueue(rows: readonly ClaimedOutboxRow[]): FakeQueue {
  const claims: ClaimCall[] = [];
  const settles: SettleCall[] = [];
  return {
    claims,
    settles,
    claim(limit: number, now: number): Promise<readonly ClaimedOutboxRow[]> {
      claims.push({ limit, now });
      return Promise.resolve(rows);
    },
    settle(id: string, outcome: SettleOutcome): Promise<void> {
      settles.push({ id, outcome });
      return Promise.resolve();
    },
  };
}

interface ResolveCall {
  readonly watchZoneId: string;
  readonly channelSubscriptionId: string | null;
}

interface DispositionCall {
  readonly channelSubscriptionId: string;
  readonly disposition: SubscriptionDisposition;
}

interface FakeRecipients extends RecipientResolver {
  readonly resolved: readonly ResolveCall[];
  readonly dispositions: readonly DispositionCall[];
}

function fakeRecipients(recipient: ResolvedRecipient): FakeRecipients {
  const resolved: ResolveCall[] = [];
  const dispositions: DispositionCall[] = [];
  return {
    resolved,
    dispositions,
    resolve(row: ResolveCall): Promise<ResolvedRecipient> {
      resolved.push({
        watchZoneId: row.watchZoneId,
        channelSubscriptionId: row.channelSubscriptionId,
      });
      return Promise.resolve(recipient);
    },
    applyDisposition(
      channelSubscriptionId: string,
      disposition: SubscriptionDisposition,
    ): Promise<void> {
      dispositions.push({ channelSubscriptionId, disposition });
      return Promise.resolve();
    },
  };
}

interface FakeRenderer extends AlertRenderer {
  readonly requests: readonly RenderRequest[];
}

function fakeRenderer(): FakeRenderer {
  const requests: RenderRequest[] = [];
  return {
    requests,
    render(request: RenderRequest): RenderedAlert {
      requests.push(request);
      return RENDERED;
    },
  };
}

/** A push adapter whose reply is chosen per message; a `reply` that throws throws from `deliver`. */
function scriptedChannel(
  reply: (message: OutboundMessage) => DeliveryOutcome,
): AlertChannelAdapter {
  return {
    channel: 'push',
    deliver(message: OutboundMessage): Promise<DeliveryOutcome> {
      return Promise.resolve(reply(message));
    },
  };
}

function pushSink(): SinkChannel {
  return createSinkChannel({ channel: 'push', now: () => ACK_AT });
}

interface HarnessOptions {
  readonly rows?: readonly ClaimedOutboxRow[];
  readonly recipient?: ResolvedRecipient;
  readonly channels?: readonly AlertChannelAdapter[];
  readonly lint?: ContentLint;
  readonly batchSize?: number;
  readonly now?: () => number;
  readonly claimLease?: ClaimLease;
  readonly renderer?: AlertRenderer;
}

interface Harness {
  readonly gateway: NotificationGateway;
  readonly queue: FakeQueue;
  readonly recipients: FakeRecipients;
  readonly renderer: FakeRenderer;
  readonly sink: SinkChannel;
  readonly events: readonly GatewayEvent[];
}

function harness(options: HarnessOptions = {}): Harness {
  const queue = fakeQueue(options.rows ?? [claimedRow()]);
  const recipients = fakeRecipients(options.recipient ?? LIVE);
  const renderer = fakeRenderer();
  const sink = pushSink();
  const events: GatewayEvent[] = [];
  const gateway = createNotificationGateway({
    queue,
    recipients,
    renderer: options.renderer ?? renderer,
    lint: options.lint ?? ((): readonly string[] => []),
    channels: options.channels ?? [sink],
    params: PARAMS,
    now: options.now ?? ((): number => NOW),
    batchSize: options.batchSize ?? BATCH_SIZE,
    ...(options.claimLease === undefined ? {} : { claimLease: options.claimLease }),
    onEvent: (event) => {
      events.push(event);
    },
  });
  return { gateway, queue, recipients, renderer, sink, events };
}

/** The whole report, so a test cannot pass by asserting the one counter it moved. */
function report(counts: Partial<DispatchCycleReport> = {}): DispatchCycleReport {
  return {
    claimed: 1,
    sent: 0,
    closed: 0,
    released: 0,
    errored: 0,
    channelMismatches: 0,
    leaseExhausted: 0,
    lintViolations: [],
    ...counts,
  };
}

describe('createNotificationGateway — construction', () => {
  it('refuses a batch size that is not a positive integer', () => {
    for (const batchSize of [0, -1, 1.5, Number.NaN]) {
      expect(() => harness({ batchSize })).toThrow(RangeError);
    }
    expect(() => harness({ batchSize: 0 })).toThrow('batchSize must be a positive integer, got 0');
  });

  it('refuses two adapters claiming the same channel', () => {
    // Silently keeping one of them would route by whichever the loop saw last, and the
    // wiring file is the only place that could have made the mistake.
    expect(() => harness({ channels: [pushSink(), pushSink()] })).toThrow(TypeError);
    expect(() => harness({ channels: [pushSink(), pushSink()] })).toThrow(
      'two adapters registered for channel push',
    );
  });
});

describe('runOnce — the happy path', () => {
  it('sends the row and settles it with both timestamps', async () => {
    const { gateway, queue } = harness();

    expect(await gateway.runOnce()).toEqual(report({ sent: 1 }));
    expect(queue.settles).toEqual([
      { id: '4181', outcome: { kind: 'sent', dispatchedAt: NOW, providerAckAt: ACK_AT } },
    ]);
  });

  it('claims with the configured batch size and the injected clock', async () => {
    const { gateway, queue } = harness();

    await gateway.runOnce();
    expect(queue.claims).toEqual([{ limit: BATCH_SIZE, now: NOW }]);
  });

  it('hands the adapter the rendered copy, the resolved endpoint and the life left', async () => {
    const { gateway, sink } = harness();

    await gateway.runOnce();
    expect(sink.delivered).toEqual([
      {
        outboxId: '4181',
        channel: 'push',
        endpoint: LIVE_ENDPOINT,
        rendered: RENDERED,
        locale: 'bg',
        ttlSeconds: TTL_SECONDS,
      },
    ]);
  });

  it("resolves the recipient and renders in the row's locale and their time zone", async () => {
    const { gateway, recipients, renderer } = harness();

    await gateway.runOnce();
    expect(recipients.resolved).toEqual([
      {
        watchZoneId: '11111111-0000-4000-8000-000000000001',
        channelSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
    expect(renderer.requests).toEqual([
      {
        templateId: 'new_fire.bg.v3',
        templateParams: { distanceKm: 3 },
        channel: 'push',
        locale: 'bg',
        timeZone: 'Europe/Sofia',
      },
    ]);
  });

  it('emits sent with the decision-to-dispatch latency D9 measures', async () => {
    const { gateway, events } = harness();

    await gateway.runOnce();
    expect(events).toEqual([
      { kind: 'sent', outboxId: '4181', channel: 'push', latencyMs: NOW - DECIDED_AT },
    ]);
  });
});

describe('runOnce — the rows that must never reach a provider', () => {
  it('closes an erased recipients row as cancelled_erasure (A1.9)', async () => {
    const dead: ResolvedRecipient = { live: false, reason: 'subscription_deleted' };
    const { gateway, queue, sink } = harness({ recipient: dead });

    expect(await gateway.runOnce()).toEqual(report({ closed: 1 }));
    expect(queue.settles).toEqual([
      {
        id: '4181',
        outcome: {
          kind: 'closed',
          status: 'cancelled_erasure',
          error: 'subscription_deleted',
          dispatchedAt: null,
        },
      },
    ]);
    expect(sink.delivered).toEqual([]);
  });

  it('closes a row past its D6 deadline as ttl_expired', async () => {
    const rows = [claimedRow({ decidedAt: NOW - PUSH_TTL_MS })];
    const { gateway, queue, sink } = harness({ rows });

    expect(await gateway.runOnce()).toEqual(report({ closed: 1 }));
    expect(queue.settles[0]?.outcome).toMatchObject({
      kind: 'closed',
      status: 'ttl_expired',
      dispatchedAt: null,
    });
    expect(sink.delivered).toEqual([]);
  });

  it('closes copy the never-send lint refuses and names the rules (D7)', async () => {
    // Real ids from `@fire-watch/contracts`' never-send lint, so a rename there surfaces here.
    const ruleIds = ['own-voice-extinguished', 'footer-attribution'];
    const { gateway, queue, sink, events } = harness({ lint: () => ruleIds });

    expect(await gateway.runOnce()).toEqual(
      report({
        closed: 1,
        lintViolations: [{ outboxId: '4181', templateId: 'new_fire.bg.v3', ruleIds }],
      }),
    );
    expect(queue.settles).toEqual([
      {
        id: '4181',
        outcome: {
          kind: 'closed',
          status: 'failed',
          error: 'never_send:own-voice-extinguished,footer-attribution',
          dispatchedAt: null,
        },
      },
    ]);
    expect(sink.delivered).toEqual([]);
    expect(events).toContainEqual({
      kind: 'lint_violation',
      outboxId: '4181',
      templateId: 'new_fire.bg.v3',
      ruleIds,
    });
  });
});

describe('runOnce — what the adapter answered', () => {
  it('releases a row whose channel has no adapter, rather than failing it', async () => {
    // A wiring mistake the next deploy fixes; the row is still perfectly deliverable.
    const telegram = createSinkChannel({ channel: 'telegram', now: () => ACK_AT });
    const { gateway, queue } = harness({ channels: [telegram] });

    expect(await gateway.runOnce()).toEqual(report({ released: 1 }));
    expect(queue.settles).toEqual([
      {
        id: '4181',
        outcome: { kind: 'released', error: 'no adapter registered for channel push' },
      },
    ]);
    expect(telegram.delivered).toEqual([]);
  });

  it('releases a transient failure with the providers own error', async () => {
    const transient = scriptedChannel(() => ({ kind: 'transient', error: '503 from provider' }));
    const { gateway, queue } = harness({ channels: [transient] });

    expect(await gateway.runOnce()).toEqual(report({ released: 1 }));
    expect(queue.settles).toEqual([
      { id: '4181', outcome: { kind: 'released', error: '503 from provider' } },
    ]);
  });

  it('prunes the dead subscription and closes the row with its dispatch stamp (D6)', async () => {
    const gone = scriptedChannel(() => ({
      kind: 'permanent',
      error: '410 gone',
      subscription: 'prune',
    }));
    const { gateway, queue, recipients } = harness({ channels: [gone] });

    expect(await gateway.runOnce()).toEqual(report({ closed: 1 }));
    expect(recipients.dispositions).toEqual([
      { channelSubscriptionId: SUBSCRIPTION_ID, disposition: 'prune' },
    ]);
    // Not null: the provider was called, and the p95 SLO is measured against that call.
    expect(queue.settles).toEqual([
      {
        id: '4181',
        outcome: { kind: 'closed', status: 'failed', error: '410 gone', dispatchedAt: NOW },
      },
    ]);
  });

  it('leaves the subscription alone when the provider said keep', async () => {
    const rejected = scriptedChannel(() => ({
      kind: 'permanent',
      error: 'payload too large',
      subscription: 'keep',
    }));
    const { gateway, queue, recipients } = harness({ channels: [rejected] });

    expect(await gateway.runOnce()).toEqual(report({ closed: 1 }));
    expect(recipients.dispositions).toEqual([]);
    expect(queue.settles[0]?.outcome).toMatchObject({ status: 'failed', dispatchedAt: NOW });
  });

  it('has nothing to prune when the row carries no subscription id', async () => {
    const gone = scriptedChannel(() => ({
      kind: 'permanent',
      error: '410 gone',
      subscription: 'prune',
    }));
    const rows = [claimedRow({ channelSubscriptionId: null })];
    const { gateway, queue, recipients } = harness({ rows, channels: [gone] });

    expect(await gateway.runOnce()).toEqual(report({ closed: 1 }));
    expect(recipients.dispositions).toEqual([]);
    expect(queue.settles[0]?.outcome).toMatchObject({ kind: 'closed', status: 'failed' });
  });

  it('releases a row whose adapter threw and carries on with the next one', async () => {
    // The port says an adapter reports failure by returning, so a throw is an adapter bug
    // — loud in the events, but never a reason to abandon the rest of the batch.
    const flaky = scriptedChannel((message) => {
      if (message.outboxId === 'a') {
        throw new Error('no VAPID key configured');
      }
      return { kind: 'delivered', providerAckAt: ACK_AT };
    });
    const rows = [claimedRow({ id: 'a' }), claimedRow({ id: 'b' })];
    const { gateway, queue, events } = harness({ rows, channels: [flaky] });

    expect(await gateway.runOnce()).toEqual(report({ claimed: 2, sent: 1, released: 1 }));
    expect(queue.settles).toEqual([
      { id: 'a', outcome: { kind: 'released', error: 'adapter threw: no VAPID key configured' } },
      { id: 'b', outcome: { kind: 'sent', dispatchedAt: NOW, providerAckAt: ACK_AT } },
    ]);
    expect(events).toContainEqual({
      kind: 'adapter_threw',
      outboxId: 'a',
      error: 'no VAPID key configured',
    });
  });
});

describe('runOnce — the cycle', () => {
  it('settles the batch in the order the claim handed it over (A1.2)', async () => {
    // Dispatch is sequential on purpose: the claim already ordered the batch by priority,
    // and a parallel cycle would spend the provider budget on whatever finished first.
    const rows = ['a', 'b', 'c'].map((id) => claimedRow({ id }));
    const { gateway, queue } = harness({ rows });

    await gateway.runOnce();
    expect(queue.settles.map((call) => call.id)).toEqual(['a', 'b', 'c']);
  });

  it('does nothing at all on an empty claim', async () => {
    const { gateway, queue, recipients, renderer, sink, events } = harness({ rows: [] });

    expect(await gateway.runOnce()).toEqual(report({ claimed: 0 }));
    expect(queue.settles).toEqual([]);
    expect(recipients.resolved).toEqual([]);
    expect(renderer.requests).toEqual([]);
    expect(sink.delivered).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('runOnce — a collaborator that throws', () => {
  // The ports are contracted to return outcomes, not throw. They will anyway: a resolver
  // outage, a renderer handed a runtime parameter its author never imagined. What has to
  // survive is the rest of an ordered batch — row three must not be lost because row two
  // was unlucky.
  it('counts and names the row, then keeps dispatching', async () => {
    let calls = 0;
    const { gateway, queue, sink, events } = harness({
      rows: [claimedRow({ id: '1' }), claimedRow({ id: '2' }), claimedRow({ id: '3' })],
      lint: (): readonly string[] => {
        calls += 1;
        if (calls === 2) {
          throw new Error('lint blew up');
        }
        return [];
      },
    });

    expect(await gateway.runOnce()).toEqual(report({ claimed: 3, sent: 2, errored: 1 }));
    // The abandoned row is not settled: it stays claimed and returns when the claim expires.
    expect(queue.settles.map((settle) => settle.id)).toEqual(['1', '3']);
    expect(sink.delivered.map((message) => message.outboxId)).toEqual(['1', '3']);
    expect(events).toContainEqual({ kind: 'row_failed', outboxId: '2', error: 'lint blew up' });
  });
});

describe('runOnce — locale (H5)', () => {
  it('renders an English row in English and tells the adapter so', async () => {
    const { gateway, renderer, sink } = harness({ rows: [claimedRow({ locale: 'en' })] });

    expect(await gateway.runOnce()).toEqual(report({ sent: 1 }));
    expect(renderer.requests.map((request) => request.locale)).toEqual(['en']);
    expect(sink.delivered.map((message) => message.locale)).toEqual(['en']);
  });

  it('stays fail-closed with the shipped (empty) reviewed corpus, in every locale', async () => {
    // No reviewed template exists yet (H6, founder review): render throws, the row is
    // counted errored and left claimed, and nothing reaches a provider.
    const rows = [claimedRow({ id: 'bg-row' }), claimedRow({ id: 'en-row', locale: 'en' })];
    const { gateway, queue, sink } = harness({ rows, renderer: createTemplateRenderer() });

    expect(await gateway.runOnce()).toEqual(report({ claimed: 2, errored: 2 }));
    expect(queue.settles).toEqual([]);
    expect(sink.delivered).toEqual([]);
  });
});

describe('runOnce — channel mismatch (H5)', () => {
  it('closes a row whose subscription is on another channel, counts it, and never sends', async () => {
    const onTelegram: ResolvedRecipient = { ...LIVE, channel: 'telegram' };
    const { gateway, queue, renderer, sink, events } = harness({ recipient: onTelegram });

    expect(await gateway.runOnce()).toEqual(report({ closed: 1, channelMismatches: 1 }));
    expect(queue.settles).toEqual([
      {
        id: '4181',
        outcome: {
          kind: 'closed',
          status: 'failed',
          error: 'channel_mismatch: row is push, subscription is telegram',
          dispatchedAt: null,
        },
      },
    ]);
    expect(renderer.requests).toEqual([]);
    expect(sink.delivered).toEqual([]);
    expect(events).toEqual([
      {
        kind: 'closed',
        outboxId: '4181',
        status: 'failed',
        reason: 'channel_mismatch: row is push, subscription is telegram',
      },
    ]);
  });

  it('does not count other failed closes as mismatches', async () => {
    const { gateway } = harness({ lint: () => ['own-voice-extinguished'] });

    const result = await gateway.runOnce();
    expect(result.closed).toBe(1);
    expect(result.channelMismatches).toBe(0);
  });
});

describe('runOnce — the claim lease (H4)', () => {
  it('sends while the whole send window still fits inside the lease', async () => {
    const claimedAt = NOW - (CLAIM_LEASE_MS - CLAIM_SEND_WINDOW_MS);
    const { gateway, sink } = harness({ rows: [claimedRow({ claimedAt })] });

    expect(await gateway.runOnce()).toEqual(report({ sent: 1 }));
    expect(sink.delivered).toHaveLength(1);
  });

  it('releases a row unsent once too little of its lease is left', async () => {
    const claimedAt = NOW - (CLAIM_LEASE_MS - CLAIM_SEND_WINDOW_MS) - 1;
    const { gateway, queue, sink, events } = harness({ rows: [claimedRow({ claimedAt })] });

    expect(await gateway.runOnce()).toEqual(report({ released: 1, leaseExhausted: 1 }));
    expect(queue.settles).toEqual([
      { id: '4181', outcome: { kind: 'released', error: LEASE_EXHAUSTED_REASON } },
    ]);
    expect(sink.delivered).toEqual([]);
    expect(events).toEqual([
      { kind: 'released', outboxId: '4181', reason: LEASE_EXHAUSTED_REASON },
    ]);
  });

  it('checks the lease against the clock at send time, not at claim time', async () => {
    // A batch that ran long: the first row's send used the clock up, the second row
    // finds its lease spent and is released rather than started.
    const lease: ClaimLease = { leaseMs: 60_000, sendWindowMs: 10_000 };
    let clock = NOW;
    const slow = scriptedChannel(() => {
      clock += 55_000;
      return { kind: 'delivered', providerAckAt: clock };
    });
    const rows = [claimedRow({ id: 'a' }), claimedRow({ id: 'b' })];
    const { gateway, queue } = harness({
      rows,
      channels: [slow],
      claimLease: lease,
      now: () => clock,
    });

    expect(await gateway.runOnce()).toEqual(
      report({ claimed: 2, sent: 1, released: 1, leaseExhausted: 1 }),
    );
    expect(queue.settles.map((settle) => [settle.id, settle.outcome.kind])).toEqual([
      ['a', 'sent'],
      ['b', 'released'],
    ]);
  });

  it('refuses a lease with no room for a send', () => {
    expect(() => harness({ claimLease: { leaseMs: 10_000, sendWindowMs: 10_000 } })).toThrow(
      RangeError,
    );
  });
});
