/**
 * The month-swap machinery, as the core sees it (ADR-002 D7 as amended by A1.4; TASKS
 * C7). Four operations, in the order the promotion run calls them; the adapter owns the
 * SQL and the partition mechanics, the core owns the decision to call `swap` at all.
 *
 * This port is deliberately not part of `DetectionStore`: promotion is DDL — creating a
 * staging table, detaching and attaching partitions — which the append-only runtime
 * role must never hold, and keeping it in a separate port keeps the separation of
 * privileges visible in the type system.
 */

import type { BoundingBox } from '../config/polling-bbox.js';
import type { MonthWindow } from '../promotion/month-window.js';
import type { SwapObservations } from '../promotion/sanity-checks.js';
import type { AppendResult, DetectionRecord } from './detection-store.js';

export interface SwapOutcome {
  /** The detached NRT partition's new name — retained, never dropped (A1.4 step 3). */
  readonly retiredTable: string;
  /** The staged SP table, now attached under the live partition's name. */
  readonly attachedPartition: string;
}

export interface SpStagingStore {
  /**
   * Creates (or resets) the month's staging table beside the live partition, shaped
   * exactly like `detections`. Idempotent: a rerun starts from an empty table, never
   * on top of a half-loaded one.
   */
  prepareStaging(window: MonthWindow): Promise<void>;

  /** Loads staged SP rows; already-present uids are skipped, as on the live path. */
  loadStaged(window: MonthWindow, records: readonly DetectionRecord[]): Promise<AppendResult>;

  /** Measures everything the A1.4 step-2 checks need; the verdicts are computed in core. */
  observe(window: MonthWindow, bbox: BoundingBox): Promise<SwapObservations>;

  /**
   * A1.4 step 3: detach the NRT partition and attach the staged SP table in ONE
   * transaction. The detached partition is renamed to `window.retiredTable` and
   * retained as append-only archive evidence. Only the promotion run calls this, and
   * only after `decideSwap` said `proceed`.
   */
  swap(window: MonthWindow): Promise<SwapOutcome>;
}
