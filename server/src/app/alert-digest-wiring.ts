/**
 * Wiring for the live digest pass (TASKS H3; ADR-004 D1, D3, A1.7, A1.11, A1.12): the loop
 * that pays the `defer` and `seed` debts of the evaluation loop and zone creation, one
 * account per transaction (`core/alerts/digest-pass.ts`, `pg-alert-digest-store.ts`).
 *
 * ## Disabled, with reasons, until every blocker is gone
 *
 * Like `alert-evaluation-wiring.ts`, the wiring either returns `enabled: true` with the
 * cycle's dependencies or `enabled: false` with every blocker named, and never throws for
 * a blocker. The blockers:
 *
 *   - `zone_keyring_unset` — no `FIRE_WATCH_ZONE_KEY_ID`/`FIRE_WATCH_ZONE_KEY`: no centre
 *     can be opened, so no fire can be placed in a zone. (A *malformed* keyring is still a
 *     `ConfigError` from `loadZonesConfig`.)
 *   - `digest_routing_unarmed` — no {@link AlertDigestRouting}: which channel a digest goes
 *     out on and its reviewed template are founder decisions (H2/D7) with no production
 *     implementation. Running without one would be harmless — an undeliverable window is
 *     not spent — but it would decrypt every zone every tick to write nothing.
 *   - `cadence_unratified` — {@link ALERT_DIGEST_CADENCE} is null: no tick interval or
 *     account page size has been ratified, and none is invented here.
 *
 * ## Its own pool
 *
 * Two connections, created only when enabled: one account's transaction at a time, plus
 * the account listing, which runs on the pool between transactions. A digest holds an
 * account row `FOR SHARE` and must not take a connection from the FIRMS poll or wait
 * behind an evaluation batch.
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
 * **Unratified — deliberately null.** The window opens at 09:00 local
 * (`digest_params_v1`); how soon after that a digest goes out is the tick interval, and
 * how many accounts one listing page takes bounds a cycle's memory. Both are founder
 * numbers, not wiring defaults.
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

/** Two: one account's transaction, and the listing between transactions. */
const ALERT_DIGEST_POOL_MAX = 2;

export type AlertDigestWiring =
  | { readonly enabled: false; readonly blockers: readonly AlertDigestBlocker[] }
  | {
      readonly enabled: true;
      readonly intervalMs: number;
      readonly deps: AlertDigestCycleDeps;
      /** Releases the pool. Always called from a `finally`. */
      close(): Promise<void>;
    };

export interface AlertDigestWiringOptions {
  /** Where a digest goes and what it says. Absent in every deployment today (H2/D7). */
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
