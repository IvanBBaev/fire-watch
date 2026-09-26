/**
 * Wiring for the live digest pass (TASKS H3/D9; ADR-004 D1, D3, A1.7, A1.8, A1.11, A1.12;
 * migration 018): the loop that, once per tick and per account, decides whether the
 * account's 09:00 digest window is due and writes what it resolved to — the
 * `alert_digest_log` rows that are the watermark and, for a `send`, the outbox rows — in
 * one transaction per account (`core/alerts/digest-pass.ts`).
 *
 * ## Disabled, with reasons, until every blocker is gone
 *
 * Same contract as `alert-evaluation-wiring.ts`: either `enabled: true` with the cycle's
 * dependencies, or `enabled: false` with the blockers — and never a throw for a blocker, so
 * a worker without zone keys keeps ingesting. The blockers:
 *
 *   - `zone_keyring_unset` — no `FIRE_WATCH_ZONE_KEY_ID`/`FIRE_WATCH_ZONE_KEY`: no zone
 *     centre can be opened, so no pair's distance is known and A1.12's nearest-zone fold
 *     cannot run. (A *malformed* keyring is still a `ConfigError`.)
 *   - `digest_routing_unarmed` — no {@link AlertDigestRouting}: which channel a digest goes
 *     out on (H2) and the reviewed digest template (D7) are founder decisions with no
 *     production implementation. Running without one would decide every due window
 *     `undeliverable`, which writes nothing and re-offers the window on every tick — a
 *     loop that works hard to do nothing.
 *   - `cadence_unratified` — {@link ALERT_DIGEST_CADENCE} is null: no tick interval or
 *     account page size has been ratified, and none is invented here. The interval bounds
 *     how late after 09:00 a digest is written (and how late after quiet hours end a held
 *     one is); the page size bounds one listing query, not a transaction.
 *
 * ## Its own pool
 *
 * Two connections, created only when enabled: the account listing and one account's
 * transaction never overlap, and neither may take a connection from the FIRMS poll or the
 * evaluation loop.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createAesGcmZoneCipher } from '../adapters/crypto/aes-gcm-zone-cipher.js';
import { createPgAlertDigestStore } from '../adapters/db/pg-alert-digest-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import type { AlertDigestCycleDeps } from '../core/alerts/digest-pass.js';
import type { AlertDigestRouting } from '../core/ports/alert-digest-routing.js';
import type { Environment, ServerConfig } from './config.js';
import { loadZonesConfig } from './zones-config.js';

export interface AlertDigestCadence {
  readonly intervalMs: number | null;
  readonly accountPageSize: number | null;
}

/**
 * **Unratified — deliberately null.** No spec fixes how often the pass ticks or how many
 * accounts one listing reads. The interval is a product number (a digest written at 09:14
 * is a 09:00 digest fourteen minutes late), so it is a founder number, not a default.
 */
export const ALERT_DIGEST_CADENCE: AlertDigestCadence = Object.freeze({
  intervalMs: null,
  accountPageSize: null,
});

export const ALERT_DIGEST_BLOCKERS = [
  'zone_keyring_unset',
  'digest_routing_unarmed',
  'cadence_unratified',
] as const;
export type AlertDigestBlocker = (typeof ALERT_DIGEST_BLOCKERS)[number];

/** Two: the account listing and one account's transaction, never at once. */
const ALERT_DIGEST_POOL_MAX = 2;

export type AlertDigestWiring =
  | {
      readonly enabled: false;
      readonly blockers: readonly AlertDigestBlocker[];
    }
  | {
      readonly enabled: true;
      readonly intervalMs: number;
      readonly deps: AlertDigestCycleDeps;
      /** Releases the pool. Always called from a `finally`. */
      close(): Promise<void>;
    };

export interface AlertDigestWiringOptions {
  /** The digest routing. Absent in every deployment today (H2/D7). */
  readonly routing?: AlertDigestRouting | null;
  /** Injected for tests; defaults to {@link ALERT_DIGEST_CADENCE}. */
  readonly cadence?: AlertDigestCadence;
}

export function wireAlertDigest(
  config: ServerConfig,
  env: Environment,
  options: AlertDigestWiringOptions = {},
): AlertDigestWiring {
  const keyring = loadZonesConfig(env);
  const routing = options.routing ?? null;
  const { intervalMs, accountPageSize } = options.cadence ?? ALERT_DIGEST_CADENCE;

  const blockers: AlertDigestBlocker[] = [];
  if (keyring === null) blockers.push('zone_keyring_unset');
  if (routing === null) blockers.push('digest_routing_unarmed');
  if (intervalMs === null || accountPageSize === null) blockers.push('cadence_unratified');
  if (keyring === null || routing === null || intervalMs === null || accountPageSize === null) {
    return { enabled: false, blockers };
  }

  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
    max: ALERT_DIGEST_POOL_MAX,
  });
  return {
    enabled: true,
    intervalMs,
    deps: {
      store: createPgAlertDigestStore(pool),
      cipher: createAesGcmZoneCipher(keyring),
      routing,
      clock: systemClock,
      accountPageSize,
    },
    close: () => pool.end(),
  };
}
