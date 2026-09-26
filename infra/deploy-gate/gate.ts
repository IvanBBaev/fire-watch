/**
 * The deploy gate (GATES §3 L-12, TASKS J4): a pure function from what CI can supply —
 * the instant, the season calendar, the requester's checklist, the pre-season replay
 * evidence and the hotfix declaration — to an allow/deny verdict with one finding per rule.
 *
 * L-12's pass condition is "a deploy with an unchecked box fails", so every rule is
 * fail-closed: missing evidence is a failure, not a skip. The only non-blocking status
 * is `unarmed`, reserved for a rule whose parameters the spec leaves open (the evening
 * hours); it is printed on every run so the gap cannot go quiet.
 *
 * Regimes:
 *  - Off-season: CI green (enforced by the workflow's `needs:`) and the OPERATIONS §9.3
 *    freeze boxes. The 8 checkboxes are not demanded (06 §5.7 "normal continuous delivery").
 *  - Season: all of the above, all 8 checkboxes, and no Friday/weekend/evening deploy.
 *  - Hotfix (either regime): exempt from the deploy-window rules and the freeze boxes when
 *    it names the incident; exempt from box 2 only with a second person's ack (06 §5.7).
 *    Every other box still applies — a hotfix is not a licence to skip the rollback check.
 */

import type { ParsedChecklist } from './checklist.js';
import { CHECKS, type CheckDefinition } from './register.js';
import { judgeReplay, type ReplayEvidence } from './replay-evidence.js';
import {
  calendarProblems,
  isFridayOrWeekend,
  isInSeason,
  isInWindow,
  localTime,
  type LocalTime,
  type SeasonCalendar,
} from './season.js';

export interface HotfixDeclaration {
  /** The incident this hotfix is for (OPERATIONS §9.3 rule 4: "the incident itself"). */
  readonly incident: string;
  /** The second person acknowledging a deploy during an active severe event (06 §5.7). */
  readonly secondAckBy: string | null;
}

export interface GateInput {
  readonly now: Date;
  readonly calendar: SeasonCalendar;
  readonly checklist: ParsedChecklist;
  readonly replay: ReplayEvidence;
  readonly hotfix: HotfixDeclaration | null;
  /** Who requested the deploy (the workflow's `github.actor`). */
  readonly actor: string | null;
}

export type FindingStatus = 'pass' | 'fail' | 'exempt' | 'not-required' | 'unarmed';

export interface Finding {
  readonly id: string;
  readonly label: string;
  readonly status: FindingStatus;
  readonly detail: string;
}

export interface GateResult {
  readonly allowed: boolean;
  readonly inSeason: boolean;
  readonly local: LocalTime | null;
  readonly findings: readonly Finding[];
}

const nonEmpty = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim().length > 0;

export function evaluateDeployGate(input: GateInput): GateResult {
  const findings: Finding[] = [];

  const problems = calendarProblems(input.calendar);
  if (problems.length > 0) {
    findings.push({
      id: 'CALENDAR',
      label: 'Season calendar is well-formed',
      status: 'fail',
      detail: problems.join('; '),
    });
    return { allowed: false, inSeason: false, local: null, findings };
  }

  const local = localTime(input.now, input.calendar.timeZone);
  const inSeason = isInSeason(local, input.calendar);

  findings.push({
    id: 'CHECKLIST',
    label: 'Checklist parses cleanly',
    status: input.checklist.errors.length === 0 ? 'pass' : 'fail',
    detail: input.checklist.errors.length === 0 ? 'ok' : input.checklist.errors.join('; '),
  });

  // A hotfix that names no incident is not a hotfix; it gets no exemption and fails, so
  // "hotfix" cannot become the word that unlocks a Friday deploy.
  const hotfix = input.hotfix;
  const validHotfix = hotfix !== null && nonEmpty(hotfix.incident);
  if (hotfix !== null) {
    findings.push({
      id: 'HOTFIX',
      label: 'Hotfix names the incident it fixes',
      status: validHotfix ? 'pass' : 'fail',
      detail: validHotfix ? `incident: ${hotfix.incident.trim()}` : 'no incident reference',
    });
  }

  findings.push(...windowFindings(local, inSeason, input.calendar, validHotfix));

  for (const check of CHECKS) {
    findings.push(checkFinding(check, input, inSeason, validHotfix));
  }

  const allowed = findings.every((f) => f.status !== 'fail');
  return { allowed, inSeason, local, findings };
}

function windowFindings(
  local: LocalTime,
  inSeason: boolean,
  calendar: SeasonCalendar,
  hotfix: boolean,
): Finding[] {
  const dayLabel = 'Season: no deploys Friday or weekend';
  const eveningLabel = 'Season: no deploys in the evening';
  if (!inSeason) {
    const detail = `off-season (${local.display})`;
    return [
      { id: 'L12-WINDOW-DAY', label: dayLabel, status: 'not-required', detail },
      { id: 'L12-WINDOW-EVENING', label: eveningLabel, status: 'not-required', detail },
    ];
  }

  const day: Finding = isFridayOrWeekend(local)
    ? hotfix
      ? {
          id: 'L12-WINDOW-DAY',
          label: dayLabel,
          status: 'exempt',
          detail: `hotfix on ${local.display}`,
        }
      : {
          id: 'L12-WINDOW-DAY',
          label: dayLabel,
          status: 'fail',
          detail: `${local.display} is Friday or weekend`,
        }
    : { id: 'L12-WINDOW-DAY', label: dayLabel, status: 'pass', detail: local.display };

  let evening: Finding;
  if (calendar.evening === null) {
    evening = {
      id: 'L12-WINDOW-EVENING',
      label: eveningLabel,
      status: 'unarmed',
      detail: 'UNARMED: no spec document gives the evening hours (founder decision)',
    };
  } else {
    const window = calendar.evening;
    const span = `${window.fromHour}:00–${window.toHour}:00`;
    evening = !isInWindow(local.hour, window)
      ? {
          id: 'L12-WINDOW-EVENING',
          label: eveningLabel,
          status: 'pass',
          detail: `${local.display}, outside ${span}`,
        }
      : hotfix
        ? {
            id: 'L12-WINDOW-EVENING',
            label: eveningLabel,
            status: 'exempt',
            detail: `hotfix inside ${span}`,
          }
        : {
            id: 'L12-WINDOW-EVENING',
            label: eveningLabel,
            status: 'fail',
            detail: `${local.display} is inside ${span}`,
          };
  }
  return [day, evening];
}

function checkFinding(
  check: CheckDefinition,
  input: GateInput,
  inSeason: boolean,
  hotfix: boolean,
): Finding {
  const base = { id: check.id, label: check.label };

  if (check.scope === 'season' && !inSeason) {
    return { ...base, status: 'not-required', detail: 'off-season' };
  }

  if (check.source === 'machine') {
    const verdict = judgeReplay(input.replay);
    return verdict.green
      ? { ...base, status: 'pass', detail: 'pre-season replay green, nothing blocked' }
      : { ...base, status: 'fail', detail: verdict.reasons.join('; ') };
  }

  if (input.checklist.ticked.has(check.id)) {
    return { ...base, status: 'pass', detail: 'attested' };
  }

  if (hotfix && check.hotfixExemption === 'incident') {
    return { ...base, status: 'exempt', detail: 'hotfix for the incident itself' };
  }
  if (hotfix && check.hotfixExemption === 'incident-and-second-ack') {
    const ack = input.hotfix?.secondAckBy ?? null;
    if (!nonEmpty(ack)) {
      return {
        ...base,
        status: 'fail',
        detail: "unticked; the hotfix exemption needs a second person's ack",
      };
    }
    if (!nonEmpty(input.actor)) {
      return {
        ...base,
        status: 'fail',
        detail:
          'unticked; the requester is unknown, so the ack cannot be shown to be a second person',
      };
    }
    if (ack.trim().toLowerCase() === input.actor.trim().toLowerCase()) {
      return {
        ...base,
        status: 'fail',
        detail: `unticked; the ack is by the requester (${ack.trim()}), not a second person`,
      };
    }
    return { ...base, status: 'exempt', detail: `hotfix, acknowledged by ${ack.trim()}` };
  }

  return { ...base, status: 'fail', detail: 'unticked' };
}

const MARK: Readonly<Record<FindingStatus, string>> = {
  pass: 'PASS',
  fail: 'FAIL',
  exempt: 'EXEMPT',
  'not-required': 'n/a',
  unarmed: 'UNARMED',
};

/** A Markdown report — the job summary is the deploy record. */
export function formatReport(result: GateResult): string {
  const regime = result.inSeason ? 'fire season (L-12 regime)' : 'off-season';
  const when = result.local?.display ?? 'unknown time';
  const lines = [
    `## Deploy gate: ${result.allowed ? 'ALLOWED' : 'DENIED'}`,
    '',
    `${when} — ${regime}`,
    '',
    '| Box | Status | Detail |',
    '| --- | --- | --- |',
    ...result.findings.map(
      (f) => `| \`${f.id}\` ${f.label} | ${MARK[f.status]} | ${f.detail.replace(/\|/g, '\\|')} |`,
    ),
  ];
  return lines.join('\n');
}
