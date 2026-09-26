/**
 * Zone creation in one Postgres transaction (ADR-004 A1.8: "inside the same transaction as
 * the zone write").
 *
 * `createWatchZone` in the core is written against stores that open no transactions; this
 * is the one place that opens it. One client is checked out, `BEGIN`, every store —
 * zones, alert states, the seed-candidate reader and the H7 decision log (`pass =
 * 'zone_creation'`) — is built over *that* client, and the
 * outcome is `COMMIT` or `ROLLBACK`. A zone whose seed failed to write is therefore a zone
 * that does not exist, which is the only safe reading of A1.8: the alternative is a zone
 * that alerts "new fire" about everything already burning inside it.
 *
 * Same shape as `adapters/promotion/pg-sp-staging-store.ts`'s transaction: `ROLLBACK`'s own
 * failure is swallowed so the original error is the one that surfaces, and the client is
 * released on every path.
 */

import type { ZoneCentreCipher } from '../../core/ports/zone-centre-cipher.js';
import type { ZoneSeedCandidateReader } from '../../core/ports/zone-seed-candidate-reader.js';
import type { EpochMs } from '../../core/ports/clock.js';
import {
  createWatchZone,
  type CreatedWatchZone,
  type CreateWatchZoneRequest,
} from '../../core/zones/create-watch-zone.js';
import { createPgAlertDecisionLog } from './pg-alert-decision-log.js';
import { createPgAlertStateStore, type PgAlertStateQueryable } from './pg-alert-state-store.js';
import { createPgWatchZoneStore, type PgWatchZoneQueryable } from './pg-watch-zone-store.js';
import { createPgZoneSeedCandidateReader } from './pg-zone-seed-candidate-reader.js';

/** A checked-out client: queryable by every store involved, and releasable. */
export interface PgZoneCreationClient extends PgWatchZoneQueryable, PgAlertStateQueryable {
  release(): void;
}

export interface PgZoneCreationPool {
  connect(): Promise<PgZoneCreationClient>;
}

export interface PgZoneCreatorOptions {
  readonly cipher: ZoneCentreCipher;
  /**
   * Builds the seed-candidate reader over the transaction's client. Defaults to the pg
   * reader (`pg-zone-seed-candidate-reader.ts`); tests and replay may pass another.
   */
  readonly candidateReaderFor?: (client: PgZoneCreationClient) => ZoneSeedCandidateReader;
  /** `crypto.randomUUID` in production; injected so the core never mints randomness. */
  readonly newZoneId: () => string;
}

export type ZoneCreator = (
  request: CreateWatchZoneRequest,
  at: EpochMs,
) => Promise<CreatedWatchZone>;

export function createPgZoneCreator(
  pool: PgZoneCreationPool,
  options: PgZoneCreatorOptions,
): ZoneCreator {
  return async (request, at) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await createWatchZone(request, at, {
        cipher: options.cipher,
        zones: createPgWatchZoneStore(client),
        alertStates: createPgAlertStateStore(client),
        candidates: (options.candidateReaderFor ?? createPgZoneSeedCandidateReader)(client),
        decisionLog: createPgAlertDecisionLog(client),
        newZoneId: options.newZoneId,
      });
      await client.query('COMMIT');
      return created;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}
