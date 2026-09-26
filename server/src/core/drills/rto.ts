/**
 * The recovery-time objective as data, and the evaluation of a drill against it (TASKS J2;
 * OPERATIONS §5, §6.3 rules 3–4; GATES L-17; runbook 02 M2/M3).
 *
 * §5 states RTO **2–4 h** for total VM loss. The drill measures the RTO path: every step
 * from "the VM is gone" to "a serving stack answers `/readyz`". Only the database leg is
 * automated; provisioning, secrets, promotion and the origin flip are manual (runbook 02),
 * so the operator reports their minutes with `--manual-step=<id>:<minutes>`. A step on the
 * path that nobody performed makes the measured time a **lower bound**, and the result
 * `incomplete` — never `met`.
 *
 * `met` is judged against the upper bound (4 h): §6.3 rule 4 makes "over 4 h" the trigger
 * for freeze-priority work. The lower bound is reported, not enforced.
 */

import type { DrillStep, DrillStepDefinition, RtoEvaluation } from './drill-record.js';

export type { RtoEvaluation, RtoStatus } from './drill-record.js';

export interface RtoTarget {
  readonly targetMinMinutes: number;
  readonly targetMaxMinutes: number;
  readonly spec: string;
}

export const RESTORE_RTO: RtoTarget = {
  targetMinMinutes: 120,
  targetMaxMinutes: 240,
  spec: 'OPERATIONS §5 (RTO 2–4 h, total VM loss); §6.3 rule 4',
};

/** The restore drill's RTO path, in runbook 02 order. */
export const RTO_PATH_STEPS = {
  provisionVm: {
    id: 'provision_vm',
    title: 'Provision a new VM from the host contract (runbook 02 M2.1)',
    mode: 'manual',
    onRtoPath: true,
  },
  deployStack: {
    id: 'deploy_stack',
    title: 'Deploy the pinned images (runbook 02 M2.2)',
    mode: 'manual',
    onRtoPath: true,
  },
  restoreSecrets: {
    id: 'restore_secrets',
    title: 'Restore the secrets env and confirm the tier-0 keys (runbook 02 M2.3)',
    mode: 'manual',
    onRtoPath: true,
  },
  restoreDatabase: {
    id: 'restore_database',
    title: 'Download, verify, decrypt and restore into a scratch database (runbook 02 M3)',
    mode: 'automated',
    onRtoPath: true,
  },
  promoteAndBoot: {
    id: 'promote_and_boot',
    title: 'Promote the scratch database, start the stack, `/readyz` 200 (runbook 02 M3, §5)',
    mode: 'manual',
    onRtoPath: true,
  },
  flipOrigin: {
    id: 'flip_origin',
    title: 'Flip the origin IP in Cloudflare (runbook 02 M2.5)',
    mode: 'manual',
    onRtoPath: true,
  },
} as const satisfies Record<string, DrillStepDefinition>;

export const MANUAL_RTO_STEPS: readonly DrillStepDefinition[] = Object.values(
  RTO_PATH_STEPS,
).filter((step) => step.mode === 'manual');

export function evaluateRto(
  steps: readonly DrillStep[],
  target: RtoTarget = RESTORE_RTO,
): RtoEvaluation {
  const path = steps.filter((step) => step.onRtoPath);
  const measuredMs = path.reduce(
    (sum, step) => sum + (step.status === 'passed' ? (step.durationMs ?? 0) : 0),
    0,
  );
  const measuredMinutes = Math.round(measuredMs / 6_000) / 10;
  const missing = path
    .filter((step) => step.status === 'not_performed' || step.status === 'skipped')
    .map((step) => step.id);
  const failed = path.filter((step) => step.status === 'failed').map((step) => step.id);
  const base = {
    measuredMinutes,
    targetMinMinutes: target.targetMinMinutes,
    targetMaxMinutes: target.targetMaxMinutes,
    missing,
    failed,
    spec: target.spec,
  };
  if (failed.length > 0) return { status: 'failed', ...base };
  // Even a lower bound past the target is a definite miss.
  if (measuredMinutes > target.targetMaxMinutes) return { status: 'exceeded', ...base };
  if (path.length === 0 || missing.length > 0) return { status: 'incomplete', ...base };
  return { status: 'met', ...base };
}

export interface ManualStepReport {
  readonly id: string;
  readonly minutes: number;
}

/**
 * `provision_vm:35` or `provision_vm:12.5`. Throws a RangeError naming the accepted ids;
 * the CLI turns it into a misconfiguration.
 */
export function parseManualStep(
  text: string,
  known: readonly DrillStepDefinition[] = MANUAL_RTO_STEPS,
): ManualStepReport {
  const match = /^([a-z_]+):(\d+(?:\.\d+)?)$/.exec(text);
  const ids = known.map((step) => step.id);
  if (match === null) {
    throw new RangeError(`--manual-step must be <id>:<minutes>, got ${JSON.stringify(text)}`);
  }
  const [, id = '', minutesText = ''] = match;
  if (!ids.includes(id)) {
    throw new RangeError(`unknown manual step ${JSON.stringify(id)}; one of ${ids.join(', ')}`);
  }
  const minutes = Number(minutesText);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
    throw new RangeError(`--manual-step minutes must be in (0, 1440], got ${minutesText}`);
  }
  return { id, minutes };
}
