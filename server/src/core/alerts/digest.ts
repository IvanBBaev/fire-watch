/**
 * The daily digest producer — D9's second half (ADR-004 D3/D4 as amended by A1.7, A1.8,
 * A1.11 and A1.12; 07 §5.5.3).
 *
 * {@link decideAlert} decides one event for one zone and, when it must not interrupt,
 * returns `defer`: the state advances, the ladder step is spent, and the news is owed to
 * the reader without a row being written. `seed` owes even more — a fire that was already
 * burning when the zone was drawn is deliberately never pushed (A1.8), and the digest is
 * the only place it can legitimately surface. Something has to collect those debts once a
 * day. This is that something.
 *
 * It is built to the same three constraints as the decision function, for the same
 * reasons: it **sends nothing** (it returns rows a transaction may write), it **reads no
 * clock** (the decision instant is a parameter, so a replay of last October produces last
 * October's digests), and it **keeps no state** (the account's last window arrives as a
 * parameter and the advance is returned as a flag, so the caller owns the watermark).
 *
 * Three things here are easy to get subtly wrong, and each has a rule:
 *
 *   - **The window is a local calendar instant, never an interval of milliseconds.** Two
 *     consecutive 09:00 digests in Europe/Sofia are 25 hours apart on 25 Oct 2026 and 23
 *     hours apart on 28 Mar 2027. Anything that advances a window by adding 86 400 000 ms
 *     drifts an hour twice a year and then sends two digests on one day, or none. So each
 *     window is resolved from a local date through the tz database, the same mechanism
 *     {@link isInQuietHours} already uses. Fixture S14 pins both transitions.
 *   - **A held digest does not consume its window.** Quiet hours apply to `digest` (A1.7)
 *     and the digest never overrides them (07 §5.5.3), so a window that opens inside a
 *     reader's quiet hours is *held*, not dropped: the watermark stays put and the same
 *     window fires under the same subkey once the quiet hours end. A window that opens
 *     with nothing to say is the opposite — it is spent, because "the digest naturally
 *     stops when nothing is active" (07 §5.5.3) and a fire that starts at 11:00 is
 *     tomorrow's news, not a late delivery of today's.
 *   - **One event is one line, rendered from the nearest zone.** A reader with three zones
 *     around the same fire gets one line about it (A1.12). The ordering is
 *     {@link compareZoneProximity}'s and nothing else's — the comparator is exported for
 *     precisely this caller, so that "which zone renders this fire" has one answer in the
 *     codebase rather than two that agree until they don't.
 *
 * What this deliberately does *not* do is render. A digest row carries the event and the
 * zone that owns it; turning N rows into one message is the gateway's job (D1), and the
 * subkey is what lets it group them: every row of one window shares
 * `digestSubkey(windowStartIso)`, which under A1.11's `UNIQUE (zone_id, event_id,
 * alert_type, alert_subkey)` also makes it impossible to summarise the same fire twice in
 * one day.
 */

import { ALERT_GATING, type AlertGatingParams } from '../config/alert-gating.js';
import { DIGEST_PARAMS, type DigestParams } from '../config/digest-params.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { isoFromEpochMs, epochMsFromIso, type EpochMs } from '../ports/clock.js';
import {
  compareZoneProximity,
  digestSubkey,
  isInQuietHours,
  type AlertZone,
} from './alert-decision.js';

/**
 * What a window resolved to.
 *
 * `hold` and `suppress` differ only in whether the window is spent, and that difference is
 * the whole of the digest's honesty: a held window comes back, a suppressed one does not.
 */
export const DIGEST_OUTCOMES = ['send', 'hold', 'suppress', 'none'] as const;

export type DigestOutcome = (typeof DIGEST_OUTCOMES)[number];

export const DIGEST_REASONS = [
  /** No window has opened since the last one this account was given. */
  'no_window_due',
  /** The window opened inside the reader's quiet hours; it is owed, not spent (A1.7). */
  'quiet_hours',
  /** The window opened with nothing active to report, and is spent (07 §5.5.3). */
  'nothing_active',
  /** The ordinary outcome: a window, with something in it. */
  'daily_summary',
] as const;

export type DigestReason = (typeof DIGEST_REASONS)[number];

/**
 * Why an event is owed to this window.
 *
 * The kinds are not cosmetic — each is filtered by a different rule, because each is owed
 * for a different reason.
 */
export const DIGEST_CANDIDATE_KINDS = [
  /** `decideAlert` returned `defer`: decided, state advanced, never delivered (D3). */
  'deferred',
  /** Pre-existing at zone creation, so never pushable — the digest is its only door (A1.8). */
  'seeded',
  /** Neither, but still burning: the "≥1 event active in any zone" leg of 07 §5.5.3. */
  'active',
] as const;

export type DigestCandidateKind = (typeof DIGEST_CANDIDATE_KINDS)[number];

/**
 * One (zone, event) pair the caller believes is owed to a digest.
 *
 * **Precondition the caller owns:** the event is currently active in that zone — not
 * merged away, not invalidated, not out. This function will not second-guess it, because
 * doing so would mean holding a second copy of what "active" means alongside the lifecycle
 * engine's.
 */
export interface DigestCandidate {
  readonly zoneId: string;
  readonly eventPublicId: string;
  /** Zone centre to event geometry, in km — the A1.12 ordering key. */
  readonly distanceKm: number;
  readonly kind: DigestCandidateKind;
  /**
   * The instant that made this a candidate: the deferral, the seed, or the event's first
   * sighting. Compared against window boundaries, never against `now`.
   */
  readonly since: EpochMs;
}

/** One line of the message, and one `alert_outbox` row under A1.11's unique key. */
export interface DigestEntry {
  readonly zoneId: string;
  readonly eventPublicId: string;
  readonly distanceKm: number;
  readonly kind: DigestCandidateKind;
}

export interface DigestInput {
  readonly accountId: string;
  /**
   * Every zone the account owns. Non-empty, and agreeing on a timezone: A1.7 stores the
   * timezone per account, so two zones that disagree are a data fault, not a case to
   * resolve by picking one.
   */
  readonly zones: readonly AlertZone[];
  readonly candidates: readonly DigestCandidate[];
  /**
   * Window start of the last digest this account was *given* — not the last one that came
   * due. `null` means none ever, which fires: a new reader's first window is a real one.
   */
  readonly lastWindowStartIso: string | null;
  /**
   * When this account started watching — the earliest `created_at` among its zones. A
   * window that opened before the reader existed is not owed to them: signing up at 11:00
   * must not draw an immediate "09:00 daily summary" two hours late, it must wait for
   * tomorrow's. This is the only reason the producer needs to know anything about a zone
   * beyond its alerting parameters.
   */
  readonly watchingSince: EpochMs;
  /** The decision instant. */
  readonly at: EpochMs;
}

export interface DigestDecision {
  readonly accountId: string;
  readonly outcome: DigestOutcome;
  readonly reason: DigestReason;
  /** The window this decision is about, or `null` when none had opened yet. */
  readonly windowStartIso: string | null;
  readonly alertType: 'digest' | null;
  readonly alertSubkey: string | null;
  readonly priority: number | null;
  /**
   * Whether the caller may move the account's watermark to `windowStartIso`. False for a
   * held window — that is what makes the hold a delay rather than a loss.
   */
  readonly advanceWatermark: boolean;
  readonly ruleVersion: string;
  readonly entries: readonly DigestEntry[];
}

/**
 * Decide the account's digest at `at`.
 *
 * Called once per account per tick. Cheap enough to be: the only per-candidate work is a
 * comparison, and the window resolution is three `Intl` formats against a cached formatter.
 */
export function produceDigest(
  input: DigestInput,
  config: VersionedConfig<DigestParams> = DIGEST_PARAMS,
  gating: VersionedConfig<AlertGatingParams> = ALERT_GATING,
): DigestDecision {
  const timezone = accountTimezone(input);
  const windowStart = windowStartAtOrBefore(input.at, timezone, config.values);
  const lastWindowStart =
    input.lastWindowStartIso === null ? null : epochMsFromIso(input.lastWindowStartIso);

  if (lastWindowStart !== null && lastWindowStart >= windowStart) {
    return nothing(input, config, 'no_window_due');
  }

  // Not due *to this account*: the last window opened before they were watching. Same
  // reason as an already-spent window, because from the reader's side it is the same
  // statement — there is no window they are owed yet.
  if (windowStart < input.watchingSince) {
    return nothing(input, config, 'no_window_due');
  }

  const windowStartIso = isoFromEpochMs(windowStart);

  // Held, not skipped: the watermark stays where it is, so this same window is re-offered
  // on the next tick and lands under the same subkey the moment the quiet hours end.
  if (input.zones.some((zone) => isInQuietHours(input.at, zone))) {
    return {
      accountId: input.accountId,
      outcome: 'hold',
      reason: 'quiet_hours',
      windowStartIso,
      alertType: null,
      alertSubkey: null,
      priority: null,
      advanceWatermark: false,
      ruleVersion: config.version,
      entries: [],
    };
  }

  const entries = foldEntries(input.candidates, windowStart, lastWindowStart, gating.values);

  if (entries.length === 0) {
    // Spent, unlike a hold. A window that opened over a quiet map was answered correctly by
    // saying nothing, and a fire that starts two hours later belongs to tomorrow's window.
    return {
      accountId: input.accountId,
      outcome: 'suppress',
      reason: 'nothing_active',
      windowStartIso,
      alertType: null,
      alertSubkey: null,
      priority: null,
      advanceWatermark: true,
      ruleVersion: config.version,
      entries: [],
    };
  }

  return {
    accountId: input.accountId,
    outcome: 'send',
    reason: 'daily_summary',
    windowStartIso,
    alertType: 'digest',
    alertSubkey: digestSubkey(windowStartIso),
    priority: gating.values.priorities.digest,
    advanceWatermark: true,
    ruleVersion: config.version,
    entries,
  };
}

function nothing(
  input: DigestInput,
  config: VersionedConfig<DigestParams>,
  reason: DigestReason,
): DigestDecision {
  return {
    accountId: input.accountId,
    outcome: 'none',
    reason,
    windowStartIso: null,
    alertType: null,
    alertSubkey: null,
    priority: null,
    advanceWatermark: false,
    ruleVersion: config.version,
    entries: [],
  };
}

function accountTimezone(input: DigestInput): string {
  const [first] = input.zones;
  if (first === undefined) {
    throw new RangeError(`account ${input.accountId} has no zones, so it has no digest window`);
  }
  for (const zone of input.zones) {
    if (zone.timezone !== first.timezone) {
      throw new RangeError(
        `account ${input.accountId} has zones in two timezones (${first.timezone}, ${zone.timezone}); ` +
          'A1.7 stores the timezone per account',
      );
    }
  }
  return first.timezone;
}

/**
 * Fold candidates to one entry per event, rendered from the nearest zone (A1.12).
 *
 * The three kinds are admitted by three different tests:
 *
 *   - `deferred` — anything deferred since the previous window, because a deferral is a
 *     debt and a window that did not run does not cancel it. With no previous window,
 *     every deferral the caller kept is owed.
 *   - `seeded` — only if the seed predates *this* window's opening. A1.8 says a seeded
 *     event is eligible "from the next window", so a zone drawn at 09:30 does not get its
 *     pre-existing fires summarised at 09:30 by a tick that arrives at 09:40.
 *   - `active` — unconditionally. This is the daily "still burning" line, and it is the
 *     leg that makes the digest stop on its own when the map goes quiet.
 */
function foldEntries(
  candidates: readonly DigestCandidate[],
  windowStart: EpochMs,
  lastWindowStart: EpochMs | null,
  params: AlertGatingParams,
): DigestEntry[] {
  const byEvent = new Map<string, DigestCandidate>();

  for (const candidate of candidates) {
    if (!isOwed(candidate, windowStart, lastWindowStart)) continue;

    const held = byEvent.get(candidate.eventPublicId);
    if (held === undefined || nearer(candidate, held, params) < 0) {
      byEvent.set(candidate.eventPublicId, candidate);
    }
  }

  return [...byEvent.values()]
    .sort((a, b) => nearer(a, b, params) || (a.eventPublicId < b.eventPublicId ? -1 : 1))
    .map((candidate) => ({
      zoneId: candidate.zoneId,
      eventPublicId: candidate.eventPublicId,
      distanceKm: candidate.distanceKm,
      kind: candidate.kind,
    }));
}

function isOwed(
  candidate: DigestCandidate,
  windowStart: EpochMs,
  lastWindowStart: EpochMs | null,
): boolean {
  switch (candidate.kind) {
    case 'deferred':
      return lastWindowStart === null || candidate.since >= lastWindowStart;
    case 'seeded':
      return candidate.since < windowStart;
    case 'active':
      return true;
  }
}

function nearer(a: DigestCandidate, b: DigestCandidate, params: AlertGatingParams): number {
  return compareZoneProximity(
    { zoneId: a.zoneId, distanceKm: a.distanceKm },
    { zoneId: b.zoneId, distanceKm: b.distanceKm },
    params,
  );
}

/** A local calendar date, in the proleptic Gregorian frame the tz database reports. */
interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * The most recent window start at or before `at`.
 *
 * Resolved from local *dates*, never by arithmetic on a previous window: the interval
 * between two 09:00s is not a constant, and treating it as one is the bug S14 exists to
 * catch.
 */
export function windowStartAtOrBefore(
  at: EpochMs,
  timezone: string,
  params: DigestParams,
): EpochMs {
  const today = localDate(at, timezone);
  const start = resolveLocalTime(today, params, timezone);
  return start <= at ? start : resolveLocalTime(previousDay(today), params, timezone);
}

/**
 * The instant at which `date` reads `windowHour:windowMinute` in `timezone`.
 *
 * A local wall clock is not a bijection twice a year, so both readings are constructed and
 * then checked:
 *
 *   - **Repeated** (fallback): both candidates render the wanted time, and the earlier one
 *     wins — the first time the clock says 09:00 is the one a reader would call 09:00.
 *   - **Skipped** (spring forward): neither renders it, and the later one wins, which is
 *     the first instant whose local clock has passed the window rather than one that never
 *     happened.
 *
 * Neither case can arise for the shipped 09:00 — the tz database puts its transitions in
 * the small hours — but the config is data, and a window that silently landed on the wrong
 * side of a transition would re-key a day's digests.
 */
function resolveLocalTime(date: LocalDate, params: DigestParams, timezone: string): EpochMs {
  // The wanted wall clock read as if it were UTC. Subtracting a real offset from it turns
  // it into the instant that shows that wall clock under that offset.
  const asIfUtc = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    params.windowHour,
    params.windowMinute,
    0,
  );
  const dayMs = 86_400_000;
  const before = asIfUtc - offsetMsAt(asIfUtc - dayMs, timezone);
  const after = asIfUtc - offsetMsAt(asIfUtc + dayMs, timezone);

  const valid = [before, after].filter((candidate) => rendersAs(candidate, date, params, timezone));
  return valid.length > 0 ? Math.min(...valid) : Math.max(before, after);
}

function rendersAs(at: EpochMs, date: LocalDate, params: DigestParams, timezone: string): boolean {
  const parts = localParts(at, timezone);
  return (
    parts.year === date.year &&
    parts.month === date.month &&
    parts.day === date.day &&
    parts.hour === params.windowHour &&
    parts.minute === params.windowMinute
  );
}

/**
 * The zone's UTC offset at `at`, in ms.
 *
 * Derived rather than looked up, because the runtime exposes the tz database only through
 * formatting: render the instant in the zone, read that wall clock back as if it were UTC,
 * and the difference is the offset. The core stays dependency-free (ADR-002), the same way
 * `alert-decision` reads local time.
 */
function offsetMsAt(at: EpochMs, timezone: string): number {
  const parts = localParts(at, timezone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at
  );
}

function localDate(at: EpochMs, timezone: string): LocalDate {
  const parts = localParts(at, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function previousDay(date: LocalDate): LocalDate {
  // Calendar arithmetic in the proleptic Gregorian frame, with no zone involved — the day
  // before a local date is the same everywhere, however long either day happens to be.
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day - 1));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

interface LocalParts extends LocalDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

// Constructing an Intl.DateTimeFormat is the expensive half of this file, and the digest
// runs once per account per tick; `alert-decision` caches its formatter for the same
// reason. An unknown zone throws `RangeError` here, which is the right place for a bad
// stored timezone to fail.
const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(at: EpochMs, timezone: string): LocalParts {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }

  const parts = formatter.formatToParts(at);
  return {
    year: partValue(parts, 'year'),
    month: partValue(parts, 'month'),
    day: partValue(parts, 'day'),
    hour: partValue(parts, 'hour'),
    minute: partValue(parts, 'minute'),
    second: partValue(parts, 'second'),
  };
}

function partValue(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const part = parts.find((candidate) => candidate.type === type);
  if (part === undefined) {
    throw new RangeError(`Intl did not report a ${type} part`);
  }
  return Number(part.value);
}
