/**
 * The transactional outbox over Postgres.
 *
 * One statement, and its whole job is to be a no-op the second time it runs:
 * `INSERT ... ON CONFLICT (watch_zone_id, fire_event_id, alert_type, alert_subkey)
 * DO NOTHING` is A1.11's anti-spam invariant enforced by the database rather than by a
 * read-then-write the caller would have to get right under concurrency. A redelivered
 * decision conflicts, inserts nothing, and is reported as `alreadyDecided` — not as an
 * error, because a retried poll deciding the same pair again is the normal case.
 *
 * As with the archive, rows go in through `unnest` of one array per column: twenty-one
 * parameters no matter how large the batch, which keeps a fast-moving August afternoon
 * with several hundred zone/event pairs away from the 65,535-parameter wire limit.
 *
 * The adapter opens no transaction. D1 requires the outbox write to be atomic with the
 * `alert_states` write, and that second write is behind another port, so the caller
 * passes in whichever `PgQueryable` it has already put a `BEGIN` on. Handing this module
 * a `Pool` is legal and gives each batch its own implicit transaction; handing it a
 * client mid-transaction is what D1 actually asks for.
 */

import type {
  AlertOutboxStore,
  EnqueueResult,
  OutboxRowDraft,
} from '../../core/ports/alert-outbox-store.js';

/**
 * The slice of `pg` this module uses — the same structural shape the archive declares,
 * redeclared rather than imported so that neither adapter becomes the other's
 * dependency. A `Pool`, a `Client` and a transaction handle all satisfy it.
 */
export interface PgQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number | null }>;
}

const OUTBOX_COLUMNS = [
  'watch_zone_id',
  'fire_event_id',
  'alert_type',
  'alert_subkey',
  'trigger_type',
  'trigger_ref_seq',
  'rule_version',
  'template_id',
  'template_params',
  'channel',
  'channel_subscription_id',
  'locale',
  'priority',
  'budget_seq',
  'status',
  'actor_id',
  'approver_id',
  'approval_mode',
  'approved_at',
  'budget_override',
  'decided_at',
] as const;

/**
 * One cast per column, positionally matched to {@link OUTBOX_COLUMNS}. `template_params`
 * travels as `text` and is cast to `jsonb` in the projection below rather than being
 * bound as a `jsonb[]`: an array of JSON documents has to survive the driver's array
 * literal encoder, and one template parameter containing a brace or a quote is enough to
 * make that a question about escaping instead of a question about alerts.
 */
const OUTBOX_CASTS = [
  'uuid',
  'bigint',
  'text',
  'text',
  'text',
  'bigint',
  'text',
  'text',
  'text',
  'text',
  'uuid',
  'text',
  'integer',
  'integer',
  'text',
  'text',
  'text',
  'text',
  'timestamptz',
  'boolean',
  'timestamptz',
] as const;

/** The column expression list — identity everywhere except the JSON round-trip. */
const OUTBOX_PROJECTION = OUTBOX_COLUMNS.map((column) =>
  column === 'template_params' ? 'template_params::jsonb' : column,
).join(', ');

const INSERT_OUTBOX_ROWS = buildInsertOutboxRows();

function buildInsertOutboxRows(): string {
  const columns = OUTBOX_COLUMNS.join(', ');
  const arrays = OUTBOX_CASTS.map((cast, index) => `$${String(index + 1)}::${cast}[]`).join(', ');
  return (
    `INSERT INTO alert_outbox (${columns})\n` +
    `SELECT ${OUTBOX_PROJECTION} FROM unnest(${arrays}) AS batch(${columns})\n` +
    'ON CONFLICT (watch_zone_id, fire_event_id, alert_type, alert_subkey) DO NOTHING'
  );
}

export function createPgAlertOutboxStore(db: PgQueryable): AlertOutboxStore {
  return {
    async enqueue(rows: readonly OutboxRowDraft[]): Promise<EnqueueResult> {
      if (rows.length === 0) {
        // A poll that decided nothing is not a reason to touch the outbox.
        return { received: 0, inserted: 0, alreadyDecided: 0 };
      }

      const result = await db.query(INSERT_OUTBOX_ROWS, outboxArrays(rows));
      const inserted = result.rowCount ?? 0;
      return {
        received: rows.length,
        inserted,
        alreadyDecided: rows.length - inserted,
      };
    },
  };
}

/** One array per column, in {@link OUTBOX_COLUMNS} order. */
export function outboxArrays(rows: readonly OutboxRowDraft[]): readonly unknown[][] {
  return [
    rows.map((row) => row.watchZoneId),
    rows.map((row) => row.fireEventId),
    rows.map((row) => row.alertType),
    rows.map((row) => row.alertSubkey),
    rows.map((row) => row.triggerType),
    rows.map((row) => row.triggerRefSeq),
    rows.map((row) => row.ruleVersion),
    rows.map((row) => row.templateId),
    rows.map((row) => JSON.stringify(row.templateParams)),
    rows.map((row) => row.channel),
    rows.map((row) => row.channelSubscriptionId),
    rows.map((row) => row.locale),
    rows.map((row) => row.priority),
    rows.map((row) => row.budgetSeq),
    rows.map((row) => row.status),
    rows.map((row) => row.actorId),
    rows.map((row) => row.approverId),
    rows.map((row) => row.approvalMode),
    rows.map((row) => nullableIsoTimestamp(row.approvedAt)),
    rows.map((row) => row.budgetOverride),
    rows.map((row) => isoTimestamp(row.decidedAt, 'decided_at')),
  ];
}

/** Exported for the tests that assert the statement's shape rather than its effect. */
export const INSERT_OUTBOX_ROWS_SQL = INSERT_OUTBOX_ROWS;

function isoTimestamp(epochMs: number, column: string): string {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`${column} must be a finite epoch, got ${String(epochMs)}`);
  }
  return new Date(epochMs).toISOString();
}

function nullableIsoTimestamp(epochMs: number | null): string | null {
  return epochMs === null ? null : isoTimestamp(epochMs, 'approved_at');
}
