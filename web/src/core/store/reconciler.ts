/**
 * The reconciler — pure functions that fold feed messages into the client's event state
 * (ADR-003 D3, review 08 §5.2.4). No I/O, no clock, no framework: every function takes a
 * state and returns a state, and returns the *same object* when the message changed
 * nothing, so the store can detect no-ops by reference and skip notifying.
 *
 * The two authorities, kept deliberately separate:
 *
 * - **The full snapshot is the authority on the event *set*** (which events exist).
 *   Removals happen here and nowhere else — and only when the snapshot provably postdates
 *   the stored copy, or has said "absent" twice (rule 1, `applySnapshot`).
 * - **The per-event `seq` is the authority on each event's *version*** (which copy of an
 *   event is current). No code path ever replaces a stored event with a lower-seq copy.
 *
 * **The stale-create guard.** An id this client does not hold is created only when its
 * `seq` lies above the *settled floor* (`settledSeq`) — the seq through which this
 * client's knowledge of the set is contiguous. Every seq at or below the floor is either
 * an event it stored or a change that emitted no frame: an event leaving the map bumps the
 * global seq silently (E2). So an unknown id at or below the floor can only come from a
 * stale copy — a CDN-cached snapshot older than deltas already applied, or a replayed
 * frame — and creating it would resurrect a removed event (a zombie). The floor equals
 * `maxSeq` in the steady state and lags it only while a seq gap is outstanding: a delta
 * that lands past `maxSeq + 1` moves `maxSeq` (it is real evidence of the global sequence)
 * but not the floor, because the skipped seqs may hold creates this client never saw and
 * the forced full snapshot must still be able to create them. A full snapshot re-settles
 * the floor to its `maxSeq`; a stream `freshness` mark above `maxSeq` moves neither, for
 * the same reason — the mark names a change this client has no evidence of.
 *
 * **No explicit buffering.** D3 rule 3 says "buffer incoming deltas and apply them after
 * the snapshot lands". This reconciler applies them immediately instead, which is
 * equivalent: a delta upsert is version-guarded, a full snapshot removes an absent id only
 * when `snapshot.maxSeq > stored.seq`, and the stale-create guard blocks resurrection — so
 * a delta applied before the snapshot and the same delta applied after it leave the same
 * `events` and `maxSeq`. The property suite proves it (`reconciler.property.test.ts`).
 *
 * **Tombstones** (`mergedInto` set) stay resident so permalinks keep resolving (ADR-002
 * I1). Their absence from a full snapshot is never information — a snapshot need not carry
 * merged rows — so no snapshot removes one; they leave only through `expireTombstones`,
 * {@link TOMBSTONE_TTL_MS} after the server instant the carrying frame was stamped with
 * (D3 rule 2, measured in server time per A1.6, never by a clock of the reconciler's own).
 */

import type { FireEvent, Snapshot, SnapshotSourceRow } from '../types.js';

/** How long a merged-away event stays resident after the merge (ADR-003 D3 rule 2). */
export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The reconciled state. `events`, `maxSeq`, `lastSnapshotAt`, `needsSnapshot` and `sources`
 * are the fields {@link import('../types.js').StoreState} exposes; the rest is bookkeeping the
 * store keeps private — it changes without anyone needing to re-render.
 */
export interface ReconcilerState {
  /** Keyed by the public id `id` (`fw-<year>-<base32>`) — the one identifier on the wire. */
  readonly events: ReadonlyMap<string, FireEvent>;
  /** Highest global sequence number this client has seen evidence of — the feed cursor. */
  readonly maxSeq: number;
  /**
   * The stale-create floor: the seq through which this client's knowledge of the set is
   * contiguous. Equal to `maxSeq` unless a gap is outstanding (see the module comment).
   */
  readonly settledSeq: number;
  /**
   * `generatedAt` of the newest applied *full* snapshot, or of a confirmation of it —
   * the staleness anchor. Partials never move it, and it never moves backwards.
   */
  readonly lastSnapshotAt: string | null;
  /** Raised on a detected seq gap, a reset, or a stream mark past `maxSeq`; only a full
   *  snapshot (or an explicit acknowledgement from the feed layer) lowers it. */
  readonly needsSnapshot: boolean;
  /**
   * id → `maxSeq` of the full snapshot that first noted this stored event absent
   * without being able to remove it (rule 1: "two consecutive authoritative absences").
   * Cleared by any applied copy of the event and by its removal.
   */
  readonly absences: ReadonlyMap<string, number>;
  /**
   * id → server epoch ms at which the event was merged away, taken from the carrying
   * message's `generatedAt`. A tombstone without an entry never expires.
   */
  readonly tombstonedAt: ReadonlyMap<string, number>;
  /**
   * Per-source observation recency (TASKS F4): the newest `lastObservedAt` any snapshot
   * or stream `freshness` frame has carried for each source, in first-seen order. Exposed
   * on `StoreState`; see {@link mergeSourceRows} for the merge rule.
   */
  readonly sources: readonly SnapshotSourceRow[];
}

/**
 * The pre-boot state. `needsSnapshot` starts lowered on purpose: the supervisor's first
 * act is always a snapshot fetch (review 08 §5.2.3 "boot: always snapshot first"), so
 * raising the flag here would only demand a second fetch of the same thing. `applyReset`
 * raises it, because a reset arrives mid-session where nothing else forces a refetch.
 */
export function createInitialReconcilerState(): ReconcilerState {
  return {
    events: new Map(),
    maxSeq: 0,
    settledSeq: 0,
    lastSnapshotAt: null,
    needsSnapshot: false,
    absences: new Map(),
    tombstonedAt: new Map(),
    sources: [],
  };
}

/**
 * Apply a parsed snapshot.
 *
 * **Full (`partial: false`) — SET authority.** Each carried event upserts under the
 * version guard (a CDN-cached snapshot can be up to its TTL older than deltas already
 * applied, so a fresher stored copy is kept — membership is authoritative, versions never
 * regress, 08 §5.2.4 rule 1); unknown ids pass the stale-create guard. Each stored event
 * the snapshot omits is removed when `snapshot.maxSeq > stored.seq` — the snapshot
 * postdates the copy, so the copy's absence is proof. When it does not, the snapshot may
 * simply predate the stored version, so the absence is only *noted*, and a later snapshot
 * with a higher `maxSeq` that still omits the event removes it: two consecutive
 * authoritative absences. The strict comparison keeps re-applying the same snapshot a
 * no-op, and any applied copy of the event in between clears the note (an event a delta
 * just updated is evidently not gone). Tombstones are never removed here. A full snapshot
 * also re-settles the floor, advances the staleness anchor when it is newer, and lowers
 * `needsSnapshot`.
 *
 * **Partial (`partial: true`) — an upsert-only batch.** The cursor variant
 * (`?updated_after_seq=N`) is a bandwidth optimization on the *version* axis only and is
 * never authoritative for removals (ADR-003 A1.5, fixture S15): the same upsert and
 * stale-create guards apply, nothing is removed, absences are neither noted nor cleared
 * by omission, `lastSnapshotAt` does not move, and `needsSnapshot` is not lowered — only
 * a full snapshot proves the set. It does settle the floor when no gap is outstanding: a
 * cursor response carries every change since the cursor, creates included.
 *
 * Both kinds advance `maxSeq := max(state.maxSeq, snapshot.maxSeq)`.
 */
export function applySnapshot(state: ReconcilerState, snapshot: Snapshot): ReconcilerState {
  return snapshot.partial
    ? applyPartialSnapshot(state, snapshot)
    : applyFullSnapshot(state, snapshot);
}

function applyFullSnapshot(state: ReconcilerState, snapshot: Snapshot): ReconcilerState {
  const drafts = draftsOf(state);
  const instantMs = parseInstant(snapshot.generatedAt);

  const carried = new Set<string>();
  for (const incoming of snapshot.events) {
    carried.add(incoming.id);
    applyEvent(state, drafts, incoming, instantMs);
    // Carried at all — even as a copy too old to apply — is a sighting: the absences
    // rule counts *consecutive* misses, and this one breaks the run.
    drafts.absences.delete(incoming.id);
  }

  for (const [id, stored] of state.events) {
    if (carried.has(id)) continue;
    if (stored.mergedInto !== null) continue;
    const noted = state.absences.get(id);
    const proven = snapshot.maxSeq > stored.seq || (noted !== undefined && snapshot.maxSeq > noted);
    if (proven) {
      drafts.events.delete(id);
      drafts.absences.delete(id);
      drafts.tombstonedAt.delete(id);
    } else if (noted === undefined) {
      drafts.absences.set(id, snapshot.maxSeq);
    }
  }

  return settle(state, {
    events: drafts.events.result(),
    maxSeq: Math.max(state.maxSeq, snapshot.maxSeq),
    settledSeq: Math.max(state.settledSeq, snapshot.maxSeq),
    lastSnapshotAt: isNewerInstant(snapshot.generatedAt, state.lastSnapshotAt)
      ? snapshot.generatedAt
      : state.lastSnapshotAt,
    needsSnapshot: false,
    absences: drafts.absences.result(),
    tombstonedAt: drafts.tombstonedAt.result(),
    sources: mergeSourceRows(state.sources, snapshot.sources),
  });
}

function applyPartialSnapshot(state: ReconcilerState, snapshot: Snapshot): ReconcilerState {
  const drafts = draftsOf(state);
  const instantMs = parseInstant(snapshot.generatedAt);
  for (const incoming of snapshot.events) {
    applyEvent(state, drafts, incoming, instantMs);
  }
  const maxSeq = Math.max(state.maxSeq, snapshot.maxSeq);
  return settle(state, {
    ...state,
    events: drafts.events.result(),
    maxSeq,
    settledSeq: state.settledSeq === state.maxSeq ? maxSeq : state.settledSeq,
    absences: drafts.absences.result(),
    tombstonedAt: drafts.tombstonedAt.result(),
    sources: mergeSourceRows(state.sources, snapshot.sources),
  });
}

/**
 * Apply a delta batch — per-event VERSION authority, never SET authority.
 *
 * Each event upserts iff it is known and `incoming.seq > stored.seq`, or unknown and above
 * the stale-create floor; a stale or replayed frame is a no-op (idempotent under SSE
 * replay, 08 §5.2.4 rule 2) and a delta never deletes (rule 4). `maxSeq` advances to the
 * highest incoming seq, since a seq on any event is evidence the global sequence reached
 * it. `generatedAt` is the carrying frame's server instant: it dates every tombstone the
 * batch applies for the 24 h age-out, and a batch without one leaves those tombstones
 * undated (they then never expire — a resident tombstone is the safe failure).
 *
 * **Gap detection.** With `newSeqs` = the incoming seqs strictly greater than
 * `state.maxSeq`: if `min(newSeqs) > state.maxSeq + 1`, a change this client never saw
 * exists between them, so `needsSnapshot` is raised and the feed layer must force a full
 * snapshot fetch (rule 3); SSE delivers one frame at a time, so a single frame past
 * `maxSeq + 1` is enough. This leans on an assumption that holds for the fixture feed and
 * is documented here because the real wire delta contract is Track E, NOT BUILT: the
 * global seq increments by 1 per event change, and a delta batch carries all changes
 * since the client's cursor — so a skipped seq can only mean a missed change. Deltas keep
 * applying normally while the flag is up: upserts are seq-guarded and therefore always
 * safe, and the eventual full snapshot settles the set (the module comment on why no
 * buffering is needed).
 */
export function applyDelta(
  state: ReconcilerState,
  incoming: readonly FireEvent[],
  generatedAt?: string,
): ReconcilerState {
  const drafts = draftsOf(state);
  const instantMs = generatedAt === undefined ? null : parseInstant(generatedAt);

  let maxSeq = state.maxSeq;
  let minNewSeq = Number.POSITIVE_INFINITY;
  for (const event of incoming) {
    applyEvent(state, drafts, event, instantMs);
    if (event.seq > state.maxSeq) {
      if (event.seq < minNewSeq) minNewSeq = event.seq;
      if (event.seq > maxSeq) maxSeq = event.seq;
    }
  }
  const gapDetected = Number.isFinite(minNewSeq) && minNewSeq > state.maxSeq + 1;

  return settle(state, {
    ...state,
    events: drafts.events.result(),
    maxSeq,
    settledSeq: state.settledSeq === state.maxSeq && !gapDetected ? maxSeq : state.settledSeq,
    needsSnapshot: state.needsSnapshot || gapDetected,
    absences: drafts.absences.result(),
    tombstonedAt: drafts.tombstonedAt.result(),
  });
}

/**
 * A server `reset` frame: this client's cursor is void and a full snapshot must be fetched
 * before the stream is trustworthy again (ADR-003 D3 rule 3). Only the demand is raised —
 * the events stay. Blanking the map between the reset and the refetch is exactly the
 * flicker the ADR forbids, and nothing here is *wrong*, merely possibly incomplete: the
 * full snapshot that follows reconciles the set through rule 1, removals included.
 */
export function applyReset(state: ReconcilerState): ReconcilerState {
  return state.needsSnapshot ? state : { ...state, needsSnapshot: true };
}

/**
 * The stream's periodic `freshness` frame: the registry's high-water mark. A mark past
 * `maxSeq` names a change this client has no evidence of — typically an event leaving the
 * map, which emits no frame (E2) — so a full snapshot is demanded; neither `maxSeq` nor
 * the floor moves, because the change is not known, only known to exist, and the
 * snapshot must still be able to create whatever lies between the floor and the mark. A
 * mark at or below `maxSeq` says the set is current as of `generatedAt`: a confirmation.
 *
 * The frame's per-source rows merge into `sources` either way (TASKS F4): a source's
 * last observation is a fact about the pipeline, not about this client's copy of the set,
 * so an owed snapshot does not make it less true. Omitted `sources` leaves them alone.
 */
export function applyStreamFreshness(
  state: ReconcilerState,
  maxSeq: number,
  generatedAt: string,
  sources: readonly SnapshotSourceRow[] = [],
): ReconcilerState {
  const next = maxSeq > state.maxSeq ? applyReset(state) : applyConfirmation(state, generatedAt);
  const merged = mergeSourceRows(next.sources, sources);
  return merged === next.sources ? next : { ...next, sources: merged };
}

/**
 * Merge carried per-source rows into the known ones (TASKS F4) — newer wins, per source.
 *
 * - A row for an unknown source is appended (first-seen order, so the array is stable).
 * - A known source moves only to a strictly newer, parseable instant. A CDN-cached
 *   snapshot can be up to its TTL older than a stream frame already applied, and letting
 *   it pull a source's recency backwards would make a live source look stale.
 * - `null` ("never observed") never replaces a known instant, for the same reason.
 * - A source the carrier omits is kept, with its last known instant: absence from one
 *   message is not evidence the source recovered, and a source that stops being reported
 *   should age into staleness rather than silently vanish.
 *
 * Returns `current` itself when nothing moved, so the reconciler's no-op contract holds.
 */
export function mergeSourceRows(
  current: readonly SnapshotSourceRow[],
  incoming: readonly SnapshotSourceRow[],
): readonly SnapshotSourceRow[] {
  let next: SnapshotSourceRow[] | null = null;
  for (const row of incoming) {
    const rows: readonly SnapshotSourceRow[] = next ?? current;
    const index = rows.findIndex((known) => known.sourceId === row.sourceId);
    if (index === -1) {
      next = [...rows, { sourceId: row.sourceId, lastObservedAt: row.lastObservedAt }];
      continue;
    }
    const known = rows[index];
    if (known === undefined || row.lastObservedAt === null) continue;
    if (Number.isNaN(Date.parse(row.lastObservedAt))) continue;
    if (!isNewerInstant(row.lastObservedAt, known.lastObservedAt)) continue;
    const copy = [...rows];
    copy[index] = { sourceId: row.sourceId, lastObservedAt: row.lastObservedAt };
    next = copy;
  }
  return next ?? current;
}

/**
 * The origin confirmed the stored set as of `generatedAt` without transferring a body — a
 * full-snapshot request answered `304 Not Modified`, or a caught-up stream mark. The
 * staleness anchor advances iff there is an anchor to advance (a confirmation of nothing
 * is nothing), no snapshot is owed (an owed snapshot means the set is *not* confirmed),
 * and the instant is strictly newer. Never regresses.
 */
export function applyConfirmation(state: ReconcilerState, generatedAt: string): ReconcilerState {
  if (state.lastSnapshotAt === null || state.needsSnapshot) return state;
  if (!isNewerInstant(generatedAt, state.lastSnapshotAt)) return state;
  return { ...state, lastSnapshotAt: generatedAt };
}

/**
 * Age out tombstones (ADR-003 D3 rule 2): every merged-away event whose recorded merge
 * instant is {@link TOMBSTONE_TTL_MS} or more before `serverNowMs` leaves the store, with
 * its bookkeeping. `serverNowMs` is server time (A1.6) — the store passes `serverNow()` —
 * so a device clock hours off can neither hold a tombstone forever nor expire it early.
 */
export function expireTombstones(state: ReconcilerState, serverNowMs: number): ReconcilerState {
  const drafts = draftsOf(state);
  for (const [id, mergedAtMs] of state.tombstonedAt) {
    if (mergedAtMs + TOMBSTONE_TTL_MS > serverNowMs) continue;
    // An entry can only belong to a resident tombstone (applying an active copy clears it,
    // and snapshots never remove tombstones); the check is belt-and-braces.
    const stored = state.events.get(id);
    if (stored !== undefined && stored.mergedInto !== null) drafts.events.delete(id);
    drafts.tombstonedAt.delete(id);
    drafts.absences.delete(id);
  }
  return settle(state, {
    ...state,
    events: drafts.events.result(),
    absences: drafts.absences.result(),
    tombstonedAt: drafts.tombstonedAt.result(),
  });
}

/**
 * Copy-on-write view over one of the state's maps: reads go to the source until the first
 * effective write clones it, so a message that changes nothing hands back the very same
 * map and the no-op contract falls out of reference equality.
 */
class Draft<V> {
  private copy: Map<string, V> | null = null;

  constructor(private readonly source: ReadonlyMap<string, V>) {}

  get(key: string): V | undefined {
    return (this.copy ?? this.source).get(key);
  }

  set(key: string, value: V): void {
    if ((this.copy ?? this.source).get(key) === value) return;
    this.copy ??= new Map(this.source);
    this.copy.set(key, value);
  }

  delete(key: string): void {
    if (!(this.copy ?? this.source).has(key)) return;
    this.copy ??= new Map(this.source);
    this.copy.delete(key);
  }

  result(): ReadonlyMap<string, V> {
    return this.copy ?? this.source;
  }
}

interface Drafts {
  readonly events: Draft<FireEvent>;
  readonly absences: Draft<number>;
  readonly tombstonedAt: Draft<number>;
}

function draftsOf(state: ReconcilerState): Drafts {
  return {
    events: new Draft(state.events),
    absences: new Draft(state.absences),
    tombstonedAt: new Draft(state.tombstonedAt),
  };
}

/**
 * The one write path for an event copy, shared by every message kind. A known id is
 * replaced only by a strictly newer seq: an equal seq is the same version by construction
 * (the seq *is* the per-event version, ADR-003 A1.4/R1), so the stored object is kept —
 * same state, stabler references. An unknown id must clear the stale-create `floor`, and
 * so must a copy that turns a resident tombstone back into an active event: the tombstone
 * sat outside set reconciliation (no snapshot can remove one), so for the set it is as
 * good as unknown, and a late un-merge frame for an event the server has since removed
 * would otherwise resurrect it past a snapshot that already proved it gone. That
 * classification reads the *pre-message* state, while the version test reads the draft:
 * each copy then passes or fails the floor on its own, independent of its neighbours, and
 * the highest passing seq wins — so a (contract-violating) duplicate id in one batch
 * resolves the same way regardless of array order. (Classifying against the draft would
 * let an earlier tombstone copy in the same batch turn a later, higher-seq active copy
 * into a "create" and drop it under the floor.) An applied copy is evidence the event
 * exists, so it clears any noted absence; and it re-dates the tombstone from the carrying
 * message's instant, or leaves it undated when that is unknown or the copy is active — an
 * event can be un-merged and merged again, and a date never outlives the version it
 * dated.
 */
function applyEvent(
  state: ReconcilerState,
  drafts: Drafts,
  incoming: FireEvent,
  instantMs: number | null,
): void {
  const stored = drafts.events.get(incoming.id);
  if (stored !== undefined && incoming.seq <= stored.seq) return;
  const before = state.events.get(incoming.id);
  const creates =
    before === undefined || (before.mergedInto !== null && incoming.mergedInto === null);
  if (creates && incoming.seq <= state.settledSeq) return;
  drafts.events.set(incoming.id, incoming);
  drafts.absences.delete(incoming.id);
  if (incoming.mergedInto !== null && instantMs !== null) {
    drafts.tombstonedAt.set(incoming.id, instantMs);
  } else {
    drafts.tombstonedAt.delete(incoming.id);
  }
}

const STATE_KEYS = [
  'events',
  'maxSeq',
  'settledSeq',
  'lastSnapshotAt',
  'needsSnapshot',
  'absences',
  'tombstonedAt',
  'sources',
] as const satisfies readonly (keyof ReconcilerState)[];

/** The no-op contract in one place: the input object comes back when no field moved. */
function settle(state: ReconcilerState, next: ReconcilerState): ReconcilerState {
  return STATE_KEYS.every((key) => next[key] === state[key]) ? state : next;
}

/**
 * Timestamps are ISO-8601 UTC by contract, but with and without fractional seconds they
 * do not compare lexicographically, so parse. Malformed input (the feed adapter guards
 * the wire; this is belt-and-braces) is "not newer": the anchor never moves on garbage.
 */
function isNewerInstant(candidate: string, anchor: string | null): boolean {
  if (anchor === null) return true;
  return Date.parse(candidate) > Date.parse(anchor);
}

function parseInstant(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
