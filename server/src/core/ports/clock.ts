/**
 * The clock is a port, not an ambient capability.
 *
 * Every lifecycle decision in this system is a function of elapsed time — the 72 h
 * active window, T_LINK, reignition fuel windows, the E-accumulator's diurnal phases,
 * alert suppression, quiet hours. If any of that code reads the wall clock directly it
 * becomes untestable and non-replayable: a fixture would pass in September and fail in
 * October. `Date.now()` and `new Date()` are therefore banned outside adapters, and the
 * ban is enforced by lint rather than by discipline.
 */

/** Milliseconds since the Unix epoch, UTC. The only time primitive the core sees. */
export type EpochMs = number;

export interface Clock {
  now(): EpochMs;
}

/**
 * A clock the test drives. Time never moves on its own: a fixture that needs six hours
 * to pass says so, which is also the only way a replay can be byte-identical.
 */
export class VirtualClock implements Clock {
  #now: EpochMs;

  constructor(start: EpochMs | string) {
    this.#now = typeof start === 'string' ? epochMsFromIso(start) : start;
  }

  now(): EpochMs {
    return this.#now;
  }

  advanceMs(delta: number): EpochMs {
    if (!Number.isFinite(delta) || delta < 0) {
      throw new RangeError(`a clock only moves forward, got ${String(delta)} ms`);
    }
    this.#now += delta;
    return this.#now;
  }

  advanceMinutes(minutes: number): EpochMs {
    return this.advanceMs(minutes * 60_000);
  }

  advanceHours(hours: number): EpochMs {
    return this.advanceMs(hours * 3_600_000);
  }

  set(instant: EpochMs | string): EpochMs {
    const next = typeof instant === 'string' ? epochMsFromIso(instant) : instant;
    if (next < this.#now) {
      throw new RangeError('a clock only moves forward');
    }
    this.#now = next;
    return this.#now;
  }
}

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

/**
 * Parses a UTC instant. The `Z` is mandatory: a naive timestamp would be read in the
 * host's zone, which is how a fixture starts passing or failing depending on where CI
 * runs — and how a DST transition (S14) turns into a silent one-hour offset.
 */
export function epochMsFromIso(iso: string): EpochMs {
  if (!ISO_UTC_RE.test(iso)) {
    throw new RangeError(`instant must be an explicit UTC ISO string, got ${JSON.stringify(iso)}`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`unparseable instant ${JSON.stringify(iso)}`);
  }
  return ms;
}

/**
 * The inverse, used when a determinism artifact has to be readable by a human — a
 * checked-in `expected.json` full of epoch integers is reviewable only by a machine, and
 * a fixture nobody can read is a fixture nobody notices is wrong.
 */
export function isoFromEpochMs(ms: EpochMs): string {
  if (!Number.isFinite(ms)) {
    throw new RangeError(`instant must be a finite epoch millisecond, got ${String(ms)}`);
  }
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}
