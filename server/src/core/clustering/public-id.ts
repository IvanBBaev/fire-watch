/**
 * `fw-YYYY-xxxxx` — the id a human is given (ADR-002 D1, Amendment A2.1).
 *
 * Three properties, in the order they constrain the implementation:
 *
 *   1. **Permanent (I1).** The id is minted once, when the cluster is created, and stored.
 *      Nothing ever re-derives it: a later revision of the geometry or of `acq_ts` must
 *      not be able to change an id that has been sent to a subscriber. That is why the id
 *      is derived from the *seeding detection's* uid, which is frozen at ingest, and why
 *      the minted value is a field of the event rather than a function of it.
 *   2. **Deterministic (I5).** A replay of the same batch mints the same id, so a golden
 *      fixture can assert one. `Math.random()` is banned in the core, but the deeper
 *      reason is CI-2: a random id is a byte-diff failure by construction.
 *   3. **Cosmetic year (A2.1).** `YYYY` is the *mint* year. An event that starts on 31
 *      December and is still burning in January keeps its id; the year is never parsed,
 *      never corrected, and a display that needs the fire's year reads `started_at`.
 *
 * The alphabet is Crockford base32 in lowercase — no `i`, `l`, `o` or `u` — so an id read
 * off a screen and typed into a search box survives the usual confusions, and the DB
 * CHECK `^fw-[0-9]{4}-[0-9a-z]{5}$` accepts exactly what this mints.
 */

import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';

export const PUBLIC_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** The same shape migration 001 enforces. Duplicated deliberately: a mint that drifts from the CHECK fails at insert time, and this regex makes it fail in a unit test instead. */
export const PUBLIC_ID_RE = /^fw-[0-9]{4}-[0-9a-z]{5}$/;

/** 32⁵ — the suffix space. */
const SUFFIX_BITS = 25;
const SUFFIX_MASK = (1 << SUFFIX_BITS) - 1;

/**
 * How many times minting will re-probe before giving up. The suffix space is 33.5 M and a
 * season produces thousands of events, so a first-probe collision is already rare and a
 * hundredth is not reachable in practice — the cap exists so that a corrupted taken-set
 * fails loudly instead of spinning.
 */
const MAX_PROBES = 128;

export interface MintPublicIdInput {
  /**
   * The stable seed. The engine passes the `detection_uid` of the detection that seeded
   * the cluster: it is unique per row, frozen at ingest, and already the identity of the
   * observation this event exists because of.
   */
  readonly seed: string;
  /** Mint instant, from the clock port. Only its UTC year is used, and only cosmetically. */
  readonly mintedAt: EpochMs;
  /** Ids already in use. Probing is what keeps a hash collision from becoming a duplicate. */
  readonly isTaken: (candidate: string) => boolean;
}

export function mintPublicId(input: MintPublicIdInput): string {
  if (input.seed.length === 0) {
    throw new RangeError('public id needs a non-empty seed');
  }
  const year = isoFromEpochMs(input.mintedAt).slice(0, 4);
  for (let probe = 0; probe < MAX_PROBES; probe += 1) {
    const candidate = `fw-${year}-${suffix(input.seed, probe)}`;
    if (!input.isTaken(candidate)) {
      if (!PUBLIC_ID_RE.test(candidate)) {
        throw new Error(`minted a public id that violates the schema CHECK: ${candidate}`);
      }
      return candidate;
    }
  }
  throw new Error(
    `could not mint a free public id for seed ${input.seed} after ${String(MAX_PROBES)} probes`,
  );
}

function suffix(seed: string, probe: number): string {
  const value = fnv1a32(`${seed}#${String(probe)}`) & SUFFIX_MASK;
  let out = '';
  for (let position = SUFFIX_BITS - 5; position >= 0; position -= 5) {
    out += PUBLIC_ID_ALPHABET[(value >>> position) & 31];
  }
  return out;
}

/**
 * FNV-1a, 32-bit. A private copy rather than a call to `configDigest`, and the duplication
 * is the point: this derivation is frozen forever because published ids and checked-in
 * fixtures depend on it, while a config digest is free to be re-tuned the day someone
 * wants a wider hash. Sharing the function would let that day silently re-mint every
 * future id.
 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
