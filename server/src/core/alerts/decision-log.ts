/**
 * The decision log entry for one `decideAlert` decision (migration 014; TASKS H7).
 *
 * A projection, like everything in `explain.ts`: the code comes from the branch table the
 * explanation surfaces already use, so the log can never name a code the renderer would
 * not have produced for the same decision. A pair `decideAlert` never produces throws
 * here rather than being logged under a guessed code.
 */

import type { DecisionLogEntry, DecisionLogPass } from '../ports/alert-decision-log.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type { AlertDecision } from './alert-decision.js';
import { branchOf } from './explain.js';

export interface DecisionLogContext {
  /** `fire_events.id`, decimal text. */
  readonly fireEventId: string;
  /** `fire_events.seq` the decision was taken at, decimal text. */
  readonly triggerRefSeq: string;
  readonly pass: DecisionLogPass;
  readonly decidedAt: EpochMs;
}

/**
 * The fields of a decision the log records. Narrower than {@link AlertDecision} on purpose:
 * the zone-creation seed pass carries its decisions as values with no subkey, priority or
 * next state (so nothing a gateway could send from), and still logs through this function.
 */
export type LoggableDecision = Pick<
  AlertDecision,
  'zoneId' | 'outcome' | 'reason' | 'alertType' | 'ladderStep' | 'inQuietHours' | 'ruleVersion'
>;

export function decisionLogEntryFor(
  decision: LoggableDecision,
  context: DecisionLogContext,
): DecisionLogEntry {
  const branch = branchOf(decision.outcome, decision.reason);
  const { alertType } = decision;
  if (alertType === 'digest') {
    throw new RangeError(`decision for ${decision.zoneId} carries a digest type`);
  }
  return {
    zoneId: decision.zoneId,
    fireEventId: context.fireEventId,
    triggerRefSeq: context.triggerRefSeq,
    pass: context.pass,
    outcome: decision.outcome,
    reason: decision.reason,
    code: branch.code,
    alertType,
    ladderStep: decision.ladderStep,
    inQuietHours: decision.inQuietHours,
    ruleVersion: decision.ruleVersion,
    decidedAtIso: isoFromEpochMs(context.decidedAt),
  };
}
