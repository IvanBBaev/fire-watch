/**
 * Application-layer encryption of watch-zone centres, as a port (ADR-004 D8; 05 §5.3.2).
 *
 * 05 §5.3.2 asks for the centre to be encrypted with a service-held key — "not in the DB" —
 * so that SQL injection, a leaked backup, or a read replica in the wrong hands yields grid
 * cells, not homes. Disk encryption does not do that: it protects against a stolen disk,
 * and every one of those three attacks reads through it.
 *
 * A port and not a function because the core has no platform crypto
 * (`server-core-has-no-platform`), and because the key is a secret the core must never be
 * able to see: the adapter holds it, and nothing that crosses this boundary can carry it.
 *
 * ## The contract the adapter owes
 *
 *   - **Bound to the row.** `seal(zoneId, …)` authenticates the zone id as associated data,
 *     so a ciphertext copied onto another zone's row fails to open instead of silently
 *     relocating that zone — which, for an attacker with write access and no key, would be
 *     the cheapest way to move someone's alerts.
 *   - **Key id travels with the ciphertext.** Rotation is "new zones seal under the new
 *     key; old rows open under the key they name", so `open` must accept any key it still
 *     holds and `seal` must use exactly one.
 *   - **Fails closed, and quietly.** A ciphertext that does not open throws, and the error
 *     names neither the key nor the plaintext. A zone that cannot be read is a zone that
 *     cannot alert, which is an incident; a zone that opened to garbage and alerted on the
 *     wrong place is a worse one.
 */

import type { Coordinate } from '../clustering/geometry.js';

/** What is written to `watch_zones.centre_ciphertext` / `centre_key_id`. */
export interface SealedCentre {
  readonly ciphertext: Uint8Array;
  readonly keyId: string;
}

export interface ZoneCentreCipher {
  /** Encrypts the *stored* centre — already coarsened, when coarsening is on. */
  seal(zoneId: string, centre: Coordinate): SealedCentre;
  /** Throws when the key id is unknown or the ciphertext does not authenticate. */
  open(zoneId: string, sealed: SealedCentre): Coordinate;
}
