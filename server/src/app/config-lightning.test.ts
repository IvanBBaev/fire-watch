import { describe, expect, it } from 'vitest';

import { EUMETSAT_API_BASE_URL } from '../adapters/lightning/eumetsat-datastore-client.js';
import {
  ConfigError,
  EUMETSAT_CONSUMER_KEY_ENV,
  EUMETSAT_CONSUMER_SECRET_ENV,
  describeConfig,
  loadConfig,
  type Environment,
} from './config.js';

const DATABASE_URL = 'postgres://fire_watch:hunter2@db.internal:5432/fire_watch';
const KEY = 'consumer-key-value';
const SECRET = 'consumer-secret-value';

function env(overrides: Environment = {}): Environment {
  return { DATABASE_URL, FIRMS_MAP_KEY: 'testtesttesttesttesttesttesttest', ...overrides };
}

const CREDENTIALS = {
  [EUMETSAT_CONSUMER_KEY_ENV]: KEY,
  [EUMETSAT_CONSUMER_SECRET_ENV]: SECRET,
  FIRE_WATCH_STATE_DIR: '/var/lib/fire-watch',
};

describe('loadConfig — lightning (F18)', () => {
  it('is off when neither credential is set', () => {
    expect(loadConfig(env()).lightning).toBeNull();
    expect(describeConfig(loadConfig(env()))['lightning']).toBe('<not configured>');
  });

  it('reads the pair with the default base URL', () => {
    expect(loadConfig(env(CREDENTIALS)).lightning).toEqual({
      credentials: { consumerKey: KEY, consumerSecret: SECRET },
      baseUrl: EUMETSAT_API_BASE_URL,
    });
  });

  it('refuses one credential without the other, naming the missing one', () => {
    expect(() => loadConfig(env({ ...CREDENTIALS, [EUMETSAT_CONSUMER_SECRET_ENV]: ' ' }))).toThrow(
      new RegExp(`missing: ${EUMETSAT_CONSUMER_SECRET_ENV}`),
    );
    expect(() => loadConfig(env({ ...CREDENTIALS, [EUMETSAT_CONSUMER_KEY_ENV]: '' }))).toThrow(
      ConfigError,
    );
  });

  it('refuses credentials without a state directory', () => {
    expect(() => loadConfig(env({ ...CREDENTIALS, FIRE_WATCH_STATE_DIR: '' }))).toThrow(
      /FIRE_WATCH_STATE_DIR/,
    );
  });

  it('takes a base URL override and refuses a non-http one', () => {
    expect(
      loadConfig(env({ ...CREDENTIALS, FIRE_WATCH_EUMETSAT_BASE_URL: 'http://127.0.0.1:9999' }))
        .lightning?.baseUrl,
    ).toMatch(/^http:\/\/127\.0\.0\.1:9999/);
    expect(() =>
      loadConfig(env({ ...CREDENTIALS, FIRE_WATCH_EUMETSAT_BASE_URL: 'ftp://x' })),
    ).toThrow(ConfigError);
  });

  it('never logs the credentials', () => {
    const described = JSON.stringify(describeConfig(loadConfig(env(CREDENTIALS))));
    expect(described).not.toContain(KEY);
    expect(described).not.toContain(SECRET);
    expect(describeConfig(loadConfig(env(CREDENTIALS)))['lightning']).toBe(
      `<configured, ${EUMETSAT_API_BASE_URL}>`,
    );
  });
});
