/**
 * What account erasure does to each table, and what survives it and why (TASKS I4;
 * ADR-004 D8, A1.3, A1.9; 14 M3; migration 010).
 *
 * The plan is data so that three readers agree on one list: the pg adapter executes it
 * (`adapters/db/pg-account-erasure.ts`), the integration test asserts that every table
 * migration 010's registry classes `personal` has a rule here (a new personal table with
 * no rule fails there, not in production), and the drill (I7) reads it as the expected
 * outcome.
 *
 * **Deleted** — the row is gone from the live database in the erasure transaction.
 * **Pseudonymized** — the row stays, rewritten in place under A1.3: what survives names a
 * decision, never a recipient. **Tombstoned** — the account row stays as a scrubbed marker
 * so that a request already in flight for that account is refused by migration 010's
 * triggers rather than recreating data under it; its own purge is unarmed (see
 * `purge-plan.ts`). **Recorded** — the ledger row that makes the erasure provable.
 *
 * Open items ship unarmed and are named in {@link ERASURE_OPEN_ITEMS}; none of them widens
 * what survives.
 */

/**
 * v2: `channel_confirmations` (migration 012, TASKS I3) joined the deleted tables.
 * v3: `alert_decision_log` (migration 014, TASKS H7) joined them, by the zone cascade.
 * v4: `alert_outbox.claimed_at` and `alert_outbox.locale` (migration 015, TASKS H4/H5)
 *     joined what survives pseudonymization.
 * v5: `alert_digest_log` (migration 018, TASKS H3/D9) joined the deleted tables, by the
 *     zone cascade.
 */
export const ERASURE_PLAN_VERSION = 'erasure_plan_v5';

export type ErasureAction = 'delete' | 'pseudonymize' | 'tombstone' | 'record';

export interface TableErasureRule {
  readonly table: string;
  readonly action: ErasureAction;
  /** Which rows: always selected by the account, directly or through its zones. */
  readonly scope: string;
  /** Columns that outlive the transaction on the rows the rule keeps. Empty for a delete. */
  readonly survives: readonly string[];
  /** Why whatever survives may survive — or why nothing does. */
  readonly reason: string;
  readonly spec: string;
}

/** The outbox statuses erasure moves to `cancelled_erasure` (A1.9): everything not yet final. */
export const ERASURE_CANCELLABLE_STATUSES = ['pending', 'awaiting_approval', 'claimed'] as const;

/**
 * Template parameter keys A1.3 keeps at pseudonymization ("leaving `template_id` plus
 * non-personal parameters"). **Empty on purpose:** there is no registry of template
 * parameters yet, so nothing can be shown to be non-personal, and the fail-closed answer
 * is to drop them all. That also drops the rendered distance band A1.3 would retain —
 * a loss of audit detail, never a leak. Filling this list is an open item.
 */
export const RETAINED_TEMPLATE_PARAM_KEYS: readonly string[] = [];

export const ERASURE_PLAN: readonly TableErasureRule[] = [
  {
    table: 'alert_outbox',
    action: 'pseudonymize',
    scope:
      "every row of the account's zones, soft-deleted zones included; pending, awaiting_approval and claimed rows are first closed cancelled_erasure",
    survives: [
      'id',
      'fire_event_id',
      'alert_type',
      'alert_subkey',
      'trigger_type',
      'trigger_ref_seq',
      'rule_version',
      'template_id',
      'channel',
      'priority',
      'budget_seq',
      'budget_override',
      'status',
      'decided_at',
      'approved_at',
      'dispatched_at',
      'provider_ack_at',
      'last_error',
      'actor_id',
      'approver_id',
      'approval_mode',
      'claimed_at',
      'locale',
      'pseudonymized_at',
    ],
    reason:
      'A1.3: the liability defence needs the decision, not the recipient. watch_zone_id and channel_subscription_id become NULL and template_params keeps only RETAINED_TEMPLATE_PARAM_KEYS. A cancelled row is the evidence the send was stopped (A1.9). claimed_at is a pipeline timestamp and locale names which copy of the decision was sent; neither names a recipient (migration 015).',
    spec: 'ADR-004 A1.3, A1.9; OPERATIONS §6.2 rule 7',
  },
  {
    table: 'alert_states',
    action: 'delete',
    scope: "every row keyed by one of the account's zones",
    survives: [],
    reason: 'keyed by zone; nothing in it is evidence of a decision',
    spec: 'ADR-004 D8',
  },
  {
    table: 'alerts_shadow',
    action: 'delete',
    scope: "every row of the account's zones, by the ON DELETE CASCADE from watch_zones",
    survives: [],
    reason: 'keyed by zone; the shadow log compares rule sets and needs no erased recipient',
    spec: 'migration 006 header',
  },
  {
    table: 'alert_decision_log',
    action: 'delete',
    scope: "every row of the account's zones, by the ON DELETE CASCADE from watch_zones",
    survives: [],
    reason:
      "keyed by zone; a send's decision survives in the pseudonymized outbox row, and a defer or a suppress notified no one, so there is no delivery to defend",
    spec: 'migration 014 header; ADR-004 D8',
  },
  {
    table: 'alert_digest_log',
    action: 'delete',
    scope: "every row of the account's zones, by the ON DELETE CASCADE from watch_zones",
    survives: [],
    reason:
      "keyed by zone; a sent digest's decision survives in the pseudonymized outbox row, and a hold or a suppress notified no one, so there is no delivery to defend. The account ceases to exist, so no digest watermark is owed to it",
    spec: 'migration 018 header; ADR-004 D8',
  },
  {
    table: 'watch_zones',
    action: 'delete',
    scope:
      'every zone of the account, soft-deleted ones included (they still hold the sealed centre)',
    survives: [],
    reason: 'the home location is the most sensitive thing the system stores',
    spec: 'ADR-004 D8',
  },
  {
    table: 'channel_confirmations',
    action: 'delete',
    scope:
      'every confirmation of the account, consumed, superseded, revoked and still-pending ones included; deleted before the subscriptions they name',
    survives: [],
    reason:
      'the rows are keyed by the account and name its endpoints; a Telegram link still pending has no subscription, so the subscription cascade alone would miss it',
    spec: 'ADR-004 D6, D8; 05 §5.5.3',
  },
  {
    table: 'channel_subscriptions',
    action: 'delete',
    scope: 'every subscription of the account, revoked ones included',
    survives: [],
    reason: 'provider endpoints are personal data and address a device or a chat',
    spec: 'ADR-004 D2, D8',
  },
  {
    table: 'account_sessions',
    action: 'delete',
    scope: 'every session of the account, revoked and expired ones included',
    survives: [],
    reason: 'deletion is revocation plus erasure of the UA family and timestamps',
    spec: '05 §5.4.1',
  },
  {
    table: 'auth_link_requests',
    action: 'delete',
    scope: "every link request for the account's address, consumed or not",
    survives: [],
    reason:
      'the rows carry the address; the account ceases to exist, so no rate limit is owed to it',
    spec: '05 §5.4.1 C2',
  },
  {
    table: 'accounts',
    action: 'tombstone',
    scope: 'the account row',
    survives: ['id', 'created_at', 'deleted_at'],
    reason:
      'email and email_verified_at become NULL and preferences return to their defaults; the scrubbed row lets migration 010 refuse an in-flight write for the account instead of recreating data under it',
    spec: 'migration 010',
  },
  {
    table: 'erasure_requests',
    action: 'record',
    scope: 'one row per erasure',
    survives: ['account_hash', 'erased_at', 'deadline_at', 'counts', 'plan_version'],
    reason:
      'the proof the erasure ran and the list a restore inside the backup window must replay; the account is present only as a SHA-256 of its id',
    spec: 'migration 010',
  },
];

/** Decisions this plan needed and does not make. Each one ships unarmed or fail-closed. */
export const ERASURE_OPEN_ITEMS = [
  'A1.3 salted zone hash with a per-year salt: not built; watch_zone_id is set to NULL, which is the stronger form and what OPERATIONS §6.2 rule 7 already does for backups',
  'RETAINED_TEMPLATE_PARAM_KEYS is empty until a template parameter registry names the non-personal keys (A1.3 would keep the distance band)',
  'restore replay: the ledger must survive a disaster independently of the database it describes (J2 runbook), otherwise an erasure after the restored night is resurrected',
  'erasure_requests backup class is personal (the fail-closed default); moving it to main is a founder decision',
  'grace period or confirmation step before erasure (UX); the route erases immediately',
] as const;

/** A1.3's cancel set as a predicate, so the core and its tests share one definition. */
export function isCancelledByErasure(status: string): boolean {
  return (ERASURE_CANCELLABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * The template parameters that survive pseudonymization: exactly the retained keys, in the
 * order they appear. Pure, and what the SQL does, so a test can hold the two to one rule.
 */
export function retainedTemplateParams(
  params: Readonly<Record<string, unknown>>,
  keys: readonly string[] = RETAINED_TEMPLATE_PARAM_KEYS,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (keys.includes(key)) kept[key] = value;
  }
  return kept;
}
