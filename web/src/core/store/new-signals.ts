/**
 * "New since you last looked" — the pure half of the in-page new-signal counter.
 *
 * A signal is a fire event the viewer has not seen yet (`new`), or one they have seen that
 * has since grown: a later observation or more detections than when they saw it
 * (`updated`). What the viewer has seen is a small per-browser record keyed by public id,
 * holding the observation time and detection count they saw. It is a situational-awareness
 * cue about data that has arrived, never an alarm and never a claim about how current the
 * data is — the observation times travel with every signal so the copy can say how old
 * they are.
 *
 * Everything here is a pure function of its inputs: time arrives as epoch ms from the
 * caller's server-corrected clock, persistence is a string the UI layer reads and writes.
 */

import type { LifecycleState } from '@fire-watch/contracts';

import type { FireEvent } from '../types.js';

/** What the viewer saw of one event: its latest observation and detection count then. */
export interface SeenRecord {
  readonly lastObservedMs: number;
  readonly detectionCount: number;
}

export interface SeenState {
  /**
   * Events whose latest observation is at or before this instant are never `new`, seen or
   * not. It is set to the first load's time (so the first visit counts nothing) and only
   * ever moves forward, when pruning forgets records — anything the viewer could have seen
   * but whose record was dropped stays quiet unless it is observed again.
   */
  readonly floorMs: number;
  /** When the page was last hidden or closed; `null` before the first such moment. */
  readonly lastVisitMs: number | null;
  readonly seen: ReadonlyMap<string, SeenRecord>;
}

export type SignalKind = 'new' | 'updated';

export interface NewSignal {
  readonly id: string;
  readonly kind: SignalKind;
  readonly lastObservedMs: number;
  readonly event: FireEvent;
}

/** Only fires that are still being detected can be new or growing. */
const SIGNAL_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  'active',
  'signal_weakening',
]);

export const SEEN_STATE_VERSION = 1;
/** Records older than this (by observation time) are forgotten. */
export const DEFAULT_SEEN_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on persisted records, so the storage entry stays small. */
export const DEFAULT_SEEN_MAX_ENTRIES = 500;
/** The title badge stops counting here. */
export const TITLE_BADGE_CAP = 99;

function observedMs(event: FireEvent): number {
  return Date.parse(event.lastObservedAt);
}

function isCandidate(event: FireEvent): boolean {
  return (
    event.mergedInto === null &&
    SIGNAL_STATES.has(event.status) &&
    Number.isFinite(observedMs(event))
  );
}

function recordOf(event: FireEvent): SeenRecord {
  return { lastObservedMs: observedMs(event), detectionCount: event.detectionCount };
}

/**
 * The first-ever state: everything currently on screen is already seen and the floor is
 * "now", so a first visit shows no counter and makes no sound.
 */
export function baselineSeenState(
  events: ReadonlyMap<string, FireEvent>,
  nowMs: number,
): SeenState {
  const seen = new Map<string, SeenRecord>();
  for (const event of events.values()) {
    if (isCandidate(event)) seen.set(event.id, recordOf(event));
  }
  return { floorMs: nowMs, lastVisitMs: null, seen };
}

/**
 * Signals against a seen state, newest observation first (ties by id, so the order is
 * stable across renders).
 */
export function diffNewSignals(
  events: ReadonlyMap<string, FireEvent>,
  state: SeenState,
): readonly NewSignal[] {
  const signals: NewSignal[] = [];
  for (const event of events.values()) {
    if (!isCandidate(event)) continue;
    const lastObservedMs = observedMs(event);
    const record = state.seen.get(event.id);
    if (record === undefined) {
      if (lastObservedMs > state.floorMs) {
        signals.push({ id: event.id, kind: 'new', lastObservedMs, event });
      }
      continue;
    }
    if (lastObservedMs > record.lastObservedMs || event.detectionCount > record.detectionCount) {
      signals.push({ id: event.id, kind: 'updated', lastObservedMs, event });
    }
  }
  return signals.sort(
    (a, b) => b.lastObservedMs - a.lastObservedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Acknowledge the given events as they stand now; unknown ids are ignored. */
export function markSeen(
  state: SeenState,
  events: ReadonlyMap<string, FireEvent>,
  ids: Iterable<string>,
): SeenState {
  let seen: Map<string, SeenRecord> | null = null;
  for (const id of ids) {
    const event = events.get(id);
    if (event === undefined || !isCandidate(event)) continue;
    const next = recordOf(event);
    const current = (seen ?? state.seen).get(id);
    if (
      current !== undefined &&
      current.lastObservedMs >= next.lastObservedMs &&
      current.detectionCount >= next.detectionCount
    ) {
      continue;
    }
    seen ??= new Map(state.seen);
    seen.set(id, next);
  }
  return seen === null ? state : { ...state, seen };
}

/** Acknowledge every candidate event currently known. */
export function markAllSeen(state: SeenState, events: ReadonlyMap<string, FireEvent>): SeenState {
  return markSeen(state, events, events.keys());
}

export function withLastVisit(state: SeenState, nowMs: number): SeenState {
  return state.lastVisitMs === nowMs ? state : { ...state, lastVisitMs: nowMs };
}

export interface PruneOptions {
  readonly horizonMs?: number;
  readonly maxEntries?: number;
}

/**
 * Forget records older than the horizon and keep at most `maxEntries` of the newest. The
 * floor rises to cover whatever was forgotten, so a dropped record never resurfaces as
 * `new` for the observation the viewer already saw.
 */
export function pruneSeen(state: SeenState, nowMs: number, options: PruneOptions = {}): SeenState {
  const horizonMs = options.horizonMs ?? DEFAULT_SEEN_HORIZON_MS;
  const maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_SEEN_MAX_ENTRIES);
  const cutoff = nowMs - horizonMs;

  let floorMs = state.floorMs;
  const kept: [string, SeenRecord][] = [];
  for (const entry of state.seen) {
    if (entry[1].lastObservedMs < cutoff) {
      floorMs = Math.max(floorMs, entry[1].lastObservedMs);
    } else {
      kept.push(entry);
    }
  }
  if (kept.length > maxEntries) {
    kept.sort(
      (a, b) =>
        b[1].lastObservedMs - a[1].lastObservedMs || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    for (const [, record] of kept.splice(maxEntries)) {
      floorMs = Math.max(floorMs, record.lastObservedMs);
    }
  }
  if (kept.length === state.seen.size && floorMs === state.floorMs) return state;
  return { ...state, floorMs, seen: new Map(kept) };
}

/**
 * Signals worth a sound: observed after the viewer's last visit (never old news) and not
 * already cued this session. `null` last visit means there is no earlier visit to be newer
 * than, so the observation must be newer than the floor instead.
 */
export function soundEligible(
  signals: readonly NewSignal[],
  state: SeenState,
  alreadyCued: ReadonlySet<string>,
): readonly NewSignal[] {
  const since = Math.max(state.floorMs, state.lastVisitMs ?? Number.NEGATIVE_INFINITY);
  return signals.filter(
    (signal) =>
      signal.lastObservedMs > since && !alreadyCued.has(cueKey(signal.id, signal.lastObservedMs)),
  );
}

/** A cue is per observation, so a fire that grows again may cue again. */
export function cueKey(id: string, lastObservedMs: number): string {
  return `${id}@${String(lastObservedMs)}`;
}

/** "(3) Fire Watch"; the bare title at zero; capped as "(99+)". */
export function titleWithBadge(baseTitle: string, count: number): string {
  if (!Number.isFinite(count) || count <= 0) return baseTitle;
  const shown = count > TITLE_BADGE_CAP ? `${String(TITLE_BADGE_CAP)}+` : String(Math.floor(count));
  return `(${shown}) ${baseTitle}`;
}

interface SeenStateJson {
  readonly v: number;
  readonly floorMs: number;
  readonly lastVisitMs: number | null;
  readonly seen: Readonly<Record<string, readonly [number, number]>>;
}

export function serializeSeenState(state: SeenState): string {
  const seen: Record<string, readonly [number, number]> = {};
  for (const [id, record] of state.seen) {
    seen[id] = [record.lastObservedMs, record.detectionCount];
  }
  const json: SeenStateJson = {
    v: SEEN_STATE_VERSION,
    floorMs: state.floorMs,
    lastVisitMs: state.lastVisitMs,
    seen,
  };
  return JSON.stringify(json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a persisted state back, or `null` for anything absent, foreign or corrupt — the
 * caller then takes a fresh baseline, which errs towards showing nothing rather than
 * flooding the counter. Malformed individual records are dropped, not fatal.
 */
export function parseSeenState(raw: string | null): SeenState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { v, floorMs, lastVisitMs, seen } = parsed;
  if (v !== SEEN_STATE_VERSION) return null;
  if (typeof floorMs !== 'number' || !Number.isFinite(floorMs)) return null;
  if (lastVisitMs !== null && (typeof lastVisitMs !== 'number' || !Number.isFinite(lastVisitMs))) {
    return null;
  }
  if (!isRecord(seen)) return null;
  const records = new Map<string, SeenRecord>();
  for (const [id, value] of Object.entries(seen)) {
    if (!Array.isArray(value) || value.length !== 2) continue;
    const [observed, count] = value as unknown[];
    if (typeof observed !== 'number' || !Number.isFinite(observed)) continue;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) continue;
    records.set(id, { lastObservedMs: observed, detectionCount: count });
  }
  return { floorMs, lastVisitMs, seen: records };
}
