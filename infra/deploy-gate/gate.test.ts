import { describe, expect, it } from 'vitest';

import { checklistFromTicks, parseChecklist, renderChecklistTemplate } from './checklist.js';
import { evaluateDeployGate, formatReport, type GateInput } from './gate.js';
import { CHECKS } from './register.js';
import { judgeReplay } from './replay-evidence.js';
import { SEASON_CALENDAR, calendarProblems, localTime, type SeasonCalendar } from './season.js';

const FREEZE = ['FREEZE-DEGRADATION', 'FREEZE-MAJOR-FIRE', 'FREEZE-ERROR-BUDGET'];
const SEASON_BOXES = ['L12-2', 'L12-3', 'L12-4', 'L12-5', 'L12-6', 'L12-7', 'L12-8'];
const ALL_ATTESTED = [...SEASON_BOXES, ...FREEZE];

// 2026-09-23 is a Wednesday; 12:00 UTC is 15:00 in Sofia (EEST).
const WED_IN_SEASON = new Date('2026-09-23T12:00:00Z');
const FRI_IN_SEASON = new Date('2026-09-25T09:00:00Z');
const SAT_IN_SEASON = new Date('2026-09-26T09:00:00Z');
const WED_OFF_SEASON = new Date('2026-11-11T10:00:00Z');

const GREEN_REPLAY = {
  exitCode: 0,
  log: '{"replay_gate_elsewhere":{"id":"S15","provenBy":"web/x.test.ts","stage":"pre-season"}}\n',
};

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    now: WED_IN_SEASON,
    calendar: SEASON_CALENDAR,
    checklist: checklistFromTicks(ALL_ATTESTED),
    replay: GREEN_REPLAY,
    hotfix: null,
    actor: 'ivan',
    ...overrides,
  };
}

const status = (result: ReturnType<typeof evaluateDeployGate>, id: string): string | undefined =>
  result.findings.find((f) => f.id === id)?.status;

describe('register', () => {
  it('carries exactly the eight L-12 boxes, only box 1 machine-decided', () => {
    const l12 = CHECKS.filter((c) => c.id.startsWith('L12-'));
    expect(l12.map((c) => c.id)).toEqual([
      'L12-1',
      'L12-2',
      'L12-3',
      'L12-4',
      'L12-5',
      'L12-6',
      'L12-7',
      'L12-8',
    ]);
    expect(l12.every((c) => c.scope === 'season')).toBe(true);
    expect(CHECKS.filter((c) => c.source === 'machine').map((c) => c.id)).toEqual(['L12-1']);
  });

  it('applies the OPERATIONS §9.3 freeze boxes all year', () => {
    expect(CHECKS.filter((c) => c.scope === 'always').map((c) => c.id)).toEqual(FREEZE);
  });
});

describe('season calendar', () => {
  it('ships the spec dates and leaves the evening hours unarmed', () => {
    expect(SEASON_CALENDAR.seasonStart).toEqual({ month: 6, day: 1 });
    expect(SEASON_CALENDAR.seasonEnd).toEqual({ month: 10, day: 15 });
    expect(SEASON_CALENDAR.evening).toBeNull();
    expect(calendarProblems(SEASON_CALENDAR)).toEqual([]);
  });

  it('reads the calendar in Sofia, not in the runner zone', () => {
    // 21:30 UTC on May 31 is 00:30 on June 1 in Sofia — already season.
    const local = localTime(new Date('2026-05-31T21:30:00Z'), 'Europe/Sofia');
    expect([local.month, local.day, local.hour, local.weekday]).toEqual([6, 1, 0, 'Mon']);
    expect(evaluateDeployGate(input({ now: new Date('2026-05-31T21:30:00Z') })).inSeason).toBe(
      true,
    );
    expect(evaluateDeployGate(input({ now: new Date('2026-05-31T20:30:00Z') })).inSeason).toBe(
      false,
    );
  });

  it('includes Oct 15 and excludes Oct 16', () => {
    expect(evaluateDeployGate(input({ now: new Date('2026-10-15T20:59:00Z') })).inSeason).toBe(
      true,
    );
    expect(evaluateDeployGate(input({ now: new Date('2026-10-15T21:00:00Z') })).inSeason).toBe(
      false,
    );
  });

  it('refuses a malformed calendar instead of evaluating against it', () => {
    const bad: SeasonCalendar = {
      timeZone: 'Mars/Olympus',
      seasonStart: { month: 13, day: 1 },
      seasonEnd: { month: 10, day: 0 },
      evening: { fromHour: 25, toHour: 25 },
    };
    const result = evaluateDeployGate(input({ calendar: bad }));
    expect(result.allowed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.id).toBe('CALENDAR');
    expect(calendarProblems(bad)).toHaveLength(6);
  });
});

describe('in season', () => {
  it('allows a weekday deploy with every box ticked and the full pre-season set green', () => {
    const result = evaluateDeployGate(input());
    expect(result.inSeason).toBe(true);
    expect(result.allowed).toBe(true);
    expect(status(result, 'L12-1')).toBe('pass');
    expect(status(result, 'L12-WINDOW-EVENING')).toBe('unarmed');
  });

  it.each(SEASON_BOXES)('denies when %s is unticked', (box) => {
    const ticks = ALL_ATTESTED.filter((id) => id !== box);
    const result = evaluateDeployGate(input({ checklist: checklistFromTicks(ticks) }));
    expect(result.allowed).toBe(false);
    expect(status(result, box)).toBe('fail');
  });

  it('denies on Friday and at the weekend', () => {
    for (const now of [FRI_IN_SEASON, SAT_IN_SEASON]) {
      const result = evaluateDeployGate(input({ now }));
      expect(result.allowed).toBe(false);
      expect(status(result, 'L12-WINDOW-DAY')).toBe('fail');
    }
  });

  it('enforces the evening window once it is armed, including across midnight', () => {
    const calendar: SeasonCalendar = { ...SEASON_CALENDAR, evening: { fromHour: 18, toHour: 7 } };
    // 17:00 UTC = 20:00 Sofia; 02:00 UTC = 05:00 Sofia; 12:00 UTC = 15:00 Sofia.
    const at = (iso: string): string | undefined =>
      status(evaluateDeployGate(input({ calendar, now: new Date(iso) })), 'L12-WINDOW-EVENING');
    expect(at('2026-09-23T17:00:00Z')).toBe('fail');
    expect(at('2026-09-23T02:00:00Z')).toBe('fail');
    expect(at('2026-09-23T12:00:00Z')).toBe('pass');
  });

  it('fails box 1 when a pre-season scenario is blocked, even though the replay exited 0', () => {
    const log = [
      '{"replay_gate_blocked":{"blockedBy":"D10 — no mask data","id":"S3","stage":"pre-season"}}',
      '{"fixtures":[]}',
      'not json at all',
    ].join('\n');
    const result = evaluateDeployGate(input({ replay: { exitCode: 0, log } }));
    expect(result.allowed).toBe(false);
    expect(result.findings.find((f) => f.id === 'L12-1')?.detail).toContain('S3 is blocked');
  });

  it('fails box 1 closed when the replay evidence is missing or red', () => {
    expect(judgeReplay({ exitCode: null, log: null }).green).toBe(false);
    expect(judgeReplay({ exitCode: 1, log: '' }).green).toBe(false);
    expect(judgeReplay({ exitCode: 0, log: null }).green).toBe(false);
    expect(
      judgeReplay({
        exitCode: 0,
        log: '{"replay_fixture_failed":{"id":"S2","asserts":"x","differences":[]}}',
      }).reasons,
    ).toEqual(['fixture S2 failed']);
  });

  it('rejects replay evidence from the wrong stage', () => {
    const log = '{"replay_gate_elsewhere":{"id":"S15","provenBy":"x","stage":"pre-merge"}}';
    const verdict = judgeReplay({ exitCode: 0, log });
    expect(verdict.green).toBe(false);
    expect(verdict.reasons[0]).toContain('wrong --gate');
  });
});

describe('off season', () => {
  it('needs only the freeze boxes; the eight are not demanded', () => {
    const result = evaluateDeployGate(
      input({
        now: WED_OFF_SEASON,
        checklist: checklistFromTicks(FREEZE),
        replay: { exitCode: null, log: null },
      }),
    );
    expect(result.inSeason).toBe(false);
    expect(result.allowed).toBe(true);
    expect(status(result, 'L12-1')).toBe('not-required');
    expect(status(result, 'L12-WINDOW-DAY')).toBe('not-required');
  });

  it('still honours the year-round deploy freeze', () => {
    const result = evaluateDeployGate(
      input({ now: WED_OFF_SEASON, checklist: checklistFromTicks(['FREEZE-DEGRADATION']) }),
    );
    expect(result.allowed).toBe(false);
    expect(status(result, 'FREEZE-MAJOR-FIRE')).toBe('fail');
  });
});

describe('hotfix path', () => {
  it('exempts a hotfix from the deploy window and the freeze, but not from the other boxes', () => {
    const result = evaluateDeployGate(
      input({
        now: SAT_IN_SEASON,
        checklist: checklistFromTicks(SEASON_BOXES),
        hotfix: { incident: 'INC-7', secondAckBy: null },
      }),
    );
    expect(result.allowed).toBe(true);
    expect(status(result, 'L12-WINDOW-DAY')).toBe('exempt');
    expect(status(result, 'FREEZE-MAJOR-FIRE')).toBe('exempt');

    const missingRollback = evaluateDeployGate(
      input({
        now: SAT_IN_SEASON,
        checklist: checklistFromTicks(SEASON_BOXES.filter((b) => b !== 'L12-5')),
        hotfix: { incident: 'INC-7', secondAckBy: null },
      }),
    );
    expect(missingRollback.allowed).toBe(false);
    expect(status(missingRollback, 'L12-5')).toBe('fail');
  });

  it('is no hotfix at all without an incident reference', () => {
    const result = evaluateDeployGate(
      input({ now: SAT_IN_SEASON, hotfix: { incident: '  ', secondAckBy: null } }),
    );
    expect(result.allowed).toBe(false);
    expect(status(result, 'HOTFIX')).toBe('fail');
    expect(status(result, 'L12-WINDOW-DAY')).toBe('fail');
  });

  it('exempts box 2 only with an ack from a second person', () => {
    const without2 = checklistFromTicks(ALL_ATTESTED.filter((b) => b !== 'L12-2'));
    const run = (secondAckBy: string | null, actor: string | null = 'ivan'): string | undefined =>
      status(
        evaluateDeployGate(
          input({ checklist: without2, actor, hotfix: { incident: 'INC-7', secondAckBy } }),
        ),
        'L12-2',
      );
    expect(run(null)).toBe('fail');
    expect(run('Ivan')).toBe('fail');
    expect(run('maria', null)).toBe('fail');
    expect(run('maria')).toBe('exempt');
  });
});

describe('checklist parsing', () => {
  it('reads ticks by id and ignores the prose', () => {
    const parsed = parseChecklist(
      [
        'Deploy request for abc123',
        '- [x] `L12-3` whatever the label says today',
        '* [X] `FREEZE-MAJOR-FIRE`',
        '- [ ] `L12-5` Rollback rehearsed',
        '- [x] not a box id',
      ].join('\n'),
    );
    expect(parsed.errors).toEqual([]);
    expect([...parsed.ticked].sort()).toEqual(['FREEZE-MAJOR-FIRE', 'L12-3']);
  });

  it('turns every ambiguity into an error', () => {
    const parsed = parseChecklist(
      [
        '- [x] `L12-9` typo',
        '- [x] `L12-3`',
        '- [ ] `L12-3`',
        '- [x] `L12-1` replay is green, trust me',
        '- [~] `L12-4`',
      ].join('\n'),
    );
    expect(parsed.errors).toHaveLength(4);
    expect(parsed.errors.join('\n')).toMatch(/unknown box `L12-9`/);
    expect(parsed.errors.join('\n')).toMatch(/`L12-3` appears more than once/);
    expect(parsed.errors.join('\n')).toMatch(/`L12-1` is decided from CI evidence/);
    expect(parsed.errors.join('\n')).toMatch(/"\[~\]"/);

    const result = evaluateDeployGate(input({ checklist: parsed }));
    expect(status(result, 'CHECKLIST')).toBe('fail');
    expect(result.allowed).toBe(false);
  });

  it('renders a template that parses clean with nothing ticked', () => {
    const template = renderChecklistTemplate();
    const parsed = parseChecklist(template);
    expect(parsed.errors).toEqual([]);
    expect(parsed.ticked.size).toBe(0);
    expect(template.split('\n')).toHaveLength(ALL_ATTESTED.length);
    const allTicked = parseChecklist(template.replaceAll('- [ ]', '- [x]'));
    expect([...allTicked.ticked].sort()).toEqual([...ALL_ATTESTED].sort());
  });
});

describe('report', () => {
  it('states the verdict, the regime and every finding', () => {
    const report = formatReport(evaluateDeployGate(input({ now: FRI_IN_SEASON })));
    expect(report).toContain('## Deploy gate: DENIED');
    expect(report).toContain('fire season (L-12 regime)');
    expect(report).toContain('2026-09-25 12:00 Fri Europe/Sofia');
    expect(report).toMatch(/`L12-WINDOW-DAY`.*\| FAIL \|/);
    expect(report).toMatch(/`L12-WINDOW-EVENING`.*\| UNARMED \|/);
  });
});
