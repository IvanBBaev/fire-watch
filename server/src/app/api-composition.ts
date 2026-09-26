/**
 * The API process's composition, apart from its signal handling: config, the public server
 * (probes, snapshot, stream, and the account surface when enabled) and the internal
 * `/metrics` listener.
 *
 * `api.ts` is an entrypoint that runs on import, so the composition lives here to let the
 * integration test (`api.integration.test.ts`) boot exactly what production boots, rather
 * than a hand-assembled copy that could drift from it.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { describeConfig, loadConfig, type Environment } from './config.js';
import { wireHealthServer } from './health-wiring.js';
import type { ProcessLog } from './logging.js';
import { describeMetricsConfig, loadMetricsConfig } from './metrics-config.js';
import {
  createMetricsListener,
  createProcessMetrics,
  freshnessCollector,
  transportCollector,
  type MetricsListener,
} from './metrics-wiring.js';
import { describeZonesConfig, loadZonesConfig } from './zones-config.js';

export const API_APPLICATION_NAME = 'fire-watch-api';

export interface RunningApi {
  /** Drains the stream, closes the listeners and releases the pools. */
  readonly close: () => Promise<void>;
}

/**
 * Loads the configuration from `env`, wires and starts every listener. Throws
 * `ConfigError` on a misconfiguration, before anything listens.
 */
export async function startApi(env: Environment, log: ProcessLog): Promise<RunningApi> {
  const config = loadConfig(env, API_APPLICATION_NAME);
  log.note({ starting: describeConfig(config) });

  // C5: the internal /metrics listener, off unless FIRE_WATCH_METRICS_PORT is set. Its
  // own port, never a route on the public server (see metrics-server.ts).
  const metricsConfig = loadMetricsConfig(env, config.apiPort);
  log.note({ metrics: describeMetricsConfig(metricsConfig) });

  // I2, I6: the zone-centre keyring. Absent, the zone and export routes are not served.
  const zoneKeyring = loadZonesConfig(env);
  log.note({ zones: describeZonesConfig(zoneKeyring) });

  const wiring = wireHealthServer(config, log, { zoneKeyring });
  let metricsListener: MetricsListener | null = null;
  if (metricsConfig !== null) {
    const registry = createProcessMetrics();
    registry.addCollector(freshnessCollector({ ...wiring.freshness, clock: systemClock }));
    registry.addCollector(transportCollector(wiring.transport));
    metricsListener = createMetricsListener(metricsConfig, registry);
  }
  try {
    await wiring.listen();
    await metricsListener?.listen();
  } catch (error) {
    // A port already taken must not leave the pools and timers of a half-started process
    // holding the event loop open.
    try {
      await metricsListener?.close();
    } finally {
      await wiring.close();
    }
    throw error;
  }
  log.note({ listening: true });

  return {
    close: async () => {
      // The metrics listener first: its collector reads through the pool `wiring.close` ends.
      try {
        await metricsListener?.close();
      } finally {
        await wiring.close();
      }
    },
  };
}
