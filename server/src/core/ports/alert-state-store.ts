/**
 * The per-`(zone, event)` state machine's persistence, as the core sees it — ADR-004 D3
 * as amended by A1.8/A1.11.
 *
 * The ladder itself is pure and lives in `core/registry/alert-state.ts`; the decision that
 * moves it is pure and lives in `core/alerts/alert-decision.ts`. What is left is the one
 * thing neither can do: read the row that says what this zone has already been told, and
 * write back the row the decision computed — **inside the transaction that also writes the
 * outbox**. D1 is explicit that the state change and the row it produced are atomic, so
 * this port, like {@link import('./alert-outbox-store.js').AlertOutboxStore}, opens no
 * transaction of its own. The adapter's handle is structural precisely so the caller can
 * hand both stores the same client after a `BEGIN`.
 *
 * **Read inside the transaction, or the seed is lost.** Every row this port writes is a
 * whole row, not a delta: `state`, `escalation_watermark`, `seeded_at` and
 * `last_notified_at` are written together from what the decision returned. That is what
 * makes a replay of a decision produce exactly the row the decision describes — and it is
 * also why the values must come from a read taken in the same transaction. An upsert built
 * from a row read before the transaction opened will happily write `seeded_at = null` over
 * an A1.8 seed, which turns a silently-seeded pre-existing fire back into news.
 *
 * **The outbox key stays the anti-spam backstop.** Nothing here re-derives the ladder in
 * SQL, and nothing here refuses a write that looks like a regression. A1.11's four-column
 * `UNIQUE` is what makes a re-crossed step a no-op; this table is the state that key is
 * computed *from*, and a second opinion expressed as a SQL `CASE` would be a second rule
 * set nobody could version.
 *
 * **Reading and writing are one port, and that is a considered choice.** The outbox split
 * its read side into a separate port because the two halves have different owners and
 * different transactions — the gateway claims rows that the engine wrote. Neither is true
 * here: the same evaluation reads these rows and writes them back, in one transaction, and
 * splitting them would only mean two objects threaded through the same call. What is split
 * is the *capability*: {@link AlertStateReader} is the read half on its own, so the "why no
 * alert?" explainability surface (H7) and the onboarding list of A1.8 can be given a
 * reference that provably cannot advance the ladder while rendering it.
 */

import type { AlertStateKey, AlertStateRow } from '../registry/alert-state.js';

/**
 * The read half. Everything is a batch: one poll evaluates every zone that intersects
 * every event it touched, and a per-pair `SELECT` inside that loop is the shape that turns
 * an August afternoon into a few thousand round trips.
 */
export interface AlertStateReader {
  /**
   * The stored rows for these exact `(zone, event)` pairs. Pairs with no row are simply
   * absent from the result — `none` is the absence of a row, not a stored value, and a
   * reader that invented one would have to invent its `seeded_at` too. Order is not
   * promised; callers index by the pair.
   */
  loadStates(keys: readonly AlertStateKey[]): Promise<readonly AlertStateRow[]>;
  /**
   * Every stored row for these events, across all zones.
   *
   * This is the shape a merge needs: ADR-002 I3 folds the parents' states onto the
   * survivor for every zone that was following any of them, and the caller cannot name
   * those zones before it has read them. `foldAlertStates` then does the fold, and
   * tolerates a generous read — rows for uninvolved zones are the normal case here, not an
   * error.
   */
  loadStatesForEvents(eventPublicIds: readonly string[]): Promise<readonly AlertStateRow[]>;
  /**
   * When each of these zones was last notified about **any** event, as an ISO instant;
   * zones that have never sent anything are absent from the map.
   *
   * D3's suppression window is cross-event, so the decision needs a number no single
   * `(zone, event)` row carries. It is an aggregate over this table rather than a column on
   * `watch_zones` on purpose: a denormalized copy would be a second place `last_notified_at`
   * is written, and the one that drifted would drift toward sending more.
   */
  lastNotifiedByZone(zoneIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export interface AlertStateStore extends AlertStateReader {
  /**
   * Write these rows, replacing whatever the pairs hold. Returns how many rows the
   * statement affected, which is the batch size on every write that returns at all: an
   * event id that resolves to nothing must fail the whole write rather than drop one pair
   * and report a short count. "The caller should notice and roll back" was the wrong place
   * to put that rule — nothing in the core reads this number, and a dropped state row is
   * the pair that gets told "new fire" about a fire it has been following all week.
   *
   * A batch names each pair at most once. Two rows for one pair is a caller bug (the fold
   * was not applied, or two zones' decisions were concatenated without being reduced), and
   * the adapter refuses it instead of letting the database pick a winner.
   */
  upsert(rows: readonly AlertStateRow[]): Promise<number>;
  /**
   * Drop these pairs. Used by the merge migration, which moves the parents' states onto the
   * survivor and then removes them (`AlertStateMigration.deletes`), and by nothing else:
   * this is not how a zone stops watching a fire, because forgetting a pair is how a fire
   * the user was already told about becomes news again.
   *
   * Absent keys are not an error — the migration is replayable, and a re-run has already
   * deleted them. Returns how many rows were actually removed.
   *
   * Zone deletion does not come through here: `alert_states.watch_zone_id` cascades, which
   * is also what makes A1.8's "a zone deleted and re-created re-seeds from scratch" true
   * without anyone remembering to do it.
   */
  remove(keys: readonly AlertStateKey[]): Promise<number>;
}
