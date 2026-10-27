import { describe, expect, it } from 'vitest';

import type { IngestBatchRecord } from '../../core/ports/quarantine-store.js';
import {
  createPgIngestBatchWriter,
  type PgIngestBatchClient,
  type PgIngestBatchPool,
} from './pg-ingest-batch-writer.js';

interface FakeClient extends PgIngestBatchClient {
  readonly statements: string[];
  released: number;
}

function fakePool(failOn?: RegExp): {
  readonly pool: PgIngestBatchPool;
  readonly client: FakeClient;
} {
  const client: FakeClient = {
    statements: [],
    released: 0,
    query(text) {
      const statement = text.trim().split(/\s+/).slice(0, 3).join(' ');
      client.statements.push(statement);
      if (failOn?.test(text) === true) return Promise.reject(new Error(`refused: ${statement}`));
      return Promise.resolve({ rowCount: 0, rows: [] });
    },
    release() {
      client.released += 1;
    },
  };
  return { pool: { connect: () => Promise.resolve(client) }, client };
}

const BATCH: IngestBatchRecord = {
  source: 'firms:viirs:snpp',
  availableAt: Date.parse('2026-08-02T11:29:30Z'),
  received: 0,
  inserted: 0,
  alreadyPresent: 0,
  rejected: 0,
  quarantined: 0,
  anomalyVerdict: 'not_enough_history',
  anomalyTripped: false,
  baseline: null,
  ratio: null,
  ingestConfigVersion: 'ingest_anomaly_v1',
  pollingBboxVersion: 'polling_bbox_v1',
  sourceRegistryVersion: 'source_registry_v1',
};

describe('createPgIngestBatchWriter', () => {
  it('runs the batch row inside BEGIN … COMMIT on one connection', async () => {
    const { pool, client } = fakePool();

    const value = await createPgIngestBatchWriter(pool).withBatch(async (tx) => {
      await tx.recordBatch(BATCH);
      return 'done';
    });

    expect(value).toBe('done');
    expect(client.statements).toEqual(['BEGIN', 'INSERT INTO ingest_batches', 'COMMIT']);
    expect(client.released).toBe(1);
  });

  it('rolls back, rethrows and releases when a write is refused', async () => {
    const { pool, client } = fakePool(/INSERT INTO ingest_batches/);

    await expect(
      createPgIngestBatchWriter(pool).withBatch((tx) => tx.recordBatch(BATCH)),
    ).rejects.toThrow('refused: INSERT INTO ingest_batches');

    expect(client.statements).toEqual(['BEGIN', 'INSERT INTO ingest_batches', 'ROLLBACK']);
    expect(client.released).toBe(1);
  });

  it('keeps the original error when the rollback fails too', async () => {
    const { pool, client } = fakePool(/INSERT INTO ingest_batches|ROLLBACK/);

    await expect(
      createPgIngestBatchWriter(pool).withBatch((tx) => tx.recordBatch(BATCH)),
    ).rejects.toThrow('refused: INSERT INTO ingest_batches');
    expect(client.released).toBe(1);
  });
});
