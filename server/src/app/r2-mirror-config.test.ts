import { describe, expect, it } from 'vitest';

import { ConfigError, type Environment } from './config.js';
import { describeR2MirrorConfig, loadR2MirrorConfig } from './r2-mirror-config.js';

const ACCESS_KEY_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SECRET = 'Zm9vYmFyYmF6cXV4c2VjcmV0c2VjcmV0c2VjcmV0MTI=';
const PUBLIC_URL = 'https://t2.fire-watch.example/snapshot.json';

function env(overrides: Environment = {}): Environment {
  return {
    FIRE_WATCH_R2_ENDPOINT: 'https://acct123.eu.r2.cloudflarestorage.com',
    FIRE_WATCH_R2_BUCKET: 'fire-watch-t2',
    FIRE_WATCH_R2_ACCESS_KEY_ID: ACCESS_KEY_ID,
    FIRE_WATCH_R2_SECRET_ACCESS_KEY: SECRET,
    ...overrides,
  };
}

function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error: unknown) {
    return error as Error;
  }
  throw new Error('expected a throw');
}

describe('loadR2MirrorConfig', () => {
  it('is null — mirror off — when nothing is set', () => {
    expect(loadR2MirrorConfig({}, PUBLIC_URL)).toBeNull();
  });

  it('reads the full group, defaulting the object key', () => {
    expect(loadR2MirrorConfig(env(), PUBLIC_URL)).toEqual({
      endpoint: 'https://acct123.eu.r2.cloudflarestorage.com',
      bucket: 'fire-watch-t2',
      objectKey: 'snapshot.json',
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      publicUrl: PUBLIC_URL,
    });
    expect(loadR2MirrorConfig(env(), null)?.publicUrl).toBeNull();
  });

  it('refuses a partial group, naming only what is missing', () => {
    const error = thrown(() =>
      loadR2MirrorConfig(env({ FIRE_WATCH_R2_SECRET_ACCESS_KEY: ' ' }), PUBLIC_URL),
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toMatch(/missing: FIRE_WATCH_R2_SECRET_ACCESS_KEY$/);
  });

  it('refuses an object key without the group', () => {
    expect(() => loadR2MirrorConfig({ FIRE_WATCH_R2_OBJECT_KEY: 'a.json' }, null)).toThrow(
      ConfigError,
    );
  });

  it('requires the public URL to name the object this worker writes', () => {
    expect(
      loadR2MirrorConfig(
        env({ FIRE_WATCH_R2_OBJECT_KEY: 'v1/snapshot.json' }),
        'https://t2.fire-watch.example/v1/snapshot.json',
      )?.objectKey,
    ).toBe('v1/snapshot.json');
    expect(() =>
      loadR2MirrorConfig(env({ FIRE_WATCH_R2_OBJECT_KEY: 'v1/snapshot.json' }), PUBLIC_URL),
    ).toThrow(/must end in \/v1\/snapshot\.json/);
  });

  const BAD: readonly [string, Environment][] = [
    ['http endpoint', { FIRE_WATCH_R2_ENDPOINT: 'http://acct123.r2.cloudflarestorage.com' }],
    ['non-URL endpoint', { FIRE_WATCH_R2_ENDPOINT: `not a url ${SECRET}` }],
    [
      'endpoint with userinfo',
      { FIRE_WATCH_R2_ENDPOINT: `https://${ACCESS_KEY_ID}:x@acct.r2.cloudflarestorage.com` },
    ],
    ['endpoint with a path', { FIRE_WATCH_R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/b' }],
    ['bad bucket', { FIRE_WATCH_R2_BUCKET: 'Fire_Watch' }],
    ['bad access key id', { FIRE_WATCH_R2_ACCESS_KEY_ID: `${ACCESS_KEY_ID}!` }],
    ['bad secret', { FIRE_WATCH_R2_SECRET_ACCESS_KEY: `${SECRET} tail` }],
    ['secret equal to the key id', { FIRE_WATCH_R2_SECRET_ACCESS_KEY: ACCESS_KEY_ID }],
    ['bad object key', { FIRE_WATCH_R2_OBJECT_KEY: '../snapshot.json' }],
    ['partial group', { FIRE_WATCH_R2_BUCKET: '' }],
  ];

  it.each(BAD)('refuses a %s', (_label, overrides) => {
    expect(() => loadR2MirrorConfig(env(overrides), PUBLIC_URL)).toThrow(ConfigError);
  });

  it('never quotes a secret or key id in any error it raises', () => {
    for (const [, overrides] of BAD) {
      const { message } = thrown(() => loadR2MirrorConfig(env(overrides), PUBLIC_URL));
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(SECRET.slice(0, 12));
      expect(message).not.toContain(ACCESS_KEY_ID);
      expect(message).toMatch(/FIRE_WATCH_R2_/);
    }
  });
});

describe('describeR2MirrorConfig', () => {
  it('prints where, never who', () => {
    const described = describeR2MirrorConfig(loadR2MirrorConfig(env(), PUBLIC_URL));
    expect(described).toEqual({
      r2_endpoint_host: 'acct123.eu.r2.cloudflarestorage.com',
      r2_bucket: 'fire-watch-t2',
      r2_object_key: 'snapshot.json',
      r2_credentials: 'set',
      r2_public_url: PUBLIC_URL,
    });
    expect(JSON.stringify(described)).not.toContain(SECRET);
    expect(JSON.stringify(described)).not.toContain(ACCESS_KEY_ID);
    expect(describeR2MirrorConfig(null)).toEqual({ r2_mirror: 'unset' });
  });
});
