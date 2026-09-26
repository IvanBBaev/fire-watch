/**
 * L-12 box 1 from CI evidence: the golden replay under `--gate=pre-season`.
 *
 * `replay-cli --gate=pre-season` exits 0 while scenarios the register marks as blocked
 * (waiting on D10 and friends) are merely *noted* — right for CI-1, where a blocked
 * scenario is a known gap, and wrong for L-12, whose box reads "golden replay green incl.
 * the full pre-season set". A deploy in season therefore needs a zero exit **and** no
 * `replay_gate_blocked` note: a scenario that cannot run is not green.
 *
 * The notes are the CLI's canonical-JSON stderr records, one per line. Lines that are not
 * JSON objects are ignored — the exit code is what carries a crash.
 */

export interface ReplayEvidence {
  /** The replay CLI's exit code, or `null` when CI did not supply one. */
  readonly exitCode: number | null;
  /** The replay CLI's stderr, or `null` when CI did not supply it. */
  readonly log: string | null;
}

export interface ReplayVerdict {
  readonly green: boolean;
  readonly reasons: readonly string[];
}

const EXPECTED_STAGE = 'pre-season';
const STAGED_KEYS = ['replay_gate_blocked', 'replay_gate_problem', 'replay_gate_elsewhere'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function judgeReplay(evidence: ReplayEvidence): ReplayVerdict {
  const reasons: string[] = [];

  if (evidence.exitCode === null) {
    reasons.push('no replay exit code supplied — the pre-season replay did not run');
  } else if (evidence.exitCode !== 0) {
    reasons.push(`replay --gate=pre-season exited ${evidence.exitCode}`);
  }
  if (evidence.log === null) {
    reasons.push('no replay log supplied — blocked scenarios cannot be ruled out');
    return { green: false, reasons };
  }

  for (const line of evidence.log.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record === null) continue;

    for (const key of STAGED_KEYS) {
      const body = asRecord(record[key]);
      if (body === null) continue;
      const stage = body['stage'];
      if (stage !== EXPECTED_STAGE) {
        reasons.push(
          `replay log carries a ${key} note for stage ${String(stage)}, not ${EXPECTED_STAGE} — wrong --gate`,
        );
      }
    }

    const blocked = asRecord(record['replay_gate_blocked']);
    if (blocked !== null) {
      const blockedBy = typeof blocked['blockedBy'] === 'string' ? blocked['blockedBy'] : '?';
      const cut = blockedBy.length > 80 ? `${blockedBy.slice(0, 77)}...` : blockedBy;
      reasons.push(`scenario ${String(blocked['id'])} is blocked, not green (${cut})`);
    }
    if (record['replay_fixture_failed'] !== undefined) {
      const failed = asRecord(record['replay_fixture_failed']);
      reasons.push(`fixture ${String(failed?.['id'])} failed`);
    }
    const problem = asRecord(record['replay_gate_problem']);
    if (problem !== null) reasons.push(`gate problem: ${String(problem['problem'])}`);
  }

  return { green: reasons.length === 0, reasons };
}
