/**
 * The deploy-gate register: every box a deploy has to clear, as data.
 *
 * Two sources, quoted rather than paraphrased so a reviewer can hold each row against
 * its spec:
 *
 *  - GATES §3 L-12 — the season deploy regime and its 8-checkbox gate (detail from
 *    review 06 §5.7, the checklist the gate was lifted from).
 *  - OPERATIONS §9.3 rule 4 — the deploy freeze, which applies all year.
 *
 * `machine` boxes are decided from CI evidence and may not be ticked by a human; a ticked
 * machine box in a checklist is an error, not a harmless redundancy, because it would
 * read as if the human's tick counted. `attested` boxes are the ones only a person can
 * know; they are required ticks, and an absent line is an unticked box.
 */

export type CheckSource = 'machine' | 'attested';

/** When a box is demanded. */
export type CheckScope =
  /** Only inside the fire season (L-12). */
  | 'season'
  /** Every deploy, all year (OPERATIONS §9.3 rule 4). */
  | 'always';

export interface CheckDefinition {
  readonly id: string;
  readonly source: CheckSource;
  readonly scope: CheckScope;
  /** The box as the requester reads it. */
  readonly label: string;
  /** Where the box comes from. */
  readonly spec: string;
  /** A hotfix may leave this box unticked (and what that costs). */
  readonly hotfixExemption: 'none' | 'incident' | 'incident-and-second-ack';
}

export const CHECKS = [
  {
    id: 'L12-1',
    source: 'machine',
    scope: 'season',
    label: 'Golden replay green, including the full pre-season set (GATES §1.1)',
    spec: 'GATES §3 L-12 (1); 06 §5.7',
    hotfixExemption: 'none',
  },
  {
    id: 'L12-2',
    source: 'attested',
    scope: 'season',
    label:
      'No active severe event in the AOI: no currently-active event at or above the severe FRP/size threshold, and EFFIS danger not "extreme" over a populated area',
    spec: 'GATES §3 L-12 (2); 06 §5.7',
    // 06 §5.7: "otherwise deploy waits (hotfix path exempt, requires the second checkbox
    // owner's ack)".
    hotfixExemption: 'incident-and-second-ack',
  },
  {
    id: 'L12-3',
    source: 'attested',
    scope: 'season',
    label: 'Migration is expand-contract: no destructive step in the same deploy',
    spec: 'GATES §3 L-12 (3); 06 §5.7; OPERATIONS §9.3 rule 3',
    hotfixExemption: 'none',
  },
  {
    id: 'L12-4',
    source: 'attested',
    scope: 'season',
    label:
      'Alert-logic diff is none, or the change is behind a flag defaulting to the old behavior (flag + shadow process)',
    spec: 'GATES §3 L-12 (4); 06 §5.7',
    hotfixExemption: 'none',
  },
  {
    id: 'L12-5',
    source: 'attested',
    scope: 'season',
    label: 'Rollback rehearsed for this release: one command, under 5 minutes',
    spec: 'GATES §3 L-12 (5); 06 §5.7; OPERATIONS §9.3 rule 2',
    hotfixExemption: 'none',
  },
  {
    id: 'L12-6',
    source: 'attested',
    scope: 'season',
    // Verbatim "staging": the rehearsal-profile rewording (review 21 E8) is escalated and
    // not applied, and this label follows GATES, not the proposal.
    label:
      'Kill switches verified in staging: global alert pause (with public status banner) and per-source disable flags',
    spec: 'GATES §3 L-12 (6); 06 §5.7',
    hotfixExemption: 'none',
  },
  {
    id: 'L12-7',
    source: 'attested',
    scope: 'season',
    label:
      'Committed to the 30-minute post-deploy watch on the dashboard, with the synthetic E2E canary triggered manually once',
    spec: 'GATES §3 L-12 (7); 06 §5.7',
    hotfixExemption: 'none',
  },
  {
    id: 'L12-8',
    source: 'attested',
    scope: 'season',
    label: 'One real push received on a physical device (the 2-minute manual check, 06 §5.3)',
    spec: 'GATES §3 L-12 (8); 06 §5.7; L-5',
    hotfixExemption: 'none',
  },
  {
    id: 'FREEZE-DEGRADATION',
    source: 'attested',
    scope: 'always',
    label: 'fw_degradation_tier is 0 (no automatic degradation in force)',
    spec: 'OPERATIONS §9.3 rule 4',
    hotfixExemption: 'incident',
  },
  {
    id: 'FREEZE-MAJOR-FIRE',
    source: 'attested',
    scope: 'always',
    label: 'No active major-fire event',
    spec: 'OPERATIONS §9.3 rule 4',
    hotfixExemption: 'incident',
  },
  {
    id: 'FREEZE-ERROR-BUDGET',
    source: 'attested',
    scope: 'always',
    label: 'No error-budget freeze in force (OPERATIONS §4.1)',
    spec: 'OPERATIONS §9.3 rule 4; §4.1',
    hotfixExemption: 'incident',
  },
] as const satisfies readonly CheckDefinition[];

export type CheckId = (typeof CHECKS)[number]['id'];

const BY_ID: ReadonlyMap<string, CheckDefinition> = new Map(CHECKS.map((c) => [c.id, c]));

export function findCheck(id: string): CheckDefinition | undefined {
  return BY_ID.get(id);
}

export function isCheckId(id: string): id is CheckId {
  return BY_ID.has(id);
}
