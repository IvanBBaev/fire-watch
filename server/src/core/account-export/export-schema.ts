/**
 * What a self-serve account export contains, table by table and column by column
 * (TASKS I6; GDPR Art. 15 and 20; 05 §5.3.7 "account, zones, notification history as JSON").
 *
 * **The table set is the erasure plan's.** Whatever erasure touches is personal data about
 * the account, so the export reads exactly those tables: an export that missed a table
 * erasure deletes would under-answer an access request, and a table the export read that
 * erasure did not touch would be personal data that outlives an erasure. The tests pin
 * `ACCOUNT_EXPORT_TABLES` to `ERASURE_PLAN`, in this module and again in the pg adapter,
 * so the two cannot drift.
 *
 * **Every column is either exported or withheld with a reason.** `EXPORT_COLUMNS` is an
 * allow-list: the builder refuses a row that carries anything else, so a token hash cannot
 * leak by an adapter selecting `*`. The pg integration test compares the allow-list plus
 * `EXPORT_WITHHELD` against the live `information_schema`, so a column added by a future
 * migration fails that test until it is placed on one side or the other.
 *
 * Column names are the database's own (snake_case), so every value in a document can be
 * traced to a migration without a mapping table.
 */

/** Same order as `ERASURE_PLAN`. */
export const ACCOUNT_EXPORT_TABLES = [
  'alert_outbox',
  'alert_states',
  'alerts_shadow',
  'alert_decision_log',
  'alert_digest_log',
  'watch_zones',
  'channel_confirmations',
  'channel_subscriptions',
  'account_sessions',
  'auth_link_requests',
  'accounts',
  'erasure_requests',
] as const;

export type AccountExportTable = (typeof ACCOUNT_EXPORT_TABLES)[number];

/**
 * How the adapter must hand a column over, so the core never sees a driver type:
 *   - `id` / `text`: a string (uuid as its canonical text);
 *   - `bigint`: a decimal string — 2^53 is not a bound the database promises;
 *   - `timestamp`: ISO 8601 in UTC; `time`: `HH:MM`;
 *   - `integer` / `real`: a finite number; `boolean`: a boolean;
 *   - `json`: the stored JSON; `geojson`: a geography rendered as a GeoJSON object.
 * Any of them may be NULL.
 */
export type ExportColumnKind =
  | 'id'
  | 'text'
  | 'bigint'
  | 'timestamp'
  | 'time'
  | 'integer'
  | 'real'
  | 'boolean'
  | 'json'
  | 'geojson';

export type ExportColumns = Readonly<Record<string, ExportColumnKind>>;

export const EXPORT_COLUMNS: Readonly<Record<AccountExportTable, ExportColumns>> = {
  // 001 + 003; 010 made `watch_zone_id` nullable once a row is pseudonymized.
  alert_outbox: {
    id: 'bigint',
    watch_zone_id: 'id',
    fire_event_id: 'bigint',
    alert_type: 'text',
    alert_subkey: 'text',
    trigger_type: 'text',
    trigger_ref_seq: 'bigint',
    rule_version: 'text',
    template_id: 'text',
    template_params: 'json',
    channel: 'text',
    channel_subscription_id: 'id',
    priority: 'integer',
    budget_seq: 'integer',
    budget_override: 'boolean',
    status: 'text',
    approval_mode: 'text',
    approved_at: 'timestamp',
    decided_at: 'timestamp',
    dispatched_at: 'timestamp',
    provider_ack_at: 'timestamp',
    last_error: 'text',
    pseudonymized_at: 'timestamp',
    // 015
    claimed_at: 'timestamp',
    locale: 'text',
  },
  // 001
  alert_states: {
    watch_zone_id: 'id',
    fire_event_id: 'bigint',
    state: 'text',
    escalation_watermark: 'integer',
    seeded_at: 'timestamp',
    last_notified_at: 'timestamp',
    updated_at: 'timestamp',
  },
  // 006
  alerts_shadow: {
    candidate_version: 'text',
    watch_zone_id: 'id',
    shadow_event_key: 'text',
    alert_type: 'text',
    alert_subkey: 'text',
    trigger_type: 'text',
    rule_version: 'text',
    template_id: 'text',
    template_params: 'json',
    decided_at: 'timestamp',
    recorded_at: 'timestamp',
  },
  // 014. Codes and the rule version only: the row never held a score or rendered copy.
  alert_decision_log: {
    id: 'bigint',
    watch_zone_id: 'id',
    fire_event_id: 'bigint',
    trigger_ref_seq: 'bigint',
    pass: 'text',
    outcome: 'text',
    reason: 'text',
    code: 'text',
    alert_type: 'text',
    ladder_step: 'integer',
    in_quiet_hours: 'boolean',
    rule_version: 'text',
    decided_at: 'timestamp',
    recorded_at: 'timestamp',
  },
  // 018. The outcome, its reason and a line count: which fires a digest listed is in the
  // outbox row it wrote, never here.
  alert_digest_log: {
    id: 'bigint',
    watch_zone_id: 'id',
    window_start: 'timestamp',
    outcome: 'text',
    reason: 'text',
    entry_count: 'integer',
    rule_version: 'text',
    decided_at: 'timestamp',
    recorded_at: 'timestamp',
  },
  // 001 + 007. The sealed centre is withheld; the builder adds the opened `centre`.
  watch_zones: {
    id: 'id',
    account_id: 'id',
    name: 'text',
    area: 'geojson',
    radius_m: 'integer',
    min_score: 'real',
    centre_coarsened: 'boolean',
    grid_version: 'text',
    grid_cell: 'text',
    created_at: 'timestamp',
    deleted_at: 'timestamp',
  },
  // 012
  channel_confirmations: {
    id: 'id',
    account_id: 'id',
    channel: 'text',
    channel_subscription_id: 'id',
    issued_at: 'timestamp',
    expires_at: 'timestamp',
    consumed_at: 'timestamp',
    superseded_at: 'timestamp',
    revoked_at: 'timestamp',
  },
  // 001 + 012
  channel_subscriptions: {
    id: 'id',
    account_id: 'id',
    channel: 'text',
    endpoint: 'text',
    created_at: 'timestamp',
    confirmed_at: 'timestamp',
    revoked_at: 'timestamp',
  },
  // 007
  account_sessions: {
    id: 'id',
    account_id: 'id',
    ua_family: 'text',
    created_at: 'timestamp',
    last_seen_at: 'timestamp',
    expires_at: 'timestamp',
    revoked_at: 'timestamp',
  },
  // 007
  auth_link_requests: {
    id: 'id',
    email: 'text',
    ua_family: 'text',
    requested_at: 'timestamp',
    expires_at: 'timestamp',
    consumed_at: 'timestamp',
    superseded_at: 'timestamp',
  },
  // 001 + 007
  accounts: {
    id: 'id',
    email: 'text',
    email_verified_at: 'timestamp',
    timezone: 'text',
    quiet_hours_start: 'time',
    quiet_hours_end: 'time',
    new_fire_overrides_quiet_hours: 'boolean',
    created_at: 'timestamp',
    deleted_at: 'timestamp',
  },
  // 010
  erasure_requests: {
    erased_at: 'timestamp',
    deadline_at: 'timestamp',
    plan_version: 'text',
    counts: 'json',
  },
};

export interface WithheldColumn {
  readonly table: AccountExportTable;
  readonly column: string;
  readonly reason: string;
}

/**
 * Columns that exist and are deliberately not exported. Each reason is shown to the
 * person in the document itself (`withheld`), so the export is honest about its gaps.
 * The Art. 15(4) and security reasons are positions for legal review (docs/legal/dpia.md).
 */
export const EXPORT_WITHHELD: readonly WithheldColumn[] = [
  {
    table: 'alert_outbox',
    column: 'approver_id',
    reason:
      'Identifies the operator who approved a held alert: personal data of another person ' +
      '(GDPR Art. 15(4)). Whether an alert needed approval is exported as approval_mode.',
  },
  {
    table: 'alert_outbox',
    column: 'actor_id',
    reason:
      'Identifies the operator or process that triggered the alert (migration 003): data ' +
      'about another person or an internal system, not about you. trigger_type is exported.',
  },
  {
    table: 'watch_zones',
    column: 'centre_ciphertext',
    reason:
      'The encrypted form of the zone centre (migration 007). The decrypted centre is ' +
      'exported as the derived field centre.',
  },
  {
    table: 'watch_zones',
    column: 'centre_key_id',
    reason: 'Names the server key that encrypts the zone centre; it says nothing about you.',
  },
  {
    table: 'channel_confirmations',
    column: 'token_hash',
    reason:
      'A one-way hash of a confirmation token (migration 012). A security control, not ' +
      'information about you; exporting it would only widen what a leaked export exposes.',
  },
  {
    table: 'account_sessions',
    column: 'token_hash',
    reason:
      'A one-way hash of a sign-in session token (migration 007). A security control, not ' +
      'information about you.',
  },
  {
    table: 'auth_link_requests',
    column: 'token_hash',
    reason:
      'A one-way hash of a sign-in link token (migration 007). A security control, not ' +
      'information about you.',
  },
  {
    table: 'erasure_requests',
    column: 'account_hash',
    reason:
      'A SHA-256 of the account id, used to find a ledger row without storing the id ' +
      '(migration 010). The account id itself is exported under accounts.',
  },
];

/**
 * How each table's rows are found for one account. Every scope is the erasure plan's:
 * the same predicate that deletes a row is the one that exports it.
 */
export type ExportScopeKind = 'account' | 'zones' | 'email' | 'account_hash';

export const EXPORT_SCOPES: Readonly<Record<AccountExportTable, ExportScopeKind>> = {
  alert_outbox: 'zones',
  alert_states: 'zones',
  alerts_shadow: 'zones',
  alert_decision_log: 'zones',
  alert_digest_log: 'zones',
  watch_zones: 'account',
  channel_confirmations: 'account',
  channel_subscriptions: 'account',
  account_sessions: 'account',
  auth_link_requests: 'email',
  accounts: 'account',
  erasure_requests: 'account_hash',
};

/**
 * What an export cannot contain, stated in every document so that "complete" is never
 * claimed for something it is not.
 */
export const EXPORT_LIMITS: readonly string[] = [
  'Notification rows already pseudonymized under the 24-month rule (ADR-004 A1.3) no ' +
    'longer carry your zone and cannot be found for your account; they are not included.',
  'Server access logs (IP address, user agent), kept at most 30 days (05 §5.3.3), are ' +
    'not part of this export; ask the controller if you need them.',
  'Delivery records held by the providers that carried a notification (the mail ' +
    'provider, Telegram, the push service of your browser) are held by them, not by us.',
  'Backups made before this export contain the same data and expire on their own ' +
    'schedule (at most 28 days for personal data).',
];
