import { describe, expect, it } from 'vitest';

import { DEV_PG_IMAGE, DEV_PG_PORT, DEV_POLL_INTERVAL_MS, planDevLive } from './dev-live-plan.js';

describe('planDevLive', () => {
  it('defaults to keyless FIRMS, the fwtest socket and live web data', () => {
    const plan = planDevLive({ PATH: '/usr/bin' }, true, '/home/dev');

    expect(plan.dockerHost).toBe('unix:///home/dev/.colima/fwtest/docker.sock');
    expect(plan.image).toBe(DEV_PG_IMAGE);
    expect(plan.port).toBe(DEV_PG_PORT);
    expect(plan.databaseUrl).toMatch(/@127\.0\.0\.1:55433\/fire_watch\?sslmode=disable$/);
    expect(plan.serverEnv['DATABASE_URL']).toBe(plan.databaseUrl);
    expect(plan.serverEnv['FIRE_WATCH_FIRMS_MODE']).toBe('keyless');
    expect(plan.serverEnv['FIRE_WATCH_POLL_INTERVAL_MS']).toBe(String(DEV_POLL_INTERVAL_MS));
    expect(plan.serverEnv['PATH']).toBe('/usr/bin');
    expect(plan.webEnv['VITE_FIRE_WATCH_DATA']).toBe('live');
    expect(plan.webEnv['DATABASE_URL']).toBeUndefined();
  });

  it('respects what the caller set', () => {
    const plan = planDevLive(
      {
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        FIRE_WATCH_PG_IMAGE: 'postgis/postgis:16-3.4',
        FIRE_WATCH_DEV_PG_PORT: '56000',
        FIRE_WATCH_FIRMS_MODE: 'area',
        FIRE_WATCH_POLL_INTERVAL_MS: '600000',
      },
      true,
      '/home/dev',
    );

    expect(plan.dockerHost).toBe('unix:///var/run/docker.sock');
    expect(plan.image).toBe('postgis/postgis:16-3.4');
    expect(plan.port).toBe(56_000);
    expect(plan.serverEnv['FIRE_WATCH_FIRMS_MODE']).toBe('area');
    expect(plan.serverEnv['FIRE_WATCH_POLL_INTERVAL_MS']).toBe('600000');
  });

  it('uses the default docker context when there is no fwtest profile', () => {
    expect(planDevLive({}, false, '/home/dev').dockerHost).toBeUndefined();
  });

  it('refuses a port it cannot bind', () => {
    expect(() => planDevLive({ FIRE_WATCH_DEV_PG_PORT: '80' }, false, '/h')).toThrow(RangeError);
    expect(() => planDevLive({ FIRE_WATCH_DEV_PG_PORT: 'x' }, false, '/h')).toThrow(RangeError);
  });
});
