/**
 * Where a digest goes and what it says (TASKS H2/D7), as the live digest pass needs it.
 *
 * The digest counterpart of `AlertRouting`, and unarmed for the same reasons: which
 * of an account's channels a digest is delivered on is H2's open question, and D7's
 * reviewed-template registry has no digest template. There is **no production
 * implementation**, so the digest loop's wiring stays disabled (`digest_routing_unarmed`)
 * rather than inventing a channel or a template id the never-send lint has never read.
 *
 * A digest is written as **one row per (account, zone that renders at least one line)**:
 * A1.12 renders each fire from the account's nearest zone, so the lines fall into groups
 * by zone, and each group is one message about one place. The row's A1.11 key names the
 * group's nearest fire as its carrier event; {@link DigestZoneGroup.entries} is the whole
 * group, which is what the copy binds.
 */

import type { DigestEntry } from '../alerts/digest.js';
import type { AlertCopy, AlertDeliveryTarget } from './alert-routing.js';

export interface DigestZoneGroup {
  readonly accountId: string;
  readonly zoneId: string;
  /** The window this digest answers: the A1.11 subkey's instant. */
  readonly windowStartIso: string;
  /** The zone's lines, nearest first (A1.12's order). Never empty. */
  readonly entries: readonly DigestEntry[];
}

export interface AlertDigestRouting {
  /**
   * The account's delivery target for its digest, or `null` when it has none. A `null`
   * target makes the whole digest undeliverable: the pass writes nothing and does not
   * spend the window, so the same window is offered again on the next tick.
   */
  targetFor(accountId: string): Promise<AlertDeliveryTarget | null>;
  /**
   * The reviewed copy for one zone's digest, or `null` when no reviewed template covers it
   * — that group is then dropped. Bound parameters only, never a rendered body (A1.3).
   */
  digestCopyFor(group: DigestZoneGroup): AlertCopy | null;
}
