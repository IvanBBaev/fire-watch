/**
 * The pump: what turns database changes into stream frames (ADR-003 D1 T0, D2).
 *
 * ## Shape
 *
 * The pump is a cursor over `fire_events.seq`. Each tick reads the rows past the cursor,
 * projects them into frames, pushes the frames through the ring (so late clients can
 * replay them) and broadcasts them to every open connection. It is driven from the outside
 * — the app layer owns the interval — so core keeps no timer and every test runs it by hand.
 *
 * ## Seeding
 *
 * The first successful tick reads the whole active set once. That read gives the three
 * things a stream cannot start without: the cursor (the registry's max seq — everything
 * before it is what a snapshot contains, not what the stream owes), the set of events the
 * stream believes are on the map (so the next change to one of them is an `updated`, not a
 * `created`), and the ring's floor. Until the seed lands the pump is not ready and the
 * route answers 503 with a short `Retry-After`; nothing is served from a half-initialised
 * process.
 *
 * ## Freshness
 *
 * A `freshness` frame goes out whenever the registry moved and at least every
 * `freshnessIntervalMs` regardless — the client's "is this thing alive and how stale is
 * each source" signal (D2). The last one is cached so a connecting client is told the
 * state of the world immediately, without a database round trip per connect: five
 * thousand reconnects after a deploy must not become five thousand queries.
 *
 * ## Failure
 *
 * A tick that throws leaves the cursor where it was; the caller logs it (redacted) and the
 * next tick retries from the same place. Frames already broadcast before the failure were
 * also already pushed into the ring, so a client that saw them replays correctly.
 *
 * ## What the stream does not do
 *
 * It never tells a client to *remove* an event (D3 rule 5). An event leaving the map is a
 * skipped `seq`; the client notices the hole and fetches a snapshot. And the 10-minute
 * safety snapshot (D3) is the client supervisor's rule, not the server's — the server only
 * keeps the `freshness` frames honest.
 */

import type { ChangeReader } from '../ports/change-reader.js';
import type { Clock, EpochMs } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { SnapshotReader } from '../ports/snapshot-reader.js';
import { snapshotSource } from '../snapshot/snapshot-builder.js';
import { type KnownEvents, projectChanges, seedKnown } from './change-projector.js';
import { type FrameRing, type ReplayOutcome, createFrameRing } from './frame-ring.js';
import { type ControlFrame, encodeFrame } from './frames.js';
import type { StreamHub } from './stream-hub.js';

export interface StreamPumpOptions {
  readonly snapshotReader: SnapshotReader;
  readonly changeReader: ChangeReader;
  readonly hub: Pick<StreamHub, 'broadcast'>;
  readonly clock: Clock;
  /** The sources reported in every `freshness` frame, in this order. */
  readonly sources: readonly string[];
  readonly ringCapacity: number;
  /** Rows per change read. A tick keeps reading while batches come back full. */
  readonly batchLimit: number;
  /** How many full batches one tick may drain before yielding to the next. */
  readonly maxBatchesPerTick: number;
  readonly freshnessIntervalMs: number;
}

export interface StreamPump {
  /** One pass. Resolves when it is done; rejects with the first failure. Never overlaps. */
  tick(): Promise<void>;
  /** True once the seed read has landed; the route refuses connections until then. */
  ready(): boolean;
  /** `Last-Event-ID` resolution. Only meaningful when `ready()`. */
  replayAfter(lastEventId: number): ReplayOutcome;
  /** The most recent `freshness` frame, or null before the first one was built. */
  freshness(): ControlFrame | null;
}

interface Seeded {
  readonly ring: FrameRing;
  known: KnownEvents;
  cursor: number;
  /** The registry's high-water mark as of the last read — what `freshness` reports. */
  maxSeq: number;
}

export function createStreamPump(options: StreamPumpOptions): StreamPump {
  const {
    snapshotReader,
    changeReader,
    hub,
    clock,
    sources,
    ringCapacity,
    batchLimit,
    maxBatchesPerTick,
    freshnessIntervalMs,
  } = options;
  if (!Number.isInteger(batchLimit) || batchLimit < 1) {
    throw new RangeError('batchLimit must be a positive integer');
  }
  if (!Number.isInteger(maxBatchesPerTick) || maxBatchesPerTick < 1) {
    throw new RangeError('maxBatchesPerTick must be a positive integer');
  }

  let seeded: Seeded | undefined;
  let freshness: ControlFrame | null = null;
  let freshnessAt: EpochMs | undefined;
  let inFlight: Promise<void> | undefined;

  const seed = async (): Promise<Seeded> => {
    const read = await snapshotReader.readActiveSet(0);
    return {
      ring: createFrameRing({ capacity: ringCapacity, floor: read.maxSeq }),
      known: seedKnown(read),
      cursor: read.maxSeq,
      maxSeq: read.maxSeq,
    };
  };

  /** Reads and fans out what moved since the cursor. Returns whether anything did. */
  const pump = async (state: Seeded): Promise<boolean> => {
    let moved = false;
    for (let batch = 0; batch < maxBatchesPerTick; batch += 1) {
      const read = await changeReader.readChangesSince(state.cursor, batchLimit);
      state.maxSeq = Math.max(state.maxSeq, read.maxSeq);
      const last = read.rows.at(-1);
      if (last === undefined) break;
      moved = true;
      const projection = projectChanges(state.known, read.rows, clock.now());
      for (const frame of projection.frames) {
        state.ring.push(frame);
        hub.broadcast(encodeFrame(frame));
      }
      state.known = projection.known;
      state.cursor = last.seq;
      if (read.rows.length < batchLimit) break;
    }
    return moved;
  };

  const refreshFreshness = async (state: Seeded): Promise<void> => {
    const observations = await snapshotReader.readSourceObservations(sources);
    const now = clock.now();
    freshness = {
      event: 'freshness',
      data: {
        generated_at: isoFromEpochMs(now),
        max_seq: state.maxSeq,
        sources: observations.map(snapshotSource),
      },
    };
    freshnessAt = now;
    hub.broadcast(encodeFrame(freshness));
  };

  const run = async (): Promise<void> => {
    seeded ??= await seed();
    const state = seeded;
    const moved = await pump(state);
    const due = freshnessAt === undefined || clock.now() - freshnessAt >= freshnessIntervalMs;
    if (moved || due) await refreshFreshness(state);
  };

  return {
    tick(): Promise<void> {
      // A slow database must not stack ticks: a second call while one is in flight joins
      // it rather than starting another read over the same cursor.
      inFlight ??= run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    ready(): boolean {
      return seeded !== undefined;
    },
    replayAfter(lastEventId: number): ReplayOutcome {
      if (seeded === undefined) return { kind: 'reset', reason: 'too_old' };
      return seeded.ring.replayAfter(lastEventId);
    },
    freshness(): ControlFrame | null {
      return freshness;
    },
  };
}
