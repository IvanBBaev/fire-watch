/**
 * The L-12 season calendar and its deploy-window rules, as config-as-data.
 *
 * GATES §3 L-12 / review 06 §5.7: the fire season is "≈ Jun 1 – Oct 15"; inside it there
 * are no deploys "Friday/weekend/evening except hotfixes". What the spec fixes is shipped;
 * what it leaves open is `null` and reported as UNARMED on every run, never guessed:
 *
 *  - The season bounds are the spec's own dates, inclusive at both ends (Oct 15 is the
 *    stricter reading of the two "≈" regimes that both name it). The "≈" is still a
 *    founder decision; changing it is a one-line edit here.
 *  - "Friday/weekend" is Friday, Saturday and Sunday, all day.
 *  - "Evening" has no hours in any spec document, so `evening` ships `null`: the rule is
 *    reported as unarmed instead of silently passing.
 *  - The calendar is read in Europe/Sofia — the operator's and the product's zone, the
 *    one ADR-004 and GATES §1.1 already use for local time — not in the runner's UTC.
 */

export interface MonthDay {
  /** 1–12. */
  readonly month: number;
  /** 1–31. */
  readonly day: number;
}

export interface HourWindow {
  /** Local hour the window opens, 0–23, inclusive. */
  readonly fromHour: number;
  /** Local hour the window closes, 0–24, exclusive. May be ≤ `fromHour` to wrap midnight. */
  readonly toHour: number;
}

export interface SeasonCalendar {
  readonly timeZone: string;
  readonly seasonStart: MonthDay;
  readonly seasonEnd: MonthDay;
  /** `null` = the evening rule is unarmed (not decided). */
  readonly evening: HourWindow | null;
}

export const SEASON_CALENDAR: SeasonCalendar = {
  timeZone: 'Europe/Sofia',
  seasonStart: { month: 6, day: 1 },
  seasonEnd: { month: 10, day: 15 },
  evening: null,
};

export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface LocalTime {
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly weekday: Weekday;
  /** For messages: `2026-09-23 14:05 Wed Europe/Sofia`. */
  readonly display: string;
}

const WEEKDAYS: readonly Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The wall-clock reading of `instant` in `timeZone`, independent of the host zone. */
export function localTime(instant: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    if (found === undefined) throw new Error(`Intl gave no ${type} for ${instant.toISOString()}`);
    return found.value;
  };
  const weekday = WEEKDAYS.find((w) => w === part('weekday'));
  if (weekday === undefined) throw new Error(`unexpected weekday ${part('weekday')}`);
  const month = Number(part('month'));
  const day = Number(part('day'));
  const hour = Number(part('hour'));
  return {
    month,
    day,
    hour,
    weekday,
    display: `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${weekday} ${timeZone}`,
  };
}

const ordinal = (md: MonthDay): number => md.month * 100 + md.day;

export function isInSeason(local: LocalTime, calendar: SeasonCalendar): boolean {
  const today = ordinal(local);
  const start = ordinal(calendar.seasonStart);
  const end = ordinal(calendar.seasonEnd);
  // A season that wraps the new year is not a Bulgarian fire season, but the arithmetic
  // costs one branch and a mistyped calendar should not silently mean "never in season".
  return start <= end ? today >= start && today <= end : today >= start || today <= end;
}

export function isFridayOrWeekend(local: LocalTime): boolean {
  return local.weekday === 'Fri' || local.weekday === 'Sat' || local.weekday === 'Sun';
}

export function isInWindow(hour: number, window: HourWindow): boolean {
  return window.fromHour <= window.toHour
    ? hour >= window.fromHour && hour < window.toHour
    : hour >= window.fromHour || hour < window.toHour;
}

/** Rejects a calendar that cannot mean what it says; run before any evaluation. */
export function calendarProblems(calendar: SeasonCalendar): string[] {
  const problems: string[] = [];
  const checkDay = (name: string, md: MonthDay): void => {
    if (!Number.isInteger(md.month) || md.month < 1 || md.month > 12) {
      problems.push(`${name}.month ${md.month} is not 1–12`);
    }
    if (!Number.isInteger(md.day) || md.day < 1 || md.day > 31) {
      problems.push(`${name}.day ${md.day} is not 1–31`);
    }
  };
  checkDay('seasonStart', calendar.seasonStart);
  checkDay('seasonEnd', calendar.seasonEnd);
  if (calendar.evening !== null) {
    const { fromHour, toHour } = calendar.evening;
    if (!Number.isInteger(fromHour) || fromHour < 0 || fromHour > 23) {
      problems.push(`evening.fromHour ${fromHour} is not 0–23`);
    }
    if (!Number.isInteger(toHour) || toHour < 0 || toHour > 24) {
      problems.push(`evening.toHour ${toHour} is not 0–24`);
    }
    if (fromHour === toHour) problems.push('evening window is empty (fromHour === toHour)');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: calendar.timeZone });
  } catch {
    problems.push(`timeZone ${calendar.timeZone} is not a known IANA zone`);
  }
  return problems;
}
