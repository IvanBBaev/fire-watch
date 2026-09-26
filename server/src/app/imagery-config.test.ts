import { describe, expect, it } from 'vitest';

import {
  ARCGIS_API_KEY_ENV,
  ARCGIS_TILE_URL_ENV,
  ConfigError,
  loadConfig,
  type Environment,
} from './config.js';
import { loadImageryConfig } from './imagery-config.js';

const TEMPLATE = 'https://tiles.example.test/imagery/tile/{z}/{y}/{x}';
const STATE = '/var/lib/fire-watch';

function env(overrides: Environment = {}): Environment {
  return { DATABASE_URL: 'postgres://u@db/fw', FIRMS_MAP_KEY: 'key', ...overrides };
}

const KEYED = { [ARCGIS_API_KEY_ENV]: 'AAPK-key', [ARCGIS_TILE_URL_ENV]: TEMPLATE };

describe('loadImageryConfig', () => {
  it('hands the meter what loadConfig read', () => {
    const config = loadConfig(env({ ...KEYED, FIRE_WATCH_STATE_DIR: STATE }));
    expect(loadImageryConfig(config)).toBe(config.imagery);
  });

  it('is keyless and unarmed without a state dir when nothing is set', () => {
    expect(loadImageryConfig(loadConfig(env()))).toEqual({ handles: null, ceilingTiles: null });
  });

  it('refuses a key with nowhere to latch', () => {
    const config = loadConfig(env(KEYED));
    expect(() => loadImageryConfig(config)).toThrow(ConfigError);
    expect(() => loadImageryConfig(config)).toThrow(/FIRE_WATCH_STATE_DIR/);
  });
});
