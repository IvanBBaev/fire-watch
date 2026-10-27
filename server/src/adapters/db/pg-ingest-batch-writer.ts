/**
 * The atomic half of an ingest cycle over Postgres (TASKS C1, C2).
 *
 * One checked-out connection, `BEGIN`, the archive's append and the batch row through the
 * very same statements the two stores run on their own, then `COMMIT` — or `ROLLBACK` and
 * the error. Reusing `createPgDetectionStore` and `createPgQuarantineStore` on the client
 * is the point: there is one INSERT per table, so the atomic path cannot drift from the
 * one the integration suites pin.
 *
 * Both statements are `ON CONFLICT DO NOTHING`, so a rolled-back batch that is re-polled
 * lands exactly as it would have the first time, under the re-poll's `available_at`.
 */

import type {
  IngestBatchTransaction,
  IngestBatchWriter,
} from '../../core/ports/ingest-batch-writer.js';
import { createPgDetectionStore } from './pg-detection-store.js';
import { createPgQuarantineStore } from './pg-quarantine-store.js';

/**
 * The slice of `pg` this writer uses: a `Pool`, whose clients answer both stores' query
 * shapes. Typed here rather than imported so a fake can stand in without a database.
 */
export interface PgIngestBatchClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount: number | null; rows: readonly unknown[] }>;
  release(): void;
}

export interface PgIngestBatchPool {
  connect(): Promise<PgIngestBatchClient>;
}

export function createPgIngestBatchWriter(pool: PgIngestBatchPool): IngestBatchWriter {
  return {
    async withBatch<T>(work: (tx: IngestBatchTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const detections = createPgDetectionStore(client);
        const bookkeeping = createPgQuarantineStore(client);
        const value = await work({
          appendDetections: (records) => detections.appendDetections(records),
          recordBatch: (batch) => bookkeeping.recordBatch(batch),
        });
        await client.query('COMMIT');
        return value;
      } catch (error) {
        // A failed ROLLBACK means the connection is gone, and with it the transaction;
        // the original error is the one worth reporting.
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
