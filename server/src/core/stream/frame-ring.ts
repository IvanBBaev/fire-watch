/**
 * The ring buffer behind `Last-Event-ID` (ADR-003 D1: "~1,000-frame ring buffer").
 *
 * It answers one question for a reconnecting client: *given the last frame id you saw,
 * can I give you everything since?* Three answers, and the boundary between them is the
 * whole design:
 *
 *   * **Replay.** The id is at or after the floor and at or before the newest frame: every
 *     frame with a greater id is still here, in order, and the client resumes without a
 *     snapshot. An id equal to the newest means nothing was missed — an empty replay.
 *   * **Reset, too old.** The id is below the floor: frames since it have been evicted (or
 *     were sent by a previous process — the buffer is memory, a restart empties it). The
 *     client must discard its store and fetch a snapshot (D3 rule 3).
 *   * **Reset, unknown.** The id is above the newest: no frame with it was ever sent by
 *     this registry. Either the client made it up or the database went backwards, and in
 *     both cases the client's state is not one the stream can extend.
 *
 * The **floor** is the highest id known to precede the buffer's contents: the registry's
 * max seq when the process seeded itself, then the id of whatever was evicted last. It
 * is *not* "the oldest id in the buffer minus one" — ids have holes (frames are only
 * kept for changes that reach the stream, and an event leaving the map does not), so a
 * client resuming from an id inside a hole must still be told it missed nothing, and
 * that is only known when the floor is tracked as its own number.
 *
 * Ids must arrive strictly increasing. A frame that does not is a bug upstream and is
 * refused loudly: silently accepting it would corrupt every replay from then on.
 */

import type { EventFrame } from './frames.js';

export interface FrameRingOptions {
  /** How many frames are kept. ADR-003 says about a thousand. */
  readonly capacity: number;
  /** The highest id that precedes everything the ring will ever hold — the seed's max seq. */
  readonly floor: number;
}

export type ReplayOutcome =
  | { readonly kind: 'replay'; readonly frames: readonly EventFrame[] }
  | { readonly kind: 'reset'; readonly reason: 'too_old' | 'unknown' };

export interface FrameRing {
  /** Appends a frame. Throws `RangeError` unless `frame.id` exceeds the newest id held. */
  push(frame: EventFrame): void;
  replayAfter(lastEventId: number): ReplayOutcome;
  /** The highest id held, or the floor when the ring is empty. */
  readonly latest: number;
  readonly floor: number;
  readonly size: number;
}

export function createFrameRing(options: FrameRingOptions): FrameRing {
  const { capacity } = options;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`ring capacity must be a positive integer, got ${String(capacity)}`);
  }
  if (!Number.isSafeInteger(options.floor) || options.floor < 0) {
    throw new RangeError(
      `ring floor must be a non-negative safe integer, got ${String(options.floor)}`,
    );
  }

  // A plain array with an index into it, rather than a circular buffer: the ring holds a
  // thousand frames and is read far more often than it is evicted from, so contiguity for
  // the replay slice is worth the occasional shift of the head.
  let frames: EventFrame[] = [];
  let head = 0;
  let floor = options.floor;

  const latest = (): number => {
    const last = frames.at(-1);
    return last === undefined ? floor : last.id;
  };

  return {
    push(frame: EventFrame): void {
      const newest = latest();
      if (!Number.isSafeInteger(frame.id) || frame.id <= newest) {
        throw new RangeError(
          `frame ids must increase: got ${String(frame.id)} after ${String(newest)}`,
        );
      }
      frames.push(frame);
      if (frames.length - head > capacity) {
        // The evicted frame's id becomes the floor: a client holding exactly it has seen
        // everything up to it and can still be replayed from the frames that remain.
        floor = frames[head]?.id ?? floor;
        head += 1;
        // Reclaim the dead prefix once it is as large as the live part, so the array's
        // size stays bounded by twice the capacity and each frame is copied at most once
        // per capacity-many pushes.
        if (head >= capacity) {
          frames = frames.slice(head);
          head = 0;
        }
      }
    },

    replayAfter(lastEventId: number): ReplayOutcome {
      if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
        return { kind: 'reset', reason: 'unknown' };
      }
      if (lastEventId > latest()) return { kind: 'reset', reason: 'unknown' };
      if (lastEventId < floor) return { kind: 'reset', reason: 'too_old' };
      const live = frames.slice(head);
      // Ids are strictly increasing, so the first frame above the cursor starts the tail.
      const start = live.findIndex((frame) => frame.id > lastEventId);
      return { kind: 'replay', frames: start === -1 ? [] : live.slice(start) };
    },

    get latest(): number {
      return latest();
    },
    get floor(): number {
      return floor;
    },
    get size(): number {
      return frames.length - head;
    },
  };
}
