import { describe, expect, it } from 'vitest';

import {
  ARCGIS_API_KEY_ENV,
  ARCGIS_TILE_CEILING_ENV,
  ARCGIS_TILE_URL_ENV,
  ConfigError,
  DEFAULT_API_PORT,
  DEFAULT_CLIENT_POLL_INTERVAL_MS,
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
      /absolute URL/,
    );
  });

  it('refuses a heartbeat URL the worker could not actually ping', () => {
    // The gate is the adapter's own (`assertPingBaseUrl`), not a copy: a weaker copy here
    // once accepted a bare origin — an operator who pasted the host and forgot the ping
    // key — which booted cleanly and only died inside the worker, as a RangeError with no
    // variable name and exit 1 instead of a ConfigError naming what to fix and exit 2.
    expect(() => loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: 'https://hc.example' }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: 'https://hc.example///' }))).toThrow(
      /FIRE_WATCH_HEARTBEAT_URL/,
    );
    // A query string would survive into the slug URL and corrupt it (`…?next=1/ingest-cycle`).
    expect(() =>
      loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: 'https://hc.example/key?next=1' })),
    ).toThrow(ConfigError);
  });

  it('keeps the rejected heartbeat value out of the message, whatever shape it failed on', () => {
    // Every branch of the shared gate is shape-only; the value — host included — is the
    // credential, and a boot-failure line is exactly the line that ends up in a ticket.
    for (const url of ['https://hc.example', 'https://hc.example/key?next=1']) {
      try {
        loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: url }));
        expect.unreachable('a rejected heartbeat URL must throw');
      } catch (thrown: unknown) {
        expect(thrown).toBeInstanceOf(ConfigError);
        expect((thrown as Error).message).toContain('FIRE_WATCH_HEARTBEAT_URL');
        expect((thrown as Error).message).not.toContain('hc.example');
      }
    }
  });

  it('normalizes a trailing slash off the heartbeat URL, as the adapter does', () => {
    // The adapter appends `/<job>` to this value; without the strip, a slash-terminated
    // secret would ping `…//job`, and the redaction that matches the exact base string
    // would miss the form fetch actually quoted in its errors.
    expect(
      loadConfig(env({ FIRE_WATCH_HEARTBEAT_URL: 'https://hc.example/key/' })).heartbeatPingBaseUrl,
    ).toBe('https://hc.example/key');
  });

  it('runs without a state dir rather than inventing one', () => {
    // No FIRE_WATCH_STATE_DIR means this deployment does not record context feeds; the
    // worker logs that and the health endpoint claims only the Postgres rows.
    expect(loadConfig(env()).stateDir).toBeNull();
    expect(loadConfig(env({ FIRE_WATCH_STATE_DIR: '' })).stateDir).toBeNull();
    expect(loadConfig(env({ FIRE_WATCH_STATE_DIR: ' /var/lib/fire-watch\n' })).stateDir).toBe(
      '/var/lib/fire-watch',
    );
  });

  it('refuses a relative state dir, which would depend on where the process was started', () => {
    expect(() => loadConfig(env({ FIRE_WATCH_STATE_DIR: 'var/lib/fire-watch' }))).toThrow(
      /FIRE_WATCH_STATE_DIR/,
    );
    expect(() => loadConfig(env({ FIRE_WATCH_STATE_DIR: './state' }))).toThrow(ConfigError);
  });

  it('talks to the real EFFIS and ECMWF endpoints unless pointed at stubs', () => {
    const config = loadConfig(env());
    expect(config.effisBaseUrl).toBe('https://maps.effis.emergency.copernicus.eu/effis');
    expect(config.ecmwfBaseUrl).toBe('https://data.ecmwf.int/forecasts');

    const stubbed = loadConfig(
      env({
        FIRE_WATCH_EFFIS_BASE_URL: 'http://127.0.0.1:8081/effis',
        FIRE_WATCH_ECMWF_BASE_URL: 'http://127.0.0.1:8082/forecasts',
      }),
    );
    expect(stubbed.effisBaseUrl).toBe('http://127.0.0.1:8081/effis');
    expect(stubbed.ecmwfBaseUrl).toBe('http://127.0.0.1:8082/forecasts');
  });

  it('refuses a malformed context base URL, naming the variable', () => {
    expect(() => loadConfig(env({ FIRE_WATCH_EFFIS_BASE_URL: '/effis' }))).toThrow(
      /FIRE_WATCH_EFFIS_BASE_URL/,
    );
    expect(() => loadConfig(env({ FIRE_WATCH_ECMWF_BASE_URL: 'ftp://data.ecmwf.int' }))).toThrow(
      /http or https/,
    );
  });
});

describe('loadConfig — alert dispatch', () => {
  it('leaves dispatch off unless the operator sets it to exactly true', () => {
    expect(loadConfig(env()).alertDispatchEnabled).toBe(false);
    expect(
      loadConfig(env({ FIRE_WATCH_ALERT_DISPATCH_ENABLED: 'true' })).alertDispatchEnabled,
    ).toBe(true);
    expect(
      loadConfig(env({ FIRE_WATCH_ALERT_DISPATCH_ENABLED: 'false' })).alertDispatchEnabled,
    ).toBe(false);
    for (const raw of ['1', 'yes', 'on']) {
      expect(() => loadConfig(env({ FIRE_WATCH_ALERT_DISPATCH_ENABLED: raw })), raw).toThrow(
        /FIRE_WATCH_ALERT_DISPATCH_ENABLED/,
      );
    }
    expect(describeConfig(loadConfig(env()))['alert_dispatch_enabled']).toBe('false');
  });
});

describe('loadConfig — fleet control', () => {
  it('offers the stream unless the operator has switched it off', () => {
    expect(loadConfig(env()).sseEnabled).toBe(true);
    expect(loadConfig(env({ FIRE_WATCH_SSE_ENABLED: 'false' })).sseEnabled).toBe(false);
    expect(loadConfig(env({ FIRE_WATCH_SSE_ENABLED: 'FALSE' })).sseEnabled).toBe(false);
    expect(loadConfig(env({ FIRE_WATCH_SSE_ENABLED: 'true' })).sseEnabled).toBe(true);
  });

  it('refuses a kill switch it cannot read as exactly true or false', () => {
    // "I set it to `off` and the stream stayed on" is the mistake this exists to catch.
    for (const raw of ['0', 'off', 'no', 'yes', '1']) {
      expect(() => loadConfig(env({ FIRE_WATCH_SSE_ENABLED: raw })), raw).toThrow(
        /FIRE_WATCH_SSE_ENABLED/,
      );
    }
  });

  it("tells the fleet to poll at the web client's own default unless told otherwise", () => {
    expect(loadConfig(env()).clientPollIntervalMs).toBe(DEFAULT_CLIENT_POLL_INTERVAL_MS);
    expect(DEFAULT_CLIENT_POLL_INTERVAL_MS).toBe(45_000);
    expect(
      loadConfig(env({ FIRE_WATCH_CLIENT_POLL_INTERVAL_MS: '90000' })).clientPollIntervalMs,
    ).toBe(90_000);
  });

  it("refuses a fleet cadence the web client's reader would ignore", () => {
    expect(() => loadConfig(env({ FIRE_WATCH_CLIENT_POLL_INTERVAL_MS: '4999' }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(env({ FIRE_WATCH_CLIENT_POLL_INTERVAL_MS: '1800001' }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(env({ FIRE_WATCH_CLIENT_POLL_INTERVAL_MS: '45s' }))).toThrow(
      /FIRE_WATCH_CLIENT_POLL_INTERVAL_MS/,
    );
    expect(
      loadConfig(env({ FIRE_WATCH_CLIENT_POLL_INTERVAL_MS: '5000' })).clientPollIntervalMs,
    ).toBe(5_000);
    expect(
      loadConfig(env({ FIRE_WATCH_CLIENT_POLL_INTERVAL_MS: '1800000' })).clientPollIntervalMs,
    ).toBe(1_800_000);
  });

  it('has no static snapshot copy unless one is published', () => {
    expect(loadConfig(env()).staticSnapshotUrl).toBeNull();
    expect(loadConfig(env({ FIRE_WATCH_STATIC_SNAPSHOT_URL: '' })).staticSnapshotUrl).toBeNull();
    expect(
      loadConfig(env({ FIRE_WATCH_STATIC_SNAPSHOT_URL: 'https://static.example/snapshot.json' }))
        .staticSnapshotUrl,
    ).toBe('https://static.example/snapshot.json');
  });

  it('refuses a static URL the fleet could not fetch, naming the variable', () => {
    expect(() => loadConfig(env({ FIRE_WATCH_STATIC_SNAPSHOT_URL: '/snapshot.json' }))).toThrow(
      /FIRE_WATCH_STATIC_SNAPSHOT_URL/,
    );
    expect(() =>
      loadConfig(env({ FIRE_WATCH_STATIC_SNAPSHOT_URL: 'ftp://static.example/snapshot.json' })),
    ).toThrow(/FIRE_WATCH_STATIC_SNAPSHOT_URL/);
  });
});

describe('loadConfig — alert channels', () => {
  const PUSH = {
    FIRE_WATCH_VAPID_PUBLIC_KEY: 'BPublicKeyPublicKeyPublicKey',
    FIRE_WATCH_VAPID_PRIVATE_KEY: 'PrivateKeyPrivateKeyPrivateKey',
    FIRE_WATCH_VAPID_SUBJECT: 'mailto:alerts@example.invalid',
  };
  const SES = {
    FIRE_WATCH_SES_REGION: 'eu-central-1',
    FIRE_WATCH_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    FIRE_WATCH_SES_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    FIRE_WATCH_SES_FROM_ADDRESS: 'alerts@alerts.example.invalid',
  };

  it('runs with no provider at all rather than inventing one', () => {
    expect(loadConfig(env()).alertChannels).toEqual({ webPush: null, telegram: null, email: null });
  });

  it('reads each provider whole, trimming what an env file leaves behind', () => {
    const config = loadConfig(
      env({
        ...PUSH,
        FIRE_WATCH_TELEGRAM_BOT_TOKEN: ' 123:abc ',
        ...SES,
        FIRE_WATCH_SES_CONFIGURATION_SET: 'alerts',
      }),
    );
    expect(config.alertChannels).toEqual({
      webPush: {
        publicKey: 'BPublicKeyPublicKeyPublicKey',
        privateKey: 'PrivateKeyPrivateKeyPrivateKey',
        subject: 'mailto:alerts@example.invalid',
      },
      telegram: { botToken: '123:abc' },
      email: {
        region: 'eu-central-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        fromAddress: 'alerts@alerts.example.invalid',
        configurationSetName: 'alerts',
      },
    });
    expect(loadConfig(env(SES)).alertChannels.email?.configurationSetName).toBeNull();
  });

  it('refuses half a provider, naming the missing variables and never a value', () => {
    const { FIRE_WATCH_VAPID_PRIVATE_KEY: _omitted, ...halfPush } = PUSH;
    let thrown: unknown;
    try {
      loadConfig(env(halfPush));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const text = thrown instanceof Error ? thrown.message : '';
    expect(text).toContain('missing: FIRE_WATCH_VAPID_PRIVATE_KEY');
    expect(text).not.toContain(PUSH.FIRE_WATCH_VAPID_PUBLIC_KEY);

    expect(() => loadConfig(env({ ...SES, FIRE_WATCH_SES_SECRET_ACCESS_KEY: '  ' }))).toThrow(
      /missing: FIRE_WATCH_SES_SECRET_ACCESS_KEY/,
    );
  });

  it('refuses a configuration set with no SES channel to belong to', () => {
    expect(() => loadConfig(env({ FIRE_WATCH_SES_CONFIGURATION_SET: 'alerts' }))).toThrow(
      /FIRE_WATCH_SES_CONFIGURATION_SET is set but the SES channel is not configured/,
    );
  });

  it('says which channels have a provider without printing a credential', () => {
    const bare = describeConfig(loadConfig(env()));
    expect(bare['push_channel']).toBe('<not configured>');
    expect(bare['telegram_channel']).toBe('<not configured>');
    expect(bare['email_channel']).toBe('<not configured>');

    const described = describeConfig(
      loadConfig(env({ ...PUSH, FIRE_WATCH_TELEGRAM_BOT_TOKEN: '123:abc', ...SES })),
    );
    expect(described['push_channel']).toBe('<configured, public key BPublicKeyPublicKeyPublicKey>');
    expect(described['telegram_channel']).toBe('<configured>');
    expect(described['email_channel']).toBe(
      '<configured, eu-central-1, from alerts@alerts.example.invalid>',
    );
    const text = JSON.stringify(described);
    expect(text).not.toContain(PUSH.FIRE_WATCH_VAPID_PRIVATE_KEY);
    expect(text).not.toContain('123:abc');
    expect(text).not.toContain(SES.FIRE_WATCH_SES_SECRET_ACCESS_KEY);
    expect(text).not.toContain(SES.FIRE_WATCH_SES_ACCESS_KEY_ID);
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

  it('says where the context state lives and which upstreams it refreshes from', () => {
    // All three are configuration, not secrets — the EFFIS and ECMWF endpoints are open
    // services, and the state dir is what an operator greps for first.
    const bare = describeConfig(loadConfig(env()));
    expect(bare['state_dir']).toBe('<not configured>');
    expect(bare['effis_base_url']).toBe('https://maps.effis.emergency.copernicus.eu/effis');
    expect(bare['ecmwf_base_url']).toBe('https://data.ecmwf.int/forecasts');

    const configured = describeConfig(
      loadConfig(env({ FIRE_WATCH_STATE_DIR: '/var/lib/fire-watch' })),
    );
    expect(configured['state_dir']).toBe('/var/lib/fire-watch');
  });

  it('says what the fleet is being told, none of which is a secret', () => {
    const bare = describeConfig(loadConfig(env()));
    expect(bare['sse_enabled']).toBe('true');
    expect(bare['client_poll_interval_ms']).toBe('45000');
    expect(bare['static_snapshot_url']).toBe('<not configured>');

    const killed = describeConfig(
      loadConfig(
        env({
          FIRE_WATCH_SSE_ENABLED: 'false',
          FIRE_WATCH_STATIC_SNAPSHOT_URL: 'https://static.example/snapshot.json',
        }),
      ),
    );
    expect(killed['sse_enabled']).toBe('false');
    expect(killed['static_snapshot_url']).toBe('https://static.example/snapshot.json');
  });
});

const IMAGERY_TEMPLATE = 'https://tiles.example.test/imagery/tile/{z}/{y}/{x}';
const IMAGERY_KEY = 'AAPK-secret-imagery-key';

describe('loadConfig — imagery (TASKS G6)', () => {
  it('is keyless and unarmed when nothing is set', () => {
    expect(loadConfig(env()).imagery).toEqual({ handles: null, ceilingTiles: null });
  });

  it('reads the handles and the ceiling, trimmed', () => {
    const config = loadConfig(
      env({
        [ARCGIS_API_KEY_ENV]: ` ${IMAGERY_KEY} `,
        [ARCGIS_TILE_URL_ENV]: IMAGERY_TEMPLATE,
        [ARCGIS_TILE_CEILING_ENV]: '1500000',
      }),
    );
    expect(config.imagery).toEqual({
      handles: { tile_url_template: IMAGERY_TEMPLATE, api_key: IMAGERY_KEY },
      ceilingTiles: 1_500_000,
    });
  });

  it('keeps a configured key unarmed until a ceiling is chosen', () => {
    const config = loadConfig(
      env({ [ARCGIS_API_KEY_ENV]: 'k', [ARCGIS_TILE_URL_ENV]: IMAGERY_TEMPLATE }),
    );
    expect(config.imagery.ceilingTiles).toBeNull();
  });

  it('refuses half a group, a bad template and a bad key', () => {
    expect(() => loadConfig(env({ [ARCGIS_API_KEY_ENV]: 'k' }))).toThrow(
      /configured together or not at all/,
    );
    expect(() => loadConfig(env({ [ARCGIS_TILE_URL_ENV]: IMAGERY_TEMPLATE }))).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        env({ [ARCGIS_API_KEY_ENV]: 'k', [ARCGIS_TILE_URL_ENV]: 'http://x.test/{z}/{y}/{x}' }),
      ),
    ).toThrow(/https template/);
    expect(() =>
      loadConfig(env({ [ARCGIS_API_KEY_ENV]: 'a&b', [ARCGIS_TILE_URL_ENV]: IMAGERY_TEMPLATE })),
    ).toThrow(/URL-safe/);
  });

  it('never echoes a refused key', () => {
    const key = 'secret&key';
    try {
      loadConfig(env({ [ARCGIS_API_KEY_ENV]: key, [ARCGIS_TILE_URL_ENV]: IMAGERY_TEMPLATE }));
      expect.unreachable('a bad key must be refused');
    } catch (thrown: unknown) {
      expect((thrown as Error).message).not.toContain(key);
    }
  });

  it('refuses a ceiling that is not an integer strictly below the free tier', () => {
    for (const raw of ['0', '2000000', '1.5', '1e6', '-1', 'lots']) {
      expect(() => loadConfig(env({ [ARCGIS_TILE_CEILING_ENV]: raw })), raw).toThrow(ConfigError);
    }
    expect(loadConfig(env({ [ARCGIS_TILE_CEILING_ENV]: '1999999' })).imagery.ceilingTiles).toBe(
      1_999_999,
    );
  });
});

describe('describeConfig — imagery (TASKS G6)', () => {
  it('says whether a key is set, never the key', () => {
    const bare = describeConfig(loadConfig(env()));
    expect(bare['imagery_key']).toBe('<not configured>');
    expect(bare['imagery_tile_url']).toBe('<not configured>');
    expect(bare['imagery_ceiling_tiles']).toBe('<unarmed>');

    const described = describeConfig(
      loadConfig(
        env({
          [ARCGIS_API_KEY_ENV]: IMAGERY_KEY,
          [ARCGIS_TILE_URL_ENV]: IMAGERY_TEMPLATE,
          [ARCGIS_TILE_CEILING_ENV]: '1500000',
        }),
      ),
    );
    expect(described['imagery_key']).toBe('<configured>');
    expect(described['imagery_tile_url']).toBe(IMAGERY_TEMPLATE);
    expect(described['imagery_ceiling_tiles']).toBe('1500000');
    expect(JSON.stringify(described)).not.toContain(IMAGERY_KEY);
  });
});

describe('loadConfig — sign-in (I1)', () => {
  const SES_EU = {
    FIRE_WATCH_SES_REGION: 'eu-central-1',
    FIRE_WATCH_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    FIRE_WATCH_SES_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    FIRE_WATCH_SES_FROM_ADDRESS: 'alerts@alerts.example.invalid',
  };
  const MAIL = {
    FIRE_WATCH_AUTH_MAIL_FROM: 'sign-in@auth.example.invalid',
    FIRE_WATCH_AUTH_MAIL_DOMAIN: 'Auth.Example.invalid',
    FIRE_WATCH_AUTH_LANDING_URL: 'https://app.example.invalid/sign-in',
    FIRE_WATCH_AUTH_ALLOWED_ORIGINS: 'https://app.example.invalid, https://www.example.invalid',
  };
  const ON = { FIRE_WATCH_AUTH_ENABLED: 'true' };

  function refusal(overrides: Environment): string {
    try {
      loadConfig(env(overrides));
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    throw new Error('expected loadConfig to refuse');
  }

  it('is off by default, even with the whole mailer configured', () => {
    expect(loadConfig(env()).auth).toEqual({ enabled: false });
    expect(loadConfig(env({ ...MAIL, ...SES_EU })).auth).toEqual({ enabled: false });
    expect(loadConfig(env({ ...MAIL, ...SES_EU, FIRE_WATCH_AUTH_ENABLED: 'false' })).auth).toEqual({
      enabled: false,
    });
  });

  it('reads the mailer when enabled', () => {
    const { auth } = loadConfig(env({ ...ON, ...MAIL, ...SES_EU }));
    expect(auth).toEqual({
      enabled: true,
      fromAddress: 'sign-in@auth.example.invalid',
      mailDomain: 'auth.example.invalid',
      landingUrl: 'https://app.example.invalid/sign-in',
      allowedOrigins: ['https://app.example.invalid', 'https://www.example.invalid'],
      ses: {
        region: 'eu-central-1',
        accessKeyId: SES_EU.FIRE_WATCH_SES_ACCESS_KEY_ID,
        secretAccessKey: SES_EU.FIRE_WATCH_SES_SECRET_ACCESS_KEY,
        fromAddress: 'alerts@alerts.example.invalid',
        configurationSetName: null,
      },
    });
  });

  it('refuses enabled with no mailer, naming every missing variable and no default', () => {
    const message = refusal(ON);
    expect(message).toMatch(
      /FIRE_WATCH_AUTH_ENABLED is true but the sign-in mailer is not configured/u,
    );
    for (const name of [...Object.keys(MAIL), ...Object.keys(SES_EU)]) {
      expect(message).toContain(name);
    }
  });

  it('refuses enabled with the mail group but without SES credentials', () => {
    const message = refusal({ ...ON, ...MAIL });
    expect(message).toContain('FIRE_WATCH_SES_SECRET_ACCESS_KEY');
    expect(message).not.toContain('FIRE_WATCH_AUTH_MAIL_FROM');
  });

  it('refuses half the mail group, flag on or off, never quoting a value', () => {
    const { FIRE_WATCH_AUTH_LANDING_URL: _omitted, ...partial } = MAIL;
    const on = refusal({ ...ON, ...partial, ...SES_EU });
    expect(on).toMatch(
      /^FIRE_WATCH_AUTH_ENABLED is true but .*missing: FIRE_WATCH_AUTH_LANDING_URL/u,
    );
    const off = refusal({ ...partial });
    expect(off).toContain('missing: FIRE_WATCH_AUTH_LANDING_URL');
    expect(on).not.toContain(SES_EU.FIRE_WATCH_SES_SECRET_ACCESS_KEY);
  });

  it('refuses a non-EU SES region', () => {
    expect(refusal({ ...ON, ...MAIL, ...SES_EU, FIRE_WATCH_SES_REGION: 'us-east-1' })).toMatch(
      /not an EU region/u,
    );
  });

  it('refuses a sender off the auth-mail domain', () => {
    expect(
      refusal({ ...ON, ...MAIL, ...SES_EU, FIRE_WATCH_AUTH_MAIL_FROM: 'x@alerts.example.invalid' }),
    ).toMatch(/must be an address on FIRE_WATCH_AUTH_MAIL_DOMAIN/u);
  });

  it('refuses a landing URL that is not https, has a fragment or is off the allowed origins', () => {
    const base = { ...ON, ...MAIL, ...SES_EU };
    expect(
      refusal({ ...base, FIRE_WATCH_AUTH_LANDING_URL: 'http://app.example.invalid/sign-in' }),
    ).toMatch(/must be https/u);
    expect(
      refusal({ ...base, FIRE_WATCH_AUTH_LANDING_URL: 'https://app.example.invalid/#x' }),
    ).toMatch(/no fragment/u);
    expect(
      refusal({ ...base, FIRE_WATCH_AUTH_LANDING_URL: 'https://other.example.invalid/sign-in' }),
    ).toMatch(/must include the origin of FIRE_WATCH_AUTH_LANDING_URL/u);
  });

  it('refuses an allowed origin with a path or a trailing slash', () => {
    const base = { ...ON, ...MAIL, ...SES_EU };
    for (const origins of ['https://app.example.invalid/', 'https://app.example.invalid/x']) {
      expect(refusal({ ...base, FIRE_WATCH_AUTH_ALLOWED_ORIGINS: origins })).toMatch(
        /exact https origins/u,
      );
    }
  });

  it('describes the mailer without its credentials', () => {
    const described = describeConfig(loadConfig(env({ ...ON, ...MAIL, ...SES_EU })));
    expect(described['auth_enabled']).toBe('true');
    expect(described['auth_mail']).toBe(
      '<configured, eu-central-1, from sign-in@auth.example.invalid, landing https://app.example.invalid/sign-in>',
    );
    const text = JSON.stringify(described);
    expect(text).not.toContain(SES_EU.FIRE_WATCH_SES_SECRET_ACCESS_KEY);
    expect(describeConfig(loadConfig(env()))['auth_mail']).toBe('<not enabled>');
  });
});
