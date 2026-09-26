/**
 * The imagery tripwire's configuration, as the meter consumes it (ADR-001 A1.3/A2.3;
 * `core/imagery/imagery-meter.ts`).
 *
 * The variables themselves — `FIRE_WATCH_ARCGIS_API_KEY`, `FIRE_WATCH_ARCGIS_IMAGERY_TILE_URL`,
 * `FIRE_WATCH_ARCGIS_TILE_CEILING` — are read and validated by `loadConfig` and logged by
 * `describeConfig` (`config.ts`, {@link ServerConfig.imagery}). What stays here is the one
 * rule that only the process running the meter needs:
 *
 * A key without `FIRE_WATCH_STATE_DIR` is refused at start-up: the kill switch, the
 * override, the trip latch and the usage reading all live there, and a meter with nowhere
 * to latch would forget a trip on restart.
 */

import type { ImageryMeterConfig } from '../core/imagery/imagery-meter.js';

import { ARCGIS_API_KEY_ENV, ConfigError, type ServerConfig } from './config.js';

export function loadImageryConfig(
  config: Pick<ServerConfig, 'imagery' | 'stateDir'>,
): ImageryMeterConfig {
  if (config.imagery.handles !== null && config.stateDir === null) {
    throw new ConfigError(
      `${ARCGIS_API_KEY_ENV} needs FIRE_WATCH_STATE_DIR: the imagery switches and trip latch live there`,
    );
  }
  return config.imagery;
}
