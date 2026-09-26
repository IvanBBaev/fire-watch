/**
 * Decisions become outbox rows here, and nowhere else.
 *
 * ADR-004 D1 gives an outbox row three simultaneous jobs — audit trail, latency
 * instrumentation (D9), liability-defence artifact (09 §3) — and every one of them is a
 * claim about what the system knew when it decided. So this module is pure and takes its
 * instant as a parameter: a row whose `decided_at` came from a clock read inside the
 * builder could not be replayed, and a decision that cannot be replayed cannot be
 * defended.
 *
 * What it deliberately does not do:
 *
 *   * **Choose a template.** D7's registry is the gateway's (H2); `templateId` and its
 *     bound parameters arrive from the caller. Guessing one here would put copy
 *     selection in two places, and the never-send lint only runs over one of them.
 *   * **Choose a channel.** See the port: the A1.11 key has no channel column, so one
 *     decision is one delivery, and picking which one is H2's question.
 *   * **Send, or decide whether to.** `decideAlert` already decided; `isDeliverable`
 *     answers a *later* question about a row that already exists.
 */

import type { AlertDecision } from './alert-decision.js';
import type { AlertLocale } from './templates/alert-copy.js';
import type { DigestDecision, DigestEntry } from './digest.js';
import type {
  ApprovalMode,
  AlertChannel,
  OutboxRowDraft,
  OutboxStatus,
} from '../ports/alert-outbox-store.js';
import { priorityFor } from '../config/alert-gating.js';
import type { AlertGatingParams, TriggerType } from '../config/alert-gating.js';
import { ALERT_GATING } from '../config/alert-gating.js';
import type { VersionedConfig } from '../config/versioned-config.js';

/**
 * A1.4's cool-off, in milliseconds. Lives here rather than in the gating config because
 * it is not a gating threshold: it is the price of self-approval, it is quoted as
 * `approved_at − decided_at ≥ 900 s` in the amendment and repeated in the DDL comment,
 * and moving it would not be a sensitivity change — it would be a governance change.
 */
export const SOLO_COOLOFF_MS = 900_000;

/**
 * The locale a row is written with when its binding names none (migration 015's column
 * default, too). Bulgarian first, per the renderer port and A6. Neither accounts nor
 * channel subscriptions hold a language yet — migration 007 deferred it as a product
 * decision — so today this is the locale of every row.
 */
export const DEFAULT_OUTBOX_LOCALE: AlertLocale = 'bg';

/**
 * Everything a row needs that a decision does not carry: the event's storage identity,
 * the delivery target, and the copy. Supplied by the caller because each of the three
 * belongs to a different owner (the store, H2, D7's registry).
 */
export interface OutboxBinding {
  /** `fire_events.id`, decimal text. */
  readonly fireEventId: string;
  /** `fire_events.seq` as it read at decision time — D1's `trigger_ref`, second half. */
  readonly triggerRefSeq: string;
  readonly channel: AlertChannel;
  readonly channelSubscriptionId: string | null;
  /** The recipient's language; {@link DEFAULT_OUTBOX_LOCALE} when absent. */
  readonly locale?: AlertLocale;
  readonly templateId: string;
  readonly templateParams?: Readonly<Record<string, unknown>>;
  /** Epoch milliseconds. The decision instant, not the write instant. */
  readonly decidedAt: number;
  /**
   * A1.12's rank in decision order. `null` when the batch was not ranked; a rank above
   * budget B is what puts the row in `awaiting_approval` rather than `pending`, and the
   * caller passes that status because the cutoff is a property of the batch, not of any
   * one row in it.
   */
  readonly budgetSeq?: number | null;
  /** Defaults to `pending`. Only `awaiting_approval` is otherwise meaningful here. */
  readonly status?: OutboxStatus;
}

/**
 * The row for a decision, or `null` when the decision was not to send.
 *
 * `defer`, `seed` and `suppress` return `null` and that is the whole of their outbox
 * behaviour — most sharply for `seed`, where A1.8 requires state to advance to
 * `notified_new` **with no outbox row and zero sends**. A builder that emitted a
 * suppressed row "for the audit trail" would put a deliverable row in a queue whose only
 * consumer sends what it finds.
 */
export function outboxRowFor(
  decision: AlertDecision,
  binding: OutboxBinding,
  gating: VersionedConfig<AlertGatingParams> = ALERT_GATING,
): OutboxRowDraft | null {
  if (decision.outcome !== 'send') {
    return null;
  }
  // A `send` without a type or a subkey has no idempotency key, so it would insert a
  // second time on every redelivery. Structurally impossible today; asserted because the
  // failure is silent and unbounded rather than loud and once.
  if (decision.alertType === null || decision.alertSubkey === null) {
    throw new TypeError(
      `a send decision must carry an alert type and subkey, got ${JSON.stringify({
        alertType: decision.alertType,
        alertSubkey: decision.alertSubkey,
      })}`,
    );
  }
  return automaticRow(
    {
      watchZoneId: decision.zoneId,
      alertType: decision.alertType,
      alertSubkey: decision.alertSubkey,
      ruleVersion: decision.ruleVersion,
      priority: decision.priority,
    },
    binding,
    gating,
  );
}

/**
 * The rows for a digest, one per folded entry (A1.11's key is per `(zone, event)`, so a
 * digest of six fires is six rows sharing one subkey — the window start — and not one
 * row listing six). Empty unless the digest was actually due: a `hold` is owed to a
 * later window and writing it now would spend it.
 *
 * `bindingFor` is asked once per entry because each entry names a different event, and
 * the storage id and copy parameters differ with it. Returning `null` from it drops that
 * entry — the caller's escape hatch for an event that vanished between decision and write.
 */
export function digestOutboxRows(
  decision: DigestDecision,
  bindingFor: (entry: DigestEntry) => OutboxBinding | null,
  gating: VersionedConfig<AlertGatingParams> = ALERT_GATING,
): readonly OutboxRowDraft[] {
  if (decision.outcome !== 'send' || decision.alertType === null || decision.alertSubkey === null) {
    return [];
  }
  const alertType = decision.alertType;
  const alertSubkey = decision.alertSubkey;
  const rows: OutboxRowDraft[] = [];
  for (const entry of decision.entries) {
    const binding = bindingFor(entry);
    if (binding === null) {
      continue;
    }
    rows.push(
      automaticRow(
        {
          watchZoneId: entry.zoneId,
          alertType,
          alertSubkey,
          ruleVersion: decision.ruleVersion,
          priority: decision.priority,
        },
        binding,
        gating,
      ),
    );
  }
  return rows;
}

/**
 * The one row for one zone's share of a digest — what the live digest pass writes
 * (`digest-pass.ts`), where {@link digestOutboxRows} is the replay's per-entry shape.
 *
 * The live pass groups the folded entries by the zone that renders them (A1.12) and
 * writes one message per group, so the row names the group's zone and — because A1.11's
 * key is `(zone, event, type, subkey)` and `fire_event_id` is NOT NULL — its nearest
 * fire as the carrier event. The subkey is still the window start, so one zone gets at
 * most one digest per window per carrier, and the pass's digest log (migration 018) keeps
 * a second carrier from ever being chosen for the same window. The group's full line list
 * travels in the binding's `templateParams`, which the caller took from the reviewed copy.
 *
 * Throws unless the decision is a `send` and the zone renders the first entry it is given:
 * a carrier row for a `hold`, or for a zone that renders none of the lines, would be a
 * message nobody decided.
 */
export function digestZoneOutboxRow(
  decision: DigestDecision,
  zoneId: string,
  entries: readonly DigestEntry[],
  binding: OutboxBinding,
  gating: VersionedConfig<AlertGatingParams> = ALERT_GATING,
): OutboxRowDraft {
  if (decision.outcome !== 'send' || decision.alertType === null || decision.alertSubkey === null) {
    throw new TypeError(`a digest row needs a send decision, got ${decision.outcome}`);
  }
  const [carrier] = entries;
  if (carrier === undefined || entries.some((entry) => entry.zoneId !== zoneId)) {
    throw new TypeError('a digest row needs a non-empty group of entries rendered by its zone');
  }
  return automaticRow(
    {
      watchZoneId: zoneId,
      alertType: decision.alertType,
      alertSubkey: decision.alertSubkey,
      ruleVersion: decision.ruleVersion,
      priority: decision.priority,
    },
    binding,
    gating,
  );
}

/** The fields an automatic row takes from whichever decision produced it. */
interface AutomaticFacts {
  readonly watchZoneId: string;
  readonly alertType: 'new_fire' | 'escalation' | 'digest';
  readonly alertSubkey: string;
  readonly ruleVersion: string;
  readonly priority: number | null;
}

function automaticRow(
  facts: AutomaticFacts,
  binding: OutboxBinding,
  gating: VersionedConfig<AlertGatingParams>,
): OutboxRowDraft {
  // On an automatic row the trigger and the alert are the same thing — migration 003's
  // CHECK says so too. Only `manual` is allowed to differ.
  const triggerType: TriggerType = facts.alertType;
  return {
    watchZoneId: facts.watchZoneId,
    fireEventId: binding.fireEventId,
    alertType: facts.alertType,
    alertSubkey: facts.alertSubkey,
    triggerType,
    triggerRefSeq: binding.triggerRefSeq,
    ruleVersion: facts.ruleVersion,
    templateId: binding.templateId,
    templateParams: binding.templateParams ?? {},
    channel: binding.channel,
    channelSubscriptionId: binding.channelSubscriptionId,
    locale: binding.locale ?? DEFAULT_OUTBOX_LOCALE,
    // The decision already computed this from the same pure function; recomputing it
    // when it is absent keeps the column NOT NULL without letting the two disagree.
    priority: facts.priority ?? priorityFor(triggerType, gating.values),
    budgetSeq: binding.budgetSeq ?? null,
    status: binding.status ?? 'pending',
    actorId: null,
    approverId: null,
    approvalMode: null,
    approvedAt: null,
    budgetOverride: false,
    decidedAt: binding.decidedAt,
  };
}

/**
 * A human-initiated row (A1.1): the over-budget continuation of an automatic event, or
 * an operator incident notice.
 *
 * `alertType` stays one of the three, because `manual` describes the trigger and not
 * what anyone is told — a person reading the notification is being told about a fire.
 * `manual` is not free text either: D7 stands unconditionally, so this takes a
 * `templateId` exactly as the automatic path does.
 *
 * The approver may be absent here. That is the point of `awaiting_approval`: the row is
 * written first so a second human has something to approve, and {@link isDeliverable} —
 * not this builder — is what refuses to send it until they have.
 */
export interface ManualSendInput extends OutboxBinding {
  readonly watchZoneId: string;
  readonly alertType: 'new_fire' | 'escalation' | 'digest';
  readonly alertSubkey: string;
  readonly ruleVersion: string;
  /** The human who initiated. Required — that is what makes the row manual. */
  readonly actorId: string;
  readonly approverId?: string | null;
  readonly approvalMode?: ApprovalMode | null;
  readonly approvedAt?: number | null;
  /** Released past budget B (D5). */
  readonly budgetOverride?: boolean;
}

export function manualOutboxRow(
  input: ManualSendInput,
  gating: VersionedConfig<AlertGatingParams> = ALERT_GATING,
): OutboxRowDraft {
  if (input.actorId.length === 0) {
    throw new TypeError('a manual row must name the human who initiated it');
  }
  return {
    watchZoneId: input.watchZoneId,
    fireEventId: input.fireEventId,
    alertType: input.alertType,
    alertSubkey: input.alertSubkey,
    triggerType: 'manual',
    triggerRefSeq: input.triggerRefSeq,
    ruleVersion: input.ruleVersion,
    templateId: input.templateId,
    templateParams: input.templateParams ?? {},
    channel: input.channel,
    channelSubscriptionId: input.channelSubscriptionId,
    locale: input.locale ?? DEFAULT_OUTBOX_LOCALE,
    // 0 — A1.2 puts a human ahead of every automatic class, because the two cases that
    // reach here are an operator correcting something and a mega-fire already past B.
    priority: priorityFor('manual', gating.values),
    budgetSeq: input.budgetSeq ?? null,
    status: input.status ?? 'awaiting_approval',
    actorId: input.actorId,
    approverId: input.approverId ?? null,
    approvalMode: input.approvalMode ?? null,
    approvedAt: input.approvedAt ?? null,
    budgetOverride: input.budgetOverride ?? false,
    decidedAt: input.decidedAt,
  };
}

/** One word for why a row may not be sent. Empty string is not one of them. */
export const UNDELIVERABLE_REASONS = [
  'missing_trigger_ref',
  'missing_rule_version',
  'missing_template',
  'unaccountable_manual',
  'self_approved',
  'cooloff_not_served',
] as const;
export type UndeliverableReason = (typeof UNDELIVERABLE_REASONS)[number];

export type DeliverabilityVerdict =
  | { readonly deliverable: true }
  | { readonly deliverable: false; readonly reason: UndeliverableReason };

const DELIVERABLE: DeliverabilityVerdict = Object.freeze({ deliverable: true });

/**
 * D1's refusal rule, as amended by A1.1 and A1.4 — the gateway's, expressed once so that
 * the gateway (H2) and any audit of the table answer it the same way.
 *
 * It is a predicate over a row that already exists, not a constraint on writing one, and
 * that distinction is the whole approval flow: a manual row is *written* without an
 * approver precisely so a second human can supply one. Migration 003 says the same thing
 * by leaving this out of the DDL.
 */
export function isDeliverable(row: OutboxRowDraft): DeliverabilityVerdict {
  if (row.triggerRefSeq.length === 0) {
    return { deliverable: false, reason: 'missing_trigger_ref' };
  }
  if (row.ruleVersion.length === 0) {
    return { deliverable: false, reason: 'missing_rule_version' };
  }
  if (row.templateId.length === 0) {
    return { deliverable: false, reason: 'missing_template' };
  }
  // A1.1: the accountability check covers manual rows *and* anything released past B,
  // "whatever its trigger type" — an automatic row pushed over the ceiling by a human is
  // exactly as much a human act as a manual one.
  if (row.triggerType !== 'manual' && !row.budgetOverride) {
    return DELIVERABLE;
  }
  if (row.actorId === null || row.approverId === null) {
    return { deliverable: false, reason: 'unaccountable_manual' };
  }
  if (row.approverId === row.actorId && row.approvalMode !== 'solo_cooloff') {
    return { deliverable: false, reason: 'self_approved' };
  }
  if (row.approvalMode === 'solo_cooloff') {
    // A1.4's first condition. The other three — the impact preview re-read, the caps,
    // and "it never raises B or G" — are not decidable from the row: two of them need
    // the rest of the table and one needs a human's screen. They belong to the approval
    // surface, and this returning true is not a claim that they were met.
    if (row.approvedAt === null || row.approvedAt - row.decidedAt < SOLO_COOLOFF_MS) {
      return { deliverable: false, reason: 'cooloff_not_served' };
    }
  }
  return DELIVERABLE;
}
