/**
 * Wiring for the C4 context refresh loops: EFFIS layers and ECMWF weather fields.
 *
 * Everything lands under one state directory — payloads and feed-status rows alike —
 * because the API process reads both halves of it from the same VM: the proxy route
 * serves `overlays/effis/<layer>/current.<ext>`, and the health endpoint reads `feed-status/` to
 * answer for the C4 freshness rows. No state dir, no loops: a developer box records
 * nothing and *claims* nothing, which keeps its health endpoint honest.
 *
 * The cadences are set from the C5 budgets, not the other way round:
 *
 *   * EFFIS every 6 h against a 24 h warn budget — four chances before a warn, and well
 *     inside the daily cadence of the FWI layer itself.
 *   * Weather every 1 h against a 6 h warn budget. Cheap on purpose: once a run's fields
 *     are on disk the hourly pass is one small index fetch per step and a stack of
 *     `already_recorded`s — what the hourly cadence buys is prompt pickup of each new
 *     run and self-healing of a partially-failed one.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createEffisHttpClient } from '../adapters/effis/effis-http-client.js';
import { zlibInflate } from '../adapters/effis/zlib-inflate.js';
import { createFsFeedStatusStore } from '../adapters/storage/fs-feed-status-store.js';
import { createFsPayloadStore } from '../adapters/storage/fs-payload-store.js';
import { createEcmwfHttpClient } from '../adapters/weather/ecmwf-http-client.js';
import type { EffisRefreshDeps } from '../core/effis/effis-refresh.js';
import type { WeatherRefreshDeps } from '../core/weather/weather-refresh.js';
import type { ServerConfig } from './config.js';

export const EFFIS_REFRESH_INTERVAL_MS = 6 * 3_600_000;

export const WEATHER_REFRESH_INTERVAL_MS = 3_600_000;

export interface RefreshWiring {
  readonly effisDeps: EffisRefreshDeps;
  readonly weatherDeps: WeatherRefreshDeps;
}

/** `null` exactly when the deployment has no state dir — the worker logs why and runs without. */
export function wireRefreshJobs(config: ServerConfig): RefreshWiring | null {
  if (config.stateDir === null) return null;

  const payloads = createFsPayloadStore(config.stateDir);
  const feedStatus = createFsFeedStatusStore(config.stateDir);

  return {
    effisDeps: {
      client: createEffisHttpClient({ clock: systemClock, baseUrl: config.effisBaseUrl }),
      payloads,
      feedStatus,
      clock: systemClock,
      inflate: zlibInflate,
    },
    weatherDeps: {
      client: createEcmwfHttpClient({ clock: systemClock, baseUrl: config.ecmwfBaseUrl }),
      payloads,
      feedStatus,
      clock: systemClock,
    },
  };
}
