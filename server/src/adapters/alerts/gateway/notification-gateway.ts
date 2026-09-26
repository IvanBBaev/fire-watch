/**
 * The notification gateway — ADR-004 D2.
 *
 * D2 makes this module the **sole sender**: no route, worker, CLI or job may reach a
 * provider adapter, and `only-the-gateway-sends` in `.dependency-cruiser.cjs` fails CI if
 * one tries (`gateway/boundary.test.ts` proves the rule bites). The reason is not tidiness.
 * Every obligation the pipeline carries — A1.9's liveness re-check, A1.4's cool-off, D6's
 * TTLs, D7's never-send lint, the budget and the audit trail — is enforced in exactly one
 * place here, and a second sender would be a second, unreviewed copy of all of them.
 *
 * What the gateway itself decides is nothing. It sequences:
 *
 *   claim → resolve recipient → {@link dispatchVerdict} → render → never-send lint →
 *   lease check → channel adapter → settle
 *
 * The row is rendered in its own stored `locale` (migration 015) and the message carries
 * it; the lease check refuses a provider call that the row's claim lease could not cover
 * to the end (`core/alerts/claim-lease.ts`), releasing the row unsent instead.
 *
 * and every branch in that chain is either a pure function from `core/alerts/` or a port.
 * The gateway is deliberately dull, because the interesting parts have to be testable
 * without a provider, and a provider has to be swappable without touching a rule.
 *
 * One cycle, one batch. There is no internal loop and no timer: the caller (H4's worker,
 * or a test) decides when to run and how often, so that budget exhaustion, the circuit
 * breaker and the kill switch can stop dispatch by simply not calling `runOnce` — the
 * three of them gate *claiming*, which is upstream of everything here.
 */

import {
  assertClaimLease,
  DEFAULT_CLAIM_LEASE,
  LEASE_EXHAUSTED_REASON,
  leaseAllowsSend,
  type ClaimLease,
} from '../../../core/alerts/claim-lease.js';
import {
  CHANNEL_MISMATCH_REASON,
  dispatchVerdict,
} from '../../../core/alerts/dispatch-decision.js';
import type { DeliveryParams } from '../../../core/config/delivery-params.js';
import type {
  AlertChannelAdapter,
  DeliveryOutcome,
  OutboundMessage,
  RenderedAlert,
} from '../../../core/ports/alert-channel.js';
import type {
  AlertDispatchQueue,
  ClaimedOutboxRow,
} from '../../../core/ports/alert-dispatch-queue.js';
import type { AlertRenderer } from '../../../core/ports/alert-renderer.js';
import type { AlertChannel } from '../../../core/ports/alert-outbox-store.js';
import type { RecipientResolver } from '../../../core/ports/recipient-resolver.js';

/**
 * D7's never-send lint, as the gateway sees it: rendered copy in, the ids of the rules it
 * breaks out. An empty array means the copy may be sent.
 *
 * Taken as a collaborator rather than imported directly so that H6 can compose the base
 * corpus lint with template-specific checks, and so that this module has no opinion about
 * how many rules there are. The lint is expected to have already failed CI on the template
 * corpus (D7: a violating template fails the build, not the send); a violation reaching
 * this point means a *parameter* produced forbidden copy at runtime, which is a bug — the
 * row is closed `failed` and the rule ids are recorded rather than silently dropped.
 */
export interface LintTarget {
  readonly channel: AlertChannel;
  /** Which reviewed template produced the copy — this is what selects the voice. */
  readonly templateId: string;
  /**
   * The bound parameters. The shipped lint reads them through `lintContextFor`: the
   * quoted-official exemption turns on the source metadata (authority, URL, statement
   * time) that arrives in exactly this object.
   */
  readonly templateParams: Readonly<Record<string, unknown>>;
}

export type ContentLint = (rendered: RenderedAlert, target: LintTarget) => readonly string[];

export interface NotificationGatewayDeps {
  readonly queue: AlertDispatchQueue;
  readonly recipients: RecipientResolver;
  readonly renderer: AlertRenderer;
  readonly lint: ContentLint;
  /** One adapter per channel. A channel with no adapter is a deployment error, not a bug. */
  readonly channels: readonly AlertChannelAdapter[];
  readonly params: DeliveryParams;
  readonly now: () => number;
  /** Rows per cycle. Bounded so one cycle cannot hold a claim longer than its TTL. */
  readonly batchSize?: number;
  readonly onEvent?: (event: GatewayEvent) => void;
  /** The claim lease a send must fit inside; the shipped one unless a test says so. */
  readonly claimLease?: ClaimLease;
}

/**
 * Why a row ended where it did. Emitted per row, and counted in the cycle report; H4's
 * worker turns these into the metrics D6 pages on.
 */
export type GatewayEvent =
  | {
      readonly kind: 'sent';
      readonly outboxId: string;
      readonly channel: AlertChannel;
      readonly latencyMs: number;
    }
  | {
      readonly kind: 'closed';
      readonly outboxId: string;
      readonly status: string;
      readonly reason: string;
    }
  | { readonly kind: 'released'; readonly outboxId: string; readonly reason: string }
  | {
      readonly kind: 'lint_violation';
      readonly outboxId: string;
      readonly templateId: string;
      readonly ruleIds: readonly string[];
    }
  | { readonly kind: 'adapter_threw'; readonly outboxId: string; readonly error: string }
  | { readonly kind: 'row_failed'; readonly outboxId: string; readonly error: string };

/** One row's worth of D7 findings, kept whole so a report names the guilty template. */
export interface LintViolationReport {
  readonly outboxId: string;
  readonly templateId: string;
  readonly ruleIds: readonly string[];
}

export interface DispatchCycleReport {
  readonly claimed: number;
  readonly sent: number;
  readonly closed: number;
  readonly released: number;
  /**
   * Rows abandoned because a port threw. The row stays `claimed` and returns when the
   * claim expires; the count exists so a cycle that silently did nothing cannot look
   * like a cycle with nothing to do.
   */
  readonly errored: number;
  /**
   * Rows closed because their subscription is on another channel (`channel_mismatch`,
   * H5) — included in `closed`, and counted apart because every one is a decision-side
   * binding bug or a re-pointed subscription, never a provider problem.
   */
  readonly channelMismatches: number;
  /** Rows released unsent because too little of their claim lease was left (H4). */
  readonly leaseExhausted: number;
  /** Non-empty means a template rendered forbidden copy — investigate before the next release. */
  readonly lintViolations: readonly LintViolationReport[];
}

export interface NotificationGateway {
  runOnce(): Promise<DispatchCycleReport>;
}

const DEFAULT_BATCH_SIZE = 100;

export function createNotificationGateway(deps: NotificationGatewayDeps): NotificationGateway {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, got ${String(batchSize)}`);
  }
  const byChannel = new Map<AlertChannel, AlertChannelAdapter>();
  for (const adapter of deps.channels) {
    if (byChannel.has(adapter.channel)) {
      throw new TypeError(`two adapters registered for channel ${adapter.channel}`);
    }
    byChannel.set(adapter.channel, adapter);
  }
  const claimLease = deps.claimLease ?? DEFAULT_CLAIM_LEASE;
  assertClaimLease(claimLease);

  const emit = (event: GatewayEvent): void => {
    deps.onEvent?.(event);
  };

  async function dispatchOne(row: ClaimedOutboxRow, counters: Counters): Promise<void> {
    // A1.9, first of two reasons this read is here: the recipient may have been erased
    // between the decision and now, and an erased recipient must not be sent to even
    // though the row is otherwise perfectly valid. The second reason is that the endpoint
    // itself lives nowhere else — the outbox stores a subscription id, never an address.
    const recipient = await deps.recipients.resolve(row);
    const verdict = dispatchVerdict({ row, now: deps.now(), recipient, params: deps.params });

    if (verdict.action === 'close') {
      await deps.queue.settle(row.id, {
        kind: 'closed',
        status: verdict.status,
        error: verdict.reason,
        dispatchedAt: null,
      });
      counters.closed += 1;
      if (verdict.reason.startsWith(CHANNEL_MISMATCH_REASON)) counters.channelMismatches += 1;
      emit({ kind: 'closed', outboxId: row.id, status: verdict.status, reason: verdict.reason });
      return;
    }
    if (verdict.action === 'release') {
      await deps.queue.settle(row.id, { kind: 'released', error: verdict.reason });
      counters.released += 1;
      emit({ kind: 'released', outboxId: row.id, reason: verdict.reason });
      return;
    }

    // `verdict.action === 'send'`, and `recipient.live` is true — the verdict cannot be
    // `send` otherwise, which is what lets the endpoint be read without a second check.
    if (!recipient.live) {
      throw new TypeError(`dispatchVerdict returned send for a dead recipient on row ${row.id}`);
    }

    const rendered = deps.renderer.render({
      templateId: row.templateId,
      templateParams: row.templateParams,
      channel: row.channel,
      // The row's own locale, decided with it — not the recipient's answer at send time.
      locale: row.locale,
      timeZone: recipient.timeZone,
    });

    const ruleIds = deps.lint(rendered, {
      channel: row.channel,
      templateId: row.templateId,
      templateParams: row.templateParams,
    });
    if (ruleIds.length > 0) {
      // D7: the copy is discarded, not trimmed. There is no safe automatic repair of a
      // message that promises something the service cannot know.
      const reason = `never_send:${ruleIds.join(',')}`;
      await deps.queue.settle(row.id, {
        kind: 'closed',
        status: 'failed',
        error: reason,
        dispatchedAt: null,
      });
      counters.closed += 1;
      counters.lintViolations.push({ outboxId: row.id, templateId: row.templateId, ruleIds });
      emit({ kind: 'lint_violation', outboxId: row.id, templateId: row.templateId, ruleIds });
      emit({ kind: 'closed', outboxId: row.id, status: 'failed', reason });
      return;
    }

    const adapter = byChannel.get(row.channel);
    if (adapter === undefined) {
      // Released, not failed: a missing adapter is a wiring mistake that the next deploy
      // fixes, and the row is still perfectly deliverable. It will retry until its D6
      // deadline, and queue age is exactly what pages an operator (D6: 600 s).
      const reason = `no adapter registered for channel ${row.channel}`;
      await deps.queue.settle(row.id, { kind: 'released', error: reason });
      counters.released += 1;
      emit({ kind: 'released', outboxId: row.id, reason });
      return;
    }

    // H4: the last check before the provider. A batch that ran long — a slow provider, a
    // rate-limit wait per row — must not start a send its claim cannot cover, or the lease
    // would expire mid-call and a second dispatcher could send the same row. Released,
    // not closed: the row is fine, only this claim is spent.
    if (!leaseAllowsSend(row.claimedAt, deps.now(), claimLease)) {
      await deps.queue.settle(row.id, { kind: 'released', error: LEASE_EXHAUSTED_REASON });
      counters.released += 1;
      counters.leaseExhausted += 1;
      emit({ kind: 'released', outboxId: row.id, reason: LEASE_EXHAUSTED_REASON });
      return;
    }

    const message: OutboundMessage = {
      outboxId: row.id,
      channel: row.channel,
      endpoint: recipient.endpoint,
      rendered,
      locale: row.locale,
      ttlSeconds: verdict.ttlSeconds,
    };
    // Stamped before the call, not after: `dispatched_at` answers "when did we hand this
    // to a provider", which is the number the p95 SLO is measured against, and it has to
    // be recorded even for a send whose acknowledgement never arrives.
    const dispatchedAt = deps.now();

    let outcome: DeliveryOutcome;
    try {
      outcome = await adapter.deliver(message);
    } catch (error) {
      // The port says an adapter reports failure by returning, so a throw is an adapter
      // bug. Treated as transient: the row goes back to the queue, and the event names
      // the adapter loudly enough to be found.
      const detail = error instanceof Error ? error.message : String(error);
      await deps.queue.settle(row.id, { kind: 'released', error: `adapter threw: ${detail}` });
      counters.released += 1;
      emit({ kind: 'adapter_threw', outboxId: row.id, error: detail });
      return;
    }

    if (outcome.kind === 'delivered') {
      await deps.queue.settle(row.id, {
        kind: 'sent',
        dispatchedAt,
        providerAckAt: outcome.providerAckAt,
      });
      counters.sent += 1;
      emit({
        kind: 'sent',
        outboxId: row.id,
        channel: row.channel,
        latencyMs: dispatchedAt - row.decidedAt,
      });
      return;
    }
    if (outcome.kind === 'transient') {
      await deps.queue.settle(row.id, { kind: 'released', error: outcome.error });
      counters.released += 1;
      emit({ kind: 'released', outboxId: row.id, reason: outcome.error });
      return;
    }

    // Permanent. The message is dead and so, usually, is the endpoint: D6 requires dead
    // tokens to be pruned on a permanent provider error, and web-push 410 to re-prompt.
    // Pruning happens before the settle so that a crash in between leaves a claimed row
    // to retry rather than a live subscription that is known to be gone.
    if (row.channelSubscriptionId !== null && outcome.subscription !== 'keep') {
      await deps.recipients.applyDisposition(row.channelSubscriptionId, outcome.subscription);
    }
    await deps.queue.settle(row.id, {
      kind: 'closed',
      status: 'failed',
      error: outcome.error,
      dispatchedAt,
    });
    counters.closed += 1;
    emit({ kind: 'closed', outboxId: row.id, status: 'failed', reason: outcome.error });
  }

  return {
    async runOnce(): Promise<DispatchCycleReport> {
      const rows = await deps.queue.claim(batchSize, deps.now());
      const counters: Counters = {
        sent: 0,
        closed: 0,
        released: 0,
        errored: 0,
        channelMismatches: 0,
        leaseExhausted: 0,
        lintViolations: [],
      };
      // Sequential on purpose. The claim already ordered the batch by A1.2 priority, and
      // dispatching in parallel would spend the provider's rate budget on whatever
      // finished first — which is precisely the ordering the priority column exists to fix.
      for (const row of rows) {
        try {
          await dispatchOne(row, counters);
        } catch (error) {
          // A port threw where the contract says it returns — a resolver outage, a
          // renderer that choked on a runtime parameter, a lint that hit an input its
          // author never imagined. The row is left claimed and will come back when the
          // claim expires; what must not happen is the rest of an ordered batch being
          // dropped because row three was unlucky.
          counters.errored += 1;
          emit({
            kind: 'row_failed',
            outboxId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return Object.freeze({
        claimed: rows.length,
        sent: counters.sent,
        closed: counters.closed,
        released: counters.released,
        errored: counters.errored,
        channelMismatches: counters.channelMismatches,
        leaseExhausted: counters.leaseExhausted,
        lintViolations: Object.freeze([...counters.lintViolations]),
      });
    },
  };
}

interface Counters {
  sent: number;
  closed: number;
  released: number;
  errored: number;
  channelMismatches: number;
  leaseExhausted: number;
  lintViolations: LintViolationReport[];
}
