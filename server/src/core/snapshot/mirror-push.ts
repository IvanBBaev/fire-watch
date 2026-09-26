/**
 * One push of the T2 static mirror (TASKS E3): read the projection, build the snapshot the
 * API would serve at this instant, PUT it as one object, and record the attempt on the
 * `snapshot-push` freshness row (OPERATIONS §1.3: 60 s cadence, warn 5 min, critical 15 min).
 *
 * Every cycle uploads, changed `max_seq` or not — see `mirror-plan.ts` for why a skipped
 * upload would be a lie about age. Failures are caught here and recorded, so the freshness
 * row ages honestly; the scheduler never sees a throw from a failed upload.
 *
 * **Known limit, reported rather than hidden.** `generated_at` is the push time, the same
 * as the API's. A frozen ingest behind a live push job therefore still produces a "fresh"
 * T2 object; that staleness is carried per source in `sources[].last_observed_at` and in
 * the ingest's own freshness rows, not in this job's age.
 */

import type { Clock, EpochMs } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { FeedStatusStore } from '../ports/feed-status-store.js';
import type { ObjectStore } from '../ports/object-store.js';
import type { SnapshotReader } from '../ports/snapshot-reader.js';
import { planMirrorObject } from './mirror-plan.js';
import { buildSnapshot } from './snapshot-builder.js';

export interface MirrorPushDeps {
  readonly reader: SnapshotReader;
  readonly store: ObjectStore;
  readonly clock: Clock;
  readonly sources: readonly string[];
  readonly objectKey: string;
  /** `null` when the deployment has no state dir: the push still runs, it just claims nothing. */
  readonly feedStatus: FeedStatusStore | null;
}

export type MirrorPushReport =
  | {
      readonly outcome: 'uploaded';
      readonly key: string;
      readonly generated_at: string;
      readonly max_seq: number;
      readonly features: number;
      readonly bytes: number;
      readonly etag: string | null;
      readonly duration_ms: number;
    }
  | {
      readonly outcome: 'failed';
      readonly key: string;
      readonly stage: 'read' | 'upload';
      readonly error: string;
      readonly duration_ms: number;
    };

export function mirrorPushFailed(report: MirrorPushReport): boolean {
  return report.outcome !== 'uploaded';
}

export async function runMirrorPush(deps: MirrorPushDeps): Promise<MirrorPushReport> {
  const startedAt = deps.clock.now();
  let stage: 'read' | 'upload' = 'read';
  let report: MirrorPushReport;
  try {
    // The instant is taken before the read, as the route does: `generated_at` must never be
    // later than the data it vouches for.
    const generatedAtMs: EpochMs = deps.clock.now();
    const [read, sources] = await Promise.all([
      deps.reader.readActiveSet(0),
      deps.reader.readSourceObservations(deps.sources),
    ]);
    const document = buildSnapshot({ read, sources, generatedAtMs, afterSeq: 0 });
    const object = planMirrorObject(document, deps.objectKey);
    stage = 'upload';
    const { etag } = await deps.store.put(object);
    report = {
      outcome: 'uploaded',
      key: object.key,
      generated_at: isoFromEpochMs(generatedAtMs),
      max_seq: document.max_seq,
      features: document.features.length,
      bytes: new TextEncoder().encode(object.body).byteLength,
      etag,
      duration_ms: deps.clock.now() - startedAt,
    };
  } catch (error) {
    report = {
      outcome: 'failed',
      key: deps.objectKey,
      stage,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: deps.clock.now() - startedAt,
    };
  }

  if (deps.feedStatus !== null) {
    const succeeded = report.outcome === 'uploaded';
    await deps.feedStatus.recordAttempt({
      row: 'snapshot-push',
      attemptAt: deps.clock.now(),
      succeeded,
      // Every successful push delivers new bytes (a new `generated_at`), by design.
      hadData: succeeded,
      error: report.outcome === 'failed' ? `${report.stage}: ${report.error}` : null,
    });
  }
  return report;
}
