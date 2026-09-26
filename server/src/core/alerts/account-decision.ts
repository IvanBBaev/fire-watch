/**
 * One event, one account, every zone of that account that contains it: the decisions, with
 * A1.12's nearest-zone rule already applied (ADR-004 A1.6, A1.8, A1.12).
 *
 * This is the step the golden replay (`replay/alert-engine.ts`) and the live evaluation
 * cycle (`evaluation-cycle.ts`) share, and it is shared so that there is exactly one
 * definition of it: the CI-1 replay proves the code the worker runs. What differs between
 * the two callers is only where the inputs come from — fixture memory versus Postgres —
 * and what happens to the result — an emitted report line versus a state row and an outbox
 * row in one transaction. Both of those stay with the caller.
 *
 * Deliberately not here:
 *
 *   * **Folding the parent chain.** `decideAlert` requires an already-folded state row;
 *     the replay folds in memory before its pass, and live the clustering transaction
 *     folds (`merge-plan.ts`, `reignition-plan.ts`). A second fold here would be a second
 *     place the chain is walked.
 *   * **Choosing which zones contain the event.** The replay's zones state their distance;
 *     live, the distance is measured from the decrypted stored centre (`zone-match.ts`).
 *   * **Applying the result.** The caller owns its state, so it owns the write.
 */

import type { AlertGatingParams } from '../config/alert-gating.js';
import { ALERT_GATING } from '../config/alert-gating.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import type { EpochMs } from '../ports/clock.js';
import type { AlertStateRow } from '../registry/alert-state.js';
import {
  chooseNotifyingZone,
  decideAlert,
  type AlertZone,
  type AlertableEvent,
  type LastNotifiedContent,
  type ZoneDecision,
} from './alert-decision.js';

/** One of the account's zones, with everything the gate reads about that pair. */
export interface AccountZoneInput {
  readonly zone: AlertZone;
  /** The folded `(zone, event)` state row, or `null` for a pair with none. */
  readonly state: AlertStateRow | null;
  readonly lastNotified: LastNotifiedContent;
  readonly zoneLastNotifiedAt: EpochMs | null;
  /** True only inside the A1.8 zone-creation evaluation. The live loop passes `false`. */
  readonly zoneCreation: boolean;
}

/**
 * Decides the event for every given zone of one account, in the given order, then demotes
 * every `send` but the nearest zone's to `suppress`/`nearer_zone` (A1.12: one fire is one
 * message per person). The order of the input is the order of the output and is the
 * tie-break input, so callers sort before calling. An empty input decides nothing.
 */
export function decideForAccount(
  event: AlertableEvent,
  zones: readonly AccountZoneInput[],
  at: EpochMs,
  gating: VersionedConfig<AlertGatingParams> = ALERT_GATING,
): readonly ZoneDecision[] {
  if (zones.length === 0) return [];
  const decisions: ZoneDecision[] = zones.map((input) => ({
    zone: input.zone,
    decision: decideAlert(
      {
        event,
        zone: input.zone,
        state: input.state,
        lastNotified: input.lastNotified,
        zoneLastNotifiedAt: input.zoneLastNotifiedAt,
        zoneCreation: input.zoneCreation,
        at,
      },
      gating,
    ),
  }));
  return chooseNotifyingZone(decisions, gating.values);
}
