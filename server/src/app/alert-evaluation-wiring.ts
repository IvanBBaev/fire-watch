/**
 * Wiring for the live alert evaluation loop (TASKS H3; ADR-004 D1, A1.6–A1.12): the loop
 * that reads the `fire_events` rows whose `seq` moved, matches them against the sealed
 * watch zones and writes `alert_states` + `alert_outbox` in one transaction per batch.
 *
 * ## Disabled, with reasons, until every blocker is gone
 *
 * The wiring either returns `enabled: true` with the cycle's dependencies, or
 * `enabled: false` with the list of blockers — and never throws for a blocker, so a worker
 * without zone keys keeps ingesting. The blockers:
 *
 *   - `zone_keyring_unset` — no `FIRE_WATCH_ZONE_KEY_ID`/`FIRE_WATCH_ZONE_KEY`: no centre
 *     can be opened, so no zone can be matched. (A *malformed* keyring is still a
 *     `ConfigError` from `loadZonesConfig`, like every other malformed setting.)
 *   - `alert_routing_unarmed` — no {@link AlertRouting}: the per-account delivery target and
 *     the reviewed template per alert type are founder decisions (H2/D7) with no production
 *     implementation. Running without one would advance the cursor past every `send` and
 *     write nothing (the cycle's `undeliverable` path), so the pair would only be seen
 *     again on the event's next seq bump.
 *   - `cadence_unratified` — {@link ALERT_EVALUATION_CADENCE} is null: no interval, page
 *     size or per-cycle batch limit has been ratified for this loop, and none is invented
 *     here.
 *
 * ## Known gaps that do not block (reported, not hidden)
 *
 *   - `digest_pass_disabled` — a `defer` writes its state and a decision-log row, and only
 *     the digest pass (`alert-digest-wiring.ts`) delivers it. Reported whenever that loop
 *     is not running beside this one (`digestEnabled` is not `true`): the deferrals are
 *     then owed and nothing pays them until it is armed.
 *
 * ## Its own pool
 *
 * Two connections, created only when enabled, like the identity loop: a batch holds one
 * transaction (FOR SHARE on `clustering_runs`, see `pg-alert-evaluation-store.ts`) and
 * must not take a connection from the FIRMS poll.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createAesGcmZoneCipher } from '../adapters/crypto/aes-gcm-zone-cipher.js';
import { createPgAlertEvaluationStore } from '../adapters/db/pg-alert-evaluation-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import type { AlertEvaluationCycleDeps } from '../core/alerts/evaluation-cycle.js';
import type { AlertRouting } from '../core/ports/alert-routing.js';
import type { Environment, ServerConfig } from './config.js';
import { loadZonesConfig } from './zones-config.js';

export interface AlertEvaluationCadence {
  readonly intervalMs: number | null;
  readonly batchLimit: number | null;
  readonly maxBatchesPerCycle: number | null;
}

/**
 * **Unratified — deliberately null.** No spec fixes how often the loop runs, how many
 * events one transaction takes, or how many batches one cycle may take. The FOR SHARE
 * fence makes the page size a direct cost to the identity pipeline, so it is a founder
 * number, not a wiring default.
 */
export const ALERT_EVALUATION_CADENCE: AlertEvaluationCadence = Object.freeze({
  intervalMs: null,
  batchLimit: null,
  maxBatchesPerCycle: null,
});

export const ALERT_EVALUATION_BLOCKERS = [
  'zone_keyring_unset',
  'alert_routing_unarmed',
  'cadence_unratified',
] as const;
export type AlertEvaluationBlocker = (typeof ALERT_EVALUATION_BLOCKERS)[number];

export const ALERT_EVALUATION_GAPS = ['digest_pass_disabled'] as const;
export type AlertEvaluationGap = (typeof ALERT_EVALUATION_GAPS)[number];

/** Two: the batch transaction is the only connection a cycle holds at a time. */
const ALERT_EVALUATION_POOL_MAX = 2;

export type AlertEvaluationWiring =
  | {
      readonly enabled: false;
      readonly blockers: readonly AlertEvaluationBlocker[];
      readonly gaps: readonly AlertEvaluationGap[];
    }
  | {
      readonly enabled: true;
      readonly intervalMs: number;
      readonly deps: AlertEvaluationCycleDeps;
      readonly gaps: readonly AlertEvaluationGap[];
      /** Releases the pool. Always called from a `finally`. */
      close(): Promise<void>;
    };

export interface AlertEvaluationWiringOptions {
  /** The decision-side routing. Absent in every deployment today (H2/D7). */
  readonly routing?: AlertRouting | null;
  /** Injected for tests; defaults to {@link ALERT_EVALUATION_CADENCE}. */
  readonly cadence?: AlertEvaluationCadence;
  /** Whether the digest pass runs in this worker; `false` unless the caller says so. */
  readonly digestEnabled?: boolean;
}

export function wireAlertEvaluation(
  config: ServerConfig,
  env: Environment,
  options: AlertEvaluationWiringOptions = {},
): AlertEvaluationWiring {
  const keyring = loadZonesConfig(env);
  const routing = options.routing ?? null;
  const cadence = options.cadence ?? ALERT_EVALUATION_CADENCE;
  const gaps: AlertEvaluationGap[] = options.digestEnabled === true ? [] : ['digest_pass_disabled'];

  const blockers: AlertEvaluationBlocker[] = [];
  if (keyring === null) blockers.push('zone_keyring_unset');
  if (routing === null) blockers.push('alert_routing_unarmed');
  const { intervalMs, batchLimit, maxBatchesPerCycle } = cadence;
  if (intervalMs === null || batchLimit === null || maxBatchesPerCycle === null) {
    blockers.push('cadence_unratified');
  }
  if (
    keyring === null ||
    routing === null ||
    intervalMs === null ||
    batchLimit === null ||
    maxBatchesPerCycle === null
  ) {
    return { enabled: false, blockers, gaps };
  }

  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
    max: ALERT_EVALUATION_POOL_MAX,
  });
  return {
    enabled: true,
    intervalMs,
    gaps,
    deps: {
      store: createPgAlertEvaluationStore(pool),
      cipher: createAesGcmZoneCipher(keyring),
      routing,
      clock: systemClock,
      batchLimit,
      maxBatchesPerCycle,
    },
    close: () => pool.end(),
  };
}
