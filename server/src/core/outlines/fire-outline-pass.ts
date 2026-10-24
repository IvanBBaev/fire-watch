/**
 * The outline loop's pass (V2-A4): draw the outline of every event on the map whose
 * stored outline is missing, was drawn under other parameters, or was drawn before the
 * event's latest detections joined it.
 *
 * Each event is saved as soon as it is drawn, so a pass cut short keeps what it finished;
 * the heartbeat is recorded only when the whole batch is done. An event that gained more
 * detections while it was being drawn is simply listed again next pass, because its row
 * records the detection count it was drawn for.
 */

import { FIRE_OUTLINE_PARAMS, type FireOutlineValues } from '../config/fire-outline.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import type { Clock } from '../ports/clock.js';
import type { FireOutlineRow, FireOutlineStore } from '../ports/fire-outline-store.js';
import { drawFireOutline } from './fire-outline.js';

export interface FireOutlinePassDeps {
  readonly store: FireOutlineStore;
  readonly clock: Clock;
  readonly params?: VersionedConfig<FireOutlineValues>;
}

export interface FireOutlinePassReport {
  readonly paramsVersion: string;
  /** Events listed as needing an outline this pass. */
  readonly pending: number;
  /** Outlines drawn with a shape. */
  readonly drawn: number;
  /** Events stored without a shape: no VIIRS/MODIS detection among their members. */
  readonly empty: number;
  /** True when the batch was full, so more events may still be waiting. */
  readonly backlog: boolean;
}

export async function runFireOutlinePass(
  deps: FireOutlinePassDeps,
): Promise<FireOutlinePassReport> {
  const params = deps.params ?? FIRE_OUTLINE_PARAMS;
  const values = params.values;
  const pending = await deps.store.pendingEvents(params.version, values.batchSize);
  let drawn = 0;
  let empty = 0;
  for (const candidate of pending) {
    const members = await deps.store.members(candidate.eventId, values.maxDetections);
    const outline = drawFireOutline(members, values);
    const row: FireOutlineRow = {
      eventId: candidate.eventId,
      paramsVersion: params.version,
      detectionCount: candidate.detectionCount,
      lastDetectionAt: candidate.lastDetectionAt,
      footprints: outline.footprints,
      geometry: outline.geometry,
      areaHa: outline.areaHa,
      areaLowHa: outline.areaLowHa,
      areaHighHa: outline.areaHighHa,
      edgeUncertaintyKm: outline.edgeUncertaintyKm,
      computedAt: deps.clock.now(),
    };
    await deps.store.save([row]);
    if (outline.geometry === null) empty += 1;
    else drawn += 1;
  }
  await deps.store.recordPass(params.version, deps.clock.now());
  return {
    paramsVersion: params.version,
    pending: pending.length,
    drawn,
    empty,
    backlog: pending.length >= values.batchSize,
  };
}
