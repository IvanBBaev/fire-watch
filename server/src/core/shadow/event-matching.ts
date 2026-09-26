/**
 * Pairing live events with shadow events by what they are made of (ADR-002 D7 step 5).
 *
 * A candidate pipeline mints its own event keys, so "live `fw-2026-a1b2c` vs shadow
 * `s-17`" says nothing by itself. What the two sides share is the detection stream: an
 * event is its detection set, and two events that hold mostly the same detections are the
 * same fire seen by two rule sets. D7 step 5 is the rule, applied here exactly as written:
 *
 *   - **Detection-set Jaccard ≥ `minJaccard`**, `|A ∩ B| / |A ∪ B|`.
 *   - **Greedy in descending Jaccard.** The strongest pairing is decided first, so a
 *     weak overlap can never steal an event from a strong one.
 *   - **Each side claimed at most once.** A live event matches at most one shadow event
 *     and vice versa; what is left over is what the diff classifies as created, dropped,
 *     split or merged.
 *   - **Ties by the oldest event, then the lowest id.** D7 names the old event's age and
 *     internal id. Here the "old" side is live, its id is the public id (the diff never
 *     sees an internal bigint), and the shadow side breaks what is still tied the same
 *     way, so the order is total and no tie is left to `Array.prototype.sort`.
 *
 * The comparison is exact rational arithmetic — `a/b` against `c/d` as `a·d` against
 * `c·b` — because two Jaccards that are equal as fractions but differ in their last float
 * bits would order a tie by rounding, and CI-2's double run would then be a coin toss
 * across engines. Only the threshold is a float, and it is compared once per pair.
 */

import type { EpochMs } from '../ports/clock.js';

/** The slice of an event matching needs; both sides project to it. */
export interface MatchableEvent {
  readonly key: string;
  readonly startedAtMs: EpochMs;
  /** Distinct, in any order. Duplicates are refused rather than silently collapsed. */
  readonly detectionUids: readonly string[];
}

export interface EventMatch {
  readonly liveKey: string;
  readonly shadowKey: string;
  readonly intersection: number;
  readonly union: number;
}

export interface EventMatching {
  /** Sorted by `liveKey`. */
  readonly matches: readonly EventMatch[];
  readonly unmatchedLive: readonly string[];
  readonly unmatchedShadow: readonly string[];
}

interface Candidate {
  readonly live: MatchableEvent;
  readonly shadow: MatchableEvent;
  readonly intersection: number;
  readonly union: number;
}

export function matchEvents(
  live: readonly MatchableEvent[],
  shadow: readonly MatchableEvent[],
  minJaccard: number,
): EventMatching {
  if (!Number.isFinite(minJaccard) || minJaccard <= 0 || minJaccard > 1) {
    // Zero would pair events that share nothing; the threshold is a fraction of overlap.
    throw new RangeError(`minJaccard must be in (0, 1], got ${String(minJaccard)}`);
  }
  assertDistinctKeys(live, 'live');
  assertDistinctKeys(shadow, 'shadow');

  // An inverted index over the shadow side, so the candidate pairs are the ones that share
  // at least one detection rather than the full cross product of a busy August day.
  const shadowByUid = new Map<string, MatchableEvent[]>();
  for (const event of shadow) {
    for (const uid of distinctUids(event)) {
      const holders = shadowByUid.get(uid);
      if (holders === undefined) shadowByUid.set(uid, [event]);
      else holders.push(event);
    }
  }

  const candidates: Candidate[] = [];
  for (const liveEvent of live) {
    const liveUids = distinctUids(liveEvent);
    const overlap = new Map<MatchableEvent, number>();
    for (const uid of liveUids) {
      for (const holder of shadowByUid.get(uid) ?? []) {
        overlap.set(holder, (overlap.get(holder) ?? 0) + 1);
      }
    }
    for (const [shadowEvent, intersection] of overlap) {
      const union = liveUids.size + shadowEvent.detectionUids.length - intersection;
      if (intersection >= minJaccard * union) {
        candidates.push({ live: liveEvent, shadow: shadowEvent, intersection, union });
      }
    }
  }

  candidates.sort(compareCandidates);

  const claimedLive = new Set<string>();
  const claimedShadow = new Set<string>();
  const matches: EventMatch[] = [];
  for (const candidate of candidates) {
    if (claimedLive.has(candidate.live.key) || claimedShadow.has(candidate.shadow.key)) continue;
    claimedLive.add(candidate.live.key);
    claimedShadow.add(candidate.shadow.key);
    matches.push(
      Object.freeze({
        liveKey: candidate.live.key,
        shadowKey: candidate.shadow.key,
        intersection: candidate.intersection,
        union: candidate.union,
      }),
    );
  }

  matches.sort((a, b) => compareIds(a.liveKey, b.liveKey));
  return Object.freeze({
    matches: Object.freeze(matches),
    unmatchedLive: Object.freeze(
      live
        .map((event) => event.key)
        .filter((key) => !claimedLive.has(key))
        .sort(compareIds),
    ),
    unmatchedShadow: Object.freeze(
      shadow
        .map((event) => event.key)
        .filter((key) => !claimedShadow.has(key))
        .sort(compareIds),
    ),
  });
}

/** Descending Jaccard, then D7's tie-break on the live side, then the same on the shadow. */
function compareCandidates(a: Candidate, b: Candidate): number {
  const byJaccard = b.intersection * a.union - a.intersection * b.union;
  if (byJaccard !== 0) return byJaccard;
  return (
    a.live.startedAtMs - b.live.startedAtMs ||
    compareIds(a.live.key, b.live.key) ||
    a.shadow.startedAtMs - b.shadow.startedAtMs ||
    compareIds(a.shadow.key, b.shadow.key)
  );
}

function distinctUids(event: MatchableEvent): ReadonlySet<string> {
  const uids = new Set(event.detectionUids);
  if (uids.size !== event.detectionUids.length) {
    throw new RangeError(`event ${JSON.stringify(event.key)} lists a detection twice`);
  }
  return uids;
}

function assertDistinctKeys(events: readonly MatchableEvent[], side: string): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.key)) {
      throw new RangeError(`duplicate ${side} event key ${JSON.stringify(event.key)}`);
    }
    seen.add(event.key);
  }
}

/** Code-unit order, never `localeCompare`: the same bytes on every machine. */
export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
