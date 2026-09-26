import { describe, expect, it } from 'vitest';

import { ConfigError } from './config.js';
import {
  describeMetricsConfig,
  loadMetricsConfig,
  loadMetricsTextfileDir,
  MIN_METRICS_TOKEN_LENGTH,
} from './metrics-config.js';

const API_PORT = 8080;
const TOKEN = 'f'.repeat(64);
const files = (content: string) => (path: string) => {
  if (path !== '/run/secrets/metrics') throw new Error(`unexpected read of ${path}`);
  return content;
};

describe('loadMetricsConfig', () => {
  it('is off when the port is unset or empty', () => {
    expect(loadMetricsConfig({}, API_PORT)).toBeNull();
    expect(loadMetricsConfig({ FIRE_WATCH_METRICS_PORT: '  ' }, API_PORT)).toBeNull();
  });

  it('refuses a host or token file without a port', () => {
    expect(() => loadMetricsConfig({ FIRE_WATCH_METRICS_HOST: '0.0.0.0' }, API_PORT)).toThrow(
      ConfigError,
    );
    expect(() =>
      loadMetricsConfig({ FIRE_WATCH_METRICS_TOKEN_FILE: '/run/secrets/metrics' }, API_PORT),
    ).toThrow(/FIRE_WATCH_METRICS_PORT is not/);
  });

  it('binds loopback by default, with no token required', () => {
    expect(loadMetricsConfig({ FIRE_WATCH_METRICS_PORT: '9464' }, API_PORT)).toEqual({
      port: 9464,
      host: '127.0.0.1',
      bearerToken: null,
    });
  });

  it.each(['abc', '9464.5', '80', '70000', '-1', String(API_PORT)])('refuses port %s', (port) => {
    expect(() => loadMetricsConfig({ FIRE_WATCH_METRICS_PORT: port }, API_PORT)).toThrow(
      ConfigError,
    );
  });

  it('requires a token file on any non-loopback bind', () => {
    expect(() =>
      loadMetricsConfig(
        { FIRE_WATCH_METRICS_PORT: '9464', FIRE_WATCH_METRICS_HOST: '0.0.0.0' },
        API_PORT,
      ),
    ).toThrow(/TOKEN_FILE is required/);
    expect(
      loadMetricsConfig(
        {
          FIRE_WATCH_METRICS_PORT: '9464',
          FIRE_WATCH_METRICS_HOST: '0.0.0.0',
          FIRE_WATCH_METRICS_TOKEN_FILE: '/run/secrets/metrics',
        },
        API_PORT,
        files(`${TOKEN}\n`),
      ),
    ).toEqual({ port: 9464, host: '0.0.0.0', bearerToken: TOKEN });
  });

  it('refuses a relative, unreadable, short or non-printable token file without echoing it', () => {
    const env = {
      FIRE_WATCH_METRICS_PORT: '9464',
      FIRE_WATCH_METRICS_TOKEN_FILE: '/run/secrets/metrics',
    };
    expect(() =>
      loadMetricsConfig({ ...env, FIRE_WATCH_METRICS_TOKEN_FILE: 'secrets/metrics' }, API_PORT),
    ).toThrow(/absolute/);
    expect(() =>
      loadMetricsConfig(env, API_PORT, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/could not be read/);
    const short = 'x'.repeat(MIN_METRICS_TOKEN_LENGTH - 1);
    expect(() => loadMetricsConfig(env, API_PORT, files(short))).toThrow(ConfigError);
    try {
      loadMetricsConfig(env, API_PORT, files(`${TOKEN} ${TOKEN}`));
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).not.toContain(TOKEN);
    }
  });

  it('refuses a bind address that is not one', () => {
    expect(() =>
      loadMetricsConfig(
        { FIRE_WATCH_METRICS_PORT: '9464', FIRE_WATCH_METRICS_HOST: 'a b' },
        API_PORT,
      ),
    ).toThrow(/not a bind address/);
  });
});

describe('describeMetricsConfig', () => {
  it('says whether a token is set, never what it is', () => {
    const text = JSON.stringify(
      describeMetricsConfig({ port: 9464, host: '0.0.0.0', bearerToken: TOKEN }),
    );
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('"metrics_token":"set"');
    expect(describeMetricsConfig(null)).toEqual({ metrics: 'unset' });
  });
});

describe('loadMetricsTextfileDir', () => {
  it('is null when unset and must be absolute when set', () => {
    expect(loadMetricsTextfileDir({})).toBeNull();
    expect(loadMetricsTextfileDir({ FIRE_WATCH_METRICS_TEXTFILE_DIR: '/var/lib/m' })).toBe(
      '/var/lib/m',
    );
    expect(() => loadMetricsTextfileDir({ FIRE_WATCH_METRICS_TEXTFILE_DIR: 'm' })).toThrow(
      ConfigError,
    );
  });
});
