/**
 * The alert-path canary (TASKS J1) — port only.
 *
 * A probe is a synthetic alert that must travel the **real** path: written to the outbox,
 * claimed and dispatched by the notification gateway, and acknowledged by a provider. An
 * implementation that delivers it any other way proves nothing about the path users
 * depend on, and one that sends it directly would also break the dependency-cruiser rule
 * `only-the-gateway-sends`.
 *
 * No adapter exists yet, deliberately. A probe row cannot be written today without a
 * founder decision: `alert_outbox` requires a real watch zone and fire event (NOT NULL
 * foreign keys) and its channel CHECK admits only user channels. The operator channel it
 * needs is the separate operator-alert bot of OPERATIONS §3 rule 3, a secret in §8.1 that
 * has not been provisioned. Until then the monitor runs with no probe and the canary
 * reading is `null`.
 */

import type { EpochMs } from './clock.js';

export interface CanaryInjection {
  /** Opaque to the core; the adapter's handle on the probe it wrote. */
  readonly probeId: string;
  readonly injectedAt: EpochMs;
}

export interface CanaryProbe {
  /** Enqueues one probe through the gateway's own queue. Never sends. */
  inject(now: EpochMs): Promise<CanaryInjection>;
  /** The provider acknowledgement instant for a probe, or `null` while it has none. */
  observe(probeId: string): Promise<EpochMs | null>;
}
