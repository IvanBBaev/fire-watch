import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_API_PORT,
  DEFAULT_POLL_INTERVAL_MS,
  describeConfig,
  loadConfig,
  type Environment,
} from './config.js';

const MAP_KEY = 'testtesttesttesttesttesttesttest';
const DATABASE_URL = 'postgres://fire_watch:hunter2@db.internal:5432/fire_watch';

function env(overrides: Environment = {}): Environment {
  return { DATABASE_URL, FIRMS_MAP_KEY: MAP_KEY, ...overrides };
}

describe('loadConfig', () => {
  it('reads what the process was given', () => {
    const config = loadConfig(env(), 'fire-watch-ingest');

    expect(config.databaseUrl).toBe(DATABASE_URL);
    expect(config.firmsMapKey).toBe(MAP_KEY);
    expect(config.applicationName).toBe('fire-watch-ingest');
  });

  it('assumes the append-only role unless told otherwise', () => {
    expect(loadConfig(env()).databaseRole).toBe('fire_watch_app');
    expect(loadConfig(env({ FIRE_WATCH_DB_ROLE: 'fire_watch_admin' })).databaseRole).toBe(
      'fire_watch_admin',
    );
  });

  it('names every missing variable at once', () => {
    // One restart per missing variable, in the dark, is the failure mode this avoids.
    const error = (): unknown => {
      try {
        loadConfig({});
      } catch (thrown: unknown) {
        return thrown;
      }
      return null;
    };

    const thrown = error();
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain('DATABASE_URL');
    expect((thrown as Error).message).toContain('FIRMS_MAP_KEY');
  });

  it('treats an empty or blank value as absent', () => {
    // An env file with `FIRMS_MAP_KEY=` set is a misconfiguration, not an empty key.
    expect(() => loadConfig(env({ FIRMS_MAP_KEY: '' }))).toThrow(/FIRMS_MAP_KEY/);
    expect(() => loadConfig(env({ FIRMS_MAP_KEY: '   ' }))).toThrow(/FIRMS_MAP_KEY/);
  });

  it('trims a value, because env files acquire trailing whitespace', () => {
    expect(loadConfig(env({ FIRMS_MAP_KEY: ` ${MAP_KEY}\n` })).firmsMapKey).toBe(MAP_KEY);
  });

  it('talks to FIRMS unless it is pointed at a stub', () => {
    expect(loadConfig(env()).firmsBaseUrl).toBe(
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv',
    );
    expect(loadConfig(env({ FIRMS_BASE_URL: 'http://127.0.0.1:8080/area/csv' })).firmsBaseUrl).toBe(
      'http://127.0.0.1:8080/area/csv',
    );
  });

  it('refuses a base URL the key would be appended to blindly', () => {
    expect(() => loadConfig(env({ FIRMS_BASE_URL: '/api/area/csv' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ FIRMS_BASE_URL: 'file:///etc/passwd' }))).toThrow(
      /http or https/,
    );
  });

  it('polls every 10 minutes unless the deployment says otherwise', () => {
    expect(loadConfig(env()).pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(loadConfig(env({ FIRE_WATCH_POLL_INTERVAL_MS: '900000' })).pollIntervalMs).toBe(900_000);
  });

  it('refuses a cadence that would burn the quota or go stale', () => {
    // A misplaced digit in either direction is a season-scale mistake, and the env file
    // is edited over SSH at 03:00 far more often than the code is.
    expect(() => loadConfig(env({ FIRE_WATCH_POLL_INTERVAL_MS: '6000' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ FIRE_WATCH_POLL_INTERVAL_MS: '21600000' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ FIRE_WATCH_POLL_INTERVAL_MS: '10 minutes' }))).toThrow(
      /FIRE_WATCH_POLL_INTERVAL_MS/,
    );
  });

  it('binds the probe surface to loopback unless told otherwise', () => {
    // The API is reached through the reverse proxy. Bound to `0.0.0.0` on a VM with a
    // public address, a health endpoint is something the whole internet can rate-limit
    // us on.
    const config = loadConfig(env());
    expect(config.apiHost).toBe('127.0.0.1');
    expect(config.apiPort).toBe(DEFAULT_API_PORT);

    expect(
      loadConfig(env({ FIRE_WATCH_API_HOST: '0.0.0.0', FIRE_WATCH_API_PORT: '9099' })),
    ).toMatchObject({ apiHost: '0.0.0.0', apiPort: 9099 });
  });

  it('refuses a port the container would need to be root for', () => {
    expect(() => loadConfig(env({ FIRE_WATCH_API_PORT: '80' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ FIRE_WATCH_API_PORT: '8080 ' }))).not.toThrow();
    expect(() => loadConfig(env({ FIRE_WATCH_API_PORT: 'eighty' }))).toThrow(/FIRE_WATCH_API_PORT/);
  });

  it('refuses the retired trust-proxy switch on sight, whatever its value', () => {
    // Both of its settings keyed the rate limiter on a value an attacker could pick or
    // share, and a security-relevant variable that is silently ignored looks exactly
    // like one that works — so even `false` is a boot failure, with the successor named.
    expect(() => loadConfig(env({ FIRE_WATCH_TRUST_PROXY: 'true' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ FIRE_WATCH_TRUST_PROXY: 'false' }))).toThrow(
      /FIRE_WATCH_CLIENT_IP_HEADER/,
    );
    expect(() => loadConfig(env({ FIRE_WATCH_TRUST_PROXY: '' }))).toThrow(ConfigError);
  });

  it('lowercases the edge client-IP header, the case Node presents headers in', () => {
    expect(loadConfig(env()).apiClientIpHeader).toBeUndefined();
    expect(
      loadConfig(env({ FIRE_WATCH_CLIENT_IP_HEADER: 'CF-Connecting-IP' })).apiClientIpHeader,
    ).toBe('cf-connecting-ip');
    expect(
      loadConfig(env({ FIRE_WATCH_CLIENT_IP_HEADER: ' cf-connecting-ip\n' })).apiClientIpHeader,
    ).toBe('cf-connecting-ip');
  });

  it('refuses an empty or malformed header name', () => {
    // Set-but-empty is a misconfiguration, not "no header": the operator meant something,
    // and guessing which something is how a limiter ends up keyed on nothing.
    expect(() => loadConfig(env({ FIRE_WATCH_CLIENT_IP_HEADER: '' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ FIRE_WATCH_CLIENT_IP_HEADER: '   ' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ FIRE_WATCH_CLIENT_IP_HEADER: 'cf connecting ip' }))).toThrow(
      /FIRE_WATCH_CLIENT_IP_HEADER/,
    );
  });

  it('refuses the headers proxies append to rather than overwrite', () => {
    // The leftmost X-Forwarded-For entry — the one a limiter would read — stays whatever
    // the caller wrote, no matter how trustworthy every proxy after it is.
    expect(() => loadConfig(env({ FIRE_WATCH_CLIENT_IP_HEADER: 'X-Forwarded-For' }))).toThrow(
      /appended/,
    );
    expect(() => loadConfig(env({ FIRE_WATCH_CLIENT_IP_HEADER: 'forwarded' }))).toThrow(
      ConfigError,
    );
  });

  it("runs without a dead-man's switch rather than pinging a stranger's check", () => {
    // A developer box has no heartbeat. Inventing one would make the monitor that is
    // supposed to survive our whole VM report on somebody's laptop instead.
    expect(loadConfig(env()).heartbeatPingBaseUrl).toBeNull();
    expect(loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: '' })).heartbeatPingBaseUrl).toBeNull();
    expect(
      loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: 'https://hc.example/key' })).heartbeatPingBaseUrl,
    ).toBe('https://hc.example/key');
  });

  it('refuses a heartbeat URL without quoting the value, which is the secret', () => {
    const secret = 'http://hc.example/0000-secret';
    expect(() => loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: secret }))).toThrow(ConfigError);
    try {
      loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: secret }));
    } catch (thrown: unknown) {
      expect((thrown as Error).message).not.toContain('0000-secret');
    }
    expect(() => loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: 'not-a-url' }))).toThrow(
      /absolute https URL/,
    );
  });
});

describe('describeConfig', () => {
  it('says which database without saying the password', () => {
    const described = describeConfig(loadConfig(env()));

    expect(described['database']).toBe('postgres://fire_watch@db.internal:5432/fire_watch');
    expect(JSON.stringify(described)).not.toContain('hunter2');
  });

  it('never prints the map key, only its length', () => {
    const described = describeConfig(loadConfig(env()));

    expect(JSON.stringify(described)).not.toContain(MAP_KEY);
    expect(described['firms_map_key']).toBe('<32 characters>');
  });

  it('refuses to print a connection string it could not parse', () => {
    // A libpq DSN carries `password=` in the clear; failing to parse is not permission
    // to print it.
    const described = describeConfig(
      loadConfig(env({ DATABASE_URL: 'host=db.internal password=hunter2' })),
    );

    expect(described['database']).toBe('<unparseable DATABASE_URL>');
    expect(JSON.stringify(described)).not.toContain('hunter2');
  });

  it('says whether there is a heartbeat, never which one', () => {
    // The ping URL is the credential: anyone holding it can keep our dead-man's switch
    // quiet forever, so even its host is withheld from the startup line.
    const url = 'https://hc.example/0000-secret';
    const described = describeConfig(loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: url })));

    expect(described['heartbeat']).toBe('<configured>');
    expect(JSON.stringify(described)).not.toContain('0000-secret');
    expect(JSON.stringify(described)).not.toContain('hc.example');
    expect(describeConfig(loadConfig(env()))['heartbeat']).toBe('<not configured>');
  });

  it('says where the probe surface is listening, which is not a secret', () => {
    expect(describeConfig(loadConfig(env()))['api_listen']).toBe(
      `127.0.0.1:${String(DEFAULT_API_PORT)}`,
    );
  });

  it('names the client-IP header, which is configuration, not a secret', () => {
    // The addresses the header will carry are never logged; the *name* is exactly what an
    // operator needs to see to know which edge the limiter believes.
    expect(describeConfig(loadConfig(env()))['client_ip_header']).toBe('<not configured>');
    expect(
      describeConfig(loadConfig(env({ FIRE_WATCH_CLIENT_IP_HEADER: 'cf-connecting-ip' })))[
        'client_ip_header'
      ],
    ).toBe('cf-connecting-ip');
  });
});
