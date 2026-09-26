/**
 * A placeholder engine that exists so the harness has something to run before WP2.
 *
 * It is **not** a simplified clustering algorithm and must not grow into one: no
 * distance metric, no lifecycle, no score. It groups detections by their canonical
 * coordinate text and mints ids in the order it first sees a group. That single property
 * — ids assigned in ingest order — is what makes it a useful determinism probe: if batch
 * ordering, the virtual clock, or the report serialization stopped being deterministic,
 * the ids would shuffle and CI-2 would fail. A grouping that ignored order would pass
 * even with the ordering removed, and would therefore prove nothing.
 *
 * When the real engine lands it replaces this file; the fixture that drives it stays.
 */

import type { ReplayContext, ReplayDetection, ReplayEngine, ReplayEvent } from './runner.js';

const SMOKE_ID_PREFIX = 'smoke-';

export function createSmokeEngine(context: ReplayContext): ReplayEngine {
  // Insertion-ordered on purpose — see the note above.
  const groups = new Map<string, { publicId: string; detectionUids: string[]; lastSeen: number }>();

  return {
    ingest(batch: readonly ReplayDetection[]): void {
      for (const detection of batch) {
        const cell = `${detection.latCanonical},${detection.lonCanonical}`;
        const existing = groups.get(cell);
        if (existing) {
          existing.detectionUids.push(detection.detectionUid);
          existing.lastSeen = context.clock.now();
          continue;
        }
        groups.set(cell, {
          publicId: `${SMOKE_ID_PREFIX}${String(groups.size + 1).padStart(3, '0')}`,
          detectionUids: [detection.detectionUid],
          lastSeen: context.clock.now(),
        });
      }
    },

    events(): readonly ReplayEvent[] {
      return [...groups.values()].map((group) => ({
        publicId: group.publicId,
        // A single fixed state: this engine has no lifecycle and must not pretend to.
        status: 'active',
        // And therefore no display tier either: placing an event is a lifecycle decision.
        displayTier: null,
        bucket: 'unverified',
        detectionUids: group.detectionUids,
        mergedInto: null,
        relation: null,
        labels: [],
      }));
    },
  };
}
