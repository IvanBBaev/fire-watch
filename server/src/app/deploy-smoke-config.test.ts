import { describe, expect, it } from 'vitest';

import { ConfigError } from './config.js';
import {
  DEFAULT_SMOKE_API_URL,
  DEFAULT_SMOKE_DEADLINE_MS,
  DEFAULT_SMOKE_INTERVAL_MS,
  loadDeploySmokeConfig,
} from './deploy-smoke-config.js';

const TOKEN = 'a'.repeat(64);

describe('loadDeploySmokeConfig', () => {
  it('defaults to the compose API service and no meta probe', () => {
    expect(loadDeploySmokeConfig({})).toEqual({
      apiUrl: DEFAULT_SMOKE_API_URL,
      metaUrl: null,
      metaToken: null,
      deadlineMs: DEFAULT_SMOKE_DEADLINE_MS,
      intervalMs: DEFAULT_SMOKE_INTERVAL_MS,
    });
  });

  it("probes the worker's own metrics listener on loopback, with its token", () => {
    const config = loadDeploySmokeConfig(
      {
        FIRE_WATCH_METRICS_PORT: '9464',
        FIRE_WATCH_METRICS_HOST: '0.0.0.0',
        FIRE_WATCH_METRICS_TOKEN_FILE: '/run/secrets/fire_watch_metrics_token',
      },
      () => `${TOKEN}\n`,
    );
    expect(config.metaUrl).toBe('http://127.0.0.1:9464');
    expect(config.metaToken).toBe(TOKEN);
  });

  it.each([
    [{ FIRE_WATCH_SMOKE_API_URL: 'api:8080' }, /http\(s\) URL/],
    [{ FIRE_WATCH_SMOKE_DEADLINE_MS: '-1' }, /positive integer/],
    [{ FIRE_WATCH_SMOKE_INTERVAL_MS: 'soon' }, /positive integer/],
    [{ FIRE_WATCH_METRICS_PORT: '9464', FIRE_WATCH_METRICS_HOST: '0.0.0.0' }, /token|TOKEN/],
  ])('refuses %j', (env, message) => {
    expect(() => loadDeploySmokeConfig(env)).toThrow(ConfigError);
    expect(() => loadDeploySmokeConfig(env)).toThrow(message);
  });
});
