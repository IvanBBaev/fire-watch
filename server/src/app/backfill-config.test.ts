import { describe, expect, it } from 'vitest';

import { FIRMS_BASE_URL } from '../adapters/firms/firms-http-client.js';
import {
  DEFAULT_BACKFILL_DELAY_MS,
  describeBackfillConfig,
  loadBackfillConfig,
} from './backfill-config.js';
import { ConfigError } from './config.js';

/** Shaped like a real one — 32 characters, alphanumeric — but obviously not one. */
const MAP_KEY = 'testtesttesttesttesttesttesttest';

const ENV = {
  FIRMS_MAP_KEY: MAP_KEY,
  FIRE_WATCH_ARCHIVE_DIR: '/var/lib/fire-watch/archive',
};

describe('loadBackfillConfig', () => {
  it('loads the two required variables and applies the defaults', () => {
    const config = loadBackfillConfig(ENV);

    expect(config).toEqual({
      firmsMapKey: MAP_KEY,
      firmsBaseUrl: FIRMS_BASE_URL,
      archiveDir: '/var/lib/fire-watch/archive',
      requestDelayMs: DEFAULT_BACKFILL_DELAY_MS,
    });
  });

  it('names every missing variable at once, not one restart at a time', () => {
    const failure = (() => {
      try {
        loadBackfillConfig({});
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as Error).message).toContain('FIRMS_MAP_KEY');
    expect((failure as Error).message).toContain('FIRE_WATCH_ARCHIVE_DIR');
  });

  it('treats a blank value as missing', () => {
    expect(() => loadBackfillConfig({ ...ENV, FIRMS_MAP_KEY: '  ' })).toThrow(/FIRMS_MAP_KEY/);
  });

  it('refuses a relative archive dir — it would resolve against a happenstance cwd', () => {
    expect(() => loadBackfillConfig({ ...ENV, FIRE_WATCH_ARCHIVE_DIR: 'archive' })).toThrow(
      /absolute path/,
    );
  });

  it('bounds the politeness delay on both sides', () => {
    expect(
      loadBackfillConfig({ ...ENV, FIRE_WATCH_BACKFILL_DELAY_MS: '30000' }).requestDelayMs,
    ).toBe(30_000);
    for (const raw of ['500', '999', '600001', '1.5', 'fast']) {
      expect(() => loadBackfillConfig({ ...ENV, FIRE_WATCH_BACKFILL_DELAY_MS: raw })).toThrow(
        ConfigError,
      );
    }
  });

  it('accepts the same FIRMS_BASE_URL override the worker takes, with the same rules', () => {
    expect(
      loadBackfillConfig({ ...ENV, FIRMS_BASE_URL: 'http://127.0.0.1:8099/api/area/csv' })
        .firmsBaseUrl,
    ).toBe('http://127.0.0.1:8099/api/area/csv');
    expect(() => loadBackfillConfig({ ...ENV, FIRMS_BASE_URL: 'not-a-url' })).toThrow(
      /absolute URL/,
    );
    expect(() => loadBackfillConfig({ ...ENV, FIRMS_BASE_URL: 'ftp://example.org' })).toThrow(
      /http or https/,
    );
  });
});

describe('describeBackfillConfig', () => {
  it('logs the key by length only — the value never reaches a message', () => {
    const description = describeBackfillConfig(loadBackfillConfig(ENV));

    expect(description['firms_map_key']).toBe('<32 characters>');
    expect(JSON.stringify(description)).not.toContain(MAP_KEY);
    expect(description['archive_dir']).toBe('/var/lib/fire-watch/archive');
    expect(description['request_delay_ms']).toBe(String(DEFAULT_BACKFILL_DELAY_MS));
  });
});
