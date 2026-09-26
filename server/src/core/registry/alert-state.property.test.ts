/**
 * I3 — a merge can never produce a second "new fire" for a zone already notified about any
 * parent (GATES CI-5).
 *
 * Stated as a property because the dangerous cases are the combinatorial ones: three
 * parents, two zones, one of them notified about only the parent that lost, timestamps in
 * mixed renderings, rows arriving in whatever order the query planner felt like. The
 * headline property is the first one below and it is one line; the rest pin the fields the
 * headline is not allowed to reach its conclusion by damaging — a fold that returned
 * `cooldown` for everything would satisfy I3 and silence the product.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { epochMsFromIso, isoFromEpochMs } from '../ports/clock.js';
import {
  ALERT_STATES,
  alertStateRank,
  foldAlertStates,
  isNotified,
  type AlertStateRow,
} from './alert-state.js';

const TARGET = 'fw-2026-surv';
const PARENTS = ['fw-2026-p1', 'fw-2026-p2', 'fw-2026-p3'];
const ZONES = ['zone-a', 'zone-b', 'zone-c'];
const BASE_MS = epochMsFromIso('2026-08-08T06:00:00.000Z');

/**
 * Distinct instants, one rendering each. Ties in the fold are broken by "keep what is
 * already held", so two *equal* instants written differently would make the output depend
 * on input order — a real property of the fold, but not the one under test here.
 */
const instant = fc
  .option(fc.nat(11), { nil: null })
  .map((step) => (step === null ? null : isoFromEpochMs(BASE_MS + step * 1_800_000)));

const rows = fc.array(
  fc.record({
    zoneId: fc.constantFrom(...ZONES),
    eventPublicId: fc.constantFrom(TARGET, ...PARENTS),
    state: fc.constantFrom(...ALERT_STATES),
    escalationWatermark: fc.nat(5),
    seededAtIso: instant,
    lastNotifiedAtIso: instant,
  }),
  { maxLength: 15 },
);

function forZone(input: readonly AlertStateRow[], zoneId: string): readonly AlertStateRow[] {
  return input.filter((row) => row.zoneId === zoneId);
}

function foldOf(input: readonly AlertStateRow[], zoneId: string): AlertStateRow | undefined {
  return foldAlertStates(input, TARGET, PARENTS).find((row) => row.zoneId === zoneId);
}

describe('I3 — the survivor inherits every parent notification', () => {
  it('never leaves a notified zone un-notified', () => {
    // The invariant itself. Everything else in this file exists so that this one cannot be
    // satisfied by a fold that simply says "notified" to everything.
    fc.assert(
      fc.property(rows, (input) => {
        for (const zoneId of ZONES) {
          const parents = forZone(input, zoneId);
          if (!parents.some((row) => isNotified(row.state))) continue;
          expect(isNotified(foldOf(input, zoneId)?.state ?? 'none')).toBe(true);
        }
      }),
    );
  });

  it('lands on the most advanced state, not merely a notified one', () => {
    fc.assert(
      fc.property(rows, (input) => {
        for (const zoneId of ZONES) {
          const parents = forZone(input, zoneId);
          if (parents.length === 0) continue;
          const highest = Math.max(...parents.map((row) => alertStateRank(row.state)));
          expect(alertStateRank(foldOf(input, zoneId)?.state ?? 'none')).toBe(highest);
        }
      }),
    );
  });

  it('never lowers the escalation watermark — A1.11', () => {
    fc.assert(
      fc.property(rows, (input) => {
        for (const zoneId of ZONES) {
          const parents = forZone(input, zoneId);
          if (parents.length === 0) continue;
          expect(foldOf(input, zoneId)?.escalationWatermark).toBe(
            Math.max(...parents.map((row) => row.escalationWatermark)),
          );
        }
      }),
    );
  });

  it('keeps the latest notification and the earliest seeding', () => {
    fc.assert(
      fc.property(rows, (input) => {
        for (const zoneId of ZONES) {
          const parents = forZone(input, zoneId);
          if (parents.length === 0) continue;
          const folded = foldOf(input, zoneId);

          const notified = parents
            .map((row) => row.lastNotifiedAtIso)
            .filter((iso): iso is string => iso !== null)
            .map(epochMsFromIso);
          expect(folded?.lastNotifiedAtIso).toBe(
            notified.length === 0 ? null : isoFromEpochMs(Math.max(...notified)),
          );

          const seeded = parents
            .map((row) => row.seededAtIso)
            .filter((iso): iso is string => iso !== null)
            .map(epochMsFromIso);
          expect(folded?.seededAtIso).toBe(
            seeded.length === 0 ? null : isoFromEpochMs(Math.min(...seeded)),
          );
        }
      }),
    );
  });

  it('emits exactly one row per zone it saw, re-keyed to the survivor, ascending', () => {
    // One row per zone is what makes the migration an upsert against
    // `UNIQUE (zone_id, event_id, alert_type)` rather than a conflict, and re-keying is
    // what stops the state from staying behind on a tombstone as a second mouth.
    fc.assert(
      fc.property(rows, (input) => {
        const folded = foldAlertStates(input, TARGET, PARENTS);
        const seen = [...new Set(input.map((row) => row.zoneId))].sort();

        expect(folded.map((row) => row.zoneId)).toEqual(seen);
        expect(folded.every((row) => row.eventPublicId === TARGET)).toBe(true);
      }),
    );
  });

  it('does not depend on the order the rows were loaded in', () => {
    // The adapter reads these inside the transaction with no ORDER BY that the fold is
    // entitled to rely on. If the result moved with the row order, a replay would diverge
    // from the run it is replaying for a reason nobody could see in the data.
    fc.assert(
      fc.property(rows, fc.array(fc.nat(), { maxLength: 15 }), (input, keys) => {
        const shuffled = input
          .map((row, index) => ({ row, key: keys[index] ?? index }))
          .sort((a, b) => a.key - b.key)
          .map((entry) => entry.row);

        expect(foldAlertStates(shuffled, TARGET, PARENTS)).toEqual(
          foldAlertStates(input, TARGET, PARENTS),
        );
      }),
    );
  });

  it('is idempotent — folding the survivor into itself changes nothing', () => {
    // I4 replay silence, at this layer: re-running a migration that already committed must
    // not advance a state or move a timestamp.
    fc.assert(
      fc.property(rows, (input) => {
        const once = foldAlertStates(input, TARGET, PARENTS);
        expect(foldAlertStates(once, TARGET, PARENTS)).toEqual(once);
      }),
    );
  });
});
