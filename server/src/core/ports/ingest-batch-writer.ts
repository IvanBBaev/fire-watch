/**
 * The one write of an ingest cycle that has to be atomic (TASKS C1, C2).
 *
 * A poll's rows and its `ingest_batches` row are two halves of one fact. The rows are
 * stamped with the batch's `available_at`, and the batch row is what the live identity
 * pipeline queues on: a detection whose batch row never landed is never clustered. Nor is
 * that gap healed by the next poll — it re-delivers the same rows under a new
 * `available_at`, the archive keeps the first copy (ADR-002 A1.1), and the orphan keeps
 * the instant that has no batch. So the two writes commit together or not at all.
 *
 * A unit of work rather than one combined method, because the batch row carries the
 * append's own counts (`inserted`, `alreadyPresent`): the second write is computed from
 * the first, and only the core knows how. The quarantine entries stay outside it on
 * purpose — they are evidence about a batch, and losing them is no reason to lose the
 * batch (see `quarantine-store.ts`).
 */

import type { AppendResult, DetectionRecord } from './detection-store.js';
import type { IngestBatchRecord } from './quarantine-store.js';

/** The two writes, as seen from inside the unit of work. */
export interface IngestBatchTransaction {
  appendDetections(records: readonly DetectionRecord[]): Promise<AppendResult>;
  recordBatch(batch: IngestBatchRecord): Promise<void>;
}

export interface IngestBatchWriter {
  /**
   * Runs `work` in one transaction: committed when it resolves, rolled back when it
   * throws, and the error rethrown. Nothing written through `tx` outlives a rejection.
   */
  withBatch<T>(work: (tx: IngestBatchTransaction) => Promise<T>): Promise<T>;
}
