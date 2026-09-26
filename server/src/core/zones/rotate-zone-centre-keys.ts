/**
 * Zone-centre key rotation: move every sealed centre onto the active key (TASKS I2;
 * 05 §5.3.2; the "keep the old key as retired until every row names the new one" half of
 * `aes-gcm-zone-cipher.ts`).
 *
 * The operator's sequence is: configure the new key as active and the old one as retired
 * (API first, so new zones are sealed under the new key), run this job until it reports
 * `complete`, then drop the retired key from the keyring. This module is the middle step.
 *
 * ## Properties
 *
 *   - **Idempotent.** A batch selects only rows whose key id is not the active one, so a
 *     row already moved is never touched again, and a second run over a finished table
 *     reads nothing and writes nothing.
 *   - **Resumable.** One transaction per batch; a run stopped anywhere — `--max-batches`, a
 *     crash, a deploy — keeps every batch it committed, and the next run starts from the
 *     rows still under an old key. There is no cursor to persist: the key id *is* the
 *     cursor.
 *   - **Compare-and-swap writes.** A row is replaced only where it still holds the exact
 *     ciphertext and key id this batch read, so a concurrent writer is never overwritten
 *     (the rows are also locked for the batch; the CAS is the second belt).
 *   - **Verified before written.** Each new ciphertext is opened again and must yield the
 *     same coordinate bits, and must name the declared active key, before it is written.
 *     A cipher whose active key is not the one the operator named is a misconfiguration,
 *     and it stops the run (that batch rolls back) instead of rotating onto the wrong key.
 *   - **Failures are counted, not fatal.** A row sealed under a key this process lacks, or
 *     whose ciphertext does not authenticate, is left exactly as it is and counted under its
 *     key id. Keyset pagination moves past it, so one bad row cannot stall the run.
 *
 * ## What never leaves this function
 *
 * The opened centre exists only in a local between `open` and `seal`. The report carries
 * key ids and counts — no coordinate, no zone id, no ciphertext — so it is safe to print
 * whole. The cipher's own error messages are not carried either; only their count.
 */

import type { Coordinate } from '../clustering/geometry.js';
import type {
  SealedZoneCentre,
  ZoneCentreRekeyBatch,
  ZoneCentreRekeyStore,
  ZoneCentreReplacement,
} from '../ports/zone-centre-rekey-store.js';
import type { ZoneCentreCipher } from '../ports/zone-centre-cipher.js';

export interface ZoneKeyRotationDeps {
  readonly store: ZoneCentreRekeyStore;
  /** Opens under the active or any retired key; seals under the active key. */
  readonly cipher: ZoneCentreCipher;
  /** The key id the cipher seals under. Checked against every seal, not trusted. */
  readonly activeKeyId: string;
}

export interface ZoneKeyRotationOptions {
  /** Rows per batch (and per transaction). */
  readonly batchSize: number;
  /** Stop after this many batches; `null` runs until no row is left to examine. */
  readonly maxBatches: number | null;
  /** Open every row, write nothing. */
  readonly dryRun: boolean;
}

export interface ZoneKeyRotationReport {
  readonly activeKeyId: string;
  readonly dryRun: boolean;
  readonly batches: number;
  /** Rows read under an old key. */
  readonly examined: number;
  /** Rows written under the active key (in a dry run: rows that would have been). */
  readonly rotated: number;
  /** Rows that changed between the read and the compare-and-swap, and were left alone. */
  readonly raced: number;
  /** Rows that could not be opened, per the key id they are sealed under. */
  readonly failedByKeyId: Readonly<Record<string, number>>;
  /** Sealed rows per key id, before the run and after it. */
  readonly before: Readonly<Record<string, number>>;
  readonly after: Readonly<Record<string, number>>;
  /** True when `maxBatches` ended the run with rows possibly left unexamined. */
  readonly stoppedEarly: boolean;
  /** Every sealed row names the active key; the retired keys may be dropped. */
  readonly complete: boolean;
}

/** Thrown when a seal does not produce what the rotation promised; stops the run. */
export class ZoneKeyRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneKeyRotationError';
  }
}

export async function rotateZoneCentreKeys(
  deps: ZoneKeyRotationDeps,
  options: ZoneKeyRotationOptions,
): Promise<ZoneKeyRotationReport> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new RangeError(`batch size must be a positive integer, got ${String(options.batchSize)}`);
  }
  if (
    options.maxBatches !== null &&
    (!Number.isInteger(options.maxBatches) || options.maxBatches < 1)
  ) {
    throw new RangeError(
      `max batches must be a positive integer or null, got ${String(options.maxBatches)}`,
    );
  }

  const before = record(await deps.store.countByKeyId());
  let batches = 0;
  let examined = 0;
  let rotated = 0;
  let raced = 0;
  const failedByKeyId: Record<string, number> = {};
  let after: string | null = null;
  let stoppedEarly = false;

  for (;;) {
    if (options.maxBatches !== null && batches >= options.maxBatches) {
      stoppedEarly = true;
      break;
    }
    const outcome = await deps.store.inBatch((batch) =>
      runBatch(batch, deps, options, after, failedByKeyId),
    );
    batches += 1;
    examined += outcome.examined;
    rotated += outcome.rotated;
    raced += outcome.raced;
    if (outcome.lastZoneId === null || outcome.examined < options.batchSize) break;
    after = outcome.lastZoneId;
  }

  const afterCounts = record(await deps.store.countByKeyId());
  const remaining = Object.entries(afterCounts)
    .filter(([keyId]) => keyId !== deps.activeKeyId)
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    activeKeyId: deps.activeKeyId,
    dryRun: options.dryRun,
    batches,
    examined,
    rotated,
    raced,
    failedByKeyId,
    before,
    after: afterCounts,
    stoppedEarly,
    complete: remaining === 0,
  };
}

interface BatchOutcome {
  readonly examined: number;
  readonly rotated: number;
  readonly raced: number;
  readonly lastZoneId: string | null;
}

async function runBatch(
  batch: ZoneCentreRekeyBatch,
  deps: ZoneKeyRotationDeps,
  options: ZoneKeyRotationOptions,
  afterZoneId: string | null,
  failedByKeyId: Record<string, number>,
): Promise<BatchOutcome> {
  const rows = await batch.lockNotUnder(deps.activeKeyId, afterZoneId, options.batchSize);
  const replacements: ZoneCentreReplacement[] = [];
  for (const row of rows) {
    const to = reseal(row, deps, failedByKeyId);
    if (to !== null) replacements.push({ zoneId: row.zoneId, from: row.sealed, to: to.sealed });
  }

  let written = 0;
  if (!options.dryRun && replacements.length > 0) {
    written = await batch.replace(replacements);
  }
  return {
    examined: rows.length,
    rotated: options.dryRun ? replacements.length : written,
    raced: options.dryRun ? 0 : replacements.length - written,
    lastZoneId: rows.at(-1)?.zoneId ?? null,
  };
}

/** Opens, reseals and re-opens one row; `null` (and a count) when it cannot be opened. */
function reseal(
  row: SealedZoneCentre,
  deps: ZoneKeyRotationDeps,
  failedByKeyId: Record<string, number>,
): SealedZoneCentre | null {
  let centre: Coordinate;
  try {
    centre = deps.cipher.open(row.zoneId, row.sealed);
  } catch {
    // The cipher's message is not carried: it is not ours to vouch for, and the count by
    // key id is what the operator acts on.
    failedByKeyId[row.sealed.keyId] = (failedByKeyId[row.sealed.keyId] ?? 0) + 1;
    return null;
  }

  const sealed = deps.cipher.seal(row.zoneId, centre);
  if (sealed.keyId !== deps.activeKeyId) {
    throw new ZoneKeyRotationError(
      'the cipher sealed under a key other than the declared active key; the batch rolls back',
    );
  }
  let reopened: Coordinate;
  try {
    reopened = deps.cipher.open(row.zoneId, sealed);
  } catch {
    throw new ZoneKeyRotationError('a freshly sealed centre did not open; the batch rolls back');
  }
  if (!sameBits(centre.lat, reopened.lat) || !sameBits(centre.lon, reopened.lon)) {
    throw new ZoneKeyRotationError(
      'a resealed centre changed on the round trip; the batch rolls back',
    );
  }
  return { zoneId: row.zoneId, sealed };
}

function sameBits(a: number, b: number): boolean {
  return Object.is(a, b);
}

function record(counts: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const keyId of [...counts.keys()].sort()) out[keyId] = counts.get(keyId) ?? 0;
  return out;
}
