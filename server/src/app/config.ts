/**
 * Runtime configuration, read from the environment and nowhere else.
 *
 * Secrets reach this process through the environment (OPERATIONS §8): there is no config
 * file to leak, no default to fall back to, and nothing here ever writes a value into a
 * message. A missing variable is reported by *name* only, and every missing one is
 * reported at once — discovering them one restart at a time, at 03:00, is how a ten-minute
 * outage becomes an hour-long one.
 *
 * `DATABASE_URL` is the same variable dbmate reads, on purpose: the process that applies
 * the migrations and the process that writes rows must not be able to disagree about which
 * database they mean.
 */

import { FIRMS_BASE_URL } from '../adapters/firms/firms-http-client.js';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface ServerConfig {
  /** `postgres://…`. Carries the password, so it is never logged, only passed. */
  readonly databaseUrl: string;
  /** The FIRMS Area API key. Travels as a URL path segment — see the client adapter. */
  readonly firmsMapKey: string;
  /**
   * Where the Area API lives. Overridable so a drill or a smoke test can point the same
   * binary at a stub; production leaves it unset, and the logged config says which it was.
   */
  readonly firmsBaseUrl: string;
  /**
   * The role the connection assumes after connecting. `fire_watch_app` is NOLOGIN and
   * holds only INSERT on the archive, so assuming it is what makes append-only a property
   * of the connection rather than a promise made by the code.
   */
  readonly databaseRole: string;
  /** Distinguishes this process in `pg_stat_activity` when a query has to be hunted down. */
  readonly applicationName: string;
  /** How often the worker polls. Ignored by the one-shot CLI, which runs a single cycle. */
  readonly pollIntervalMs: number;
  /** Where the probe surface listens (OPERATIONS §2). Ignored by the worker. */
  readonly apiPort: number;
  /**
   * Loopback by default: the API is reached through the reverse proxy, and a health
   * endpoint bound to `0.0.0.0` on a VM with a public address is a health endpoint the
   * whole internet can rate-limit us on.
   */
  readonly apiHost: string;
  /**
   * The request header our own edge *overwrites* with the real client IP (for Cloudflare,
   * `cf-connecting-ip`), lowercased, or `undefined` when callers reach the port directly.
   * The rate limiter keys on it. Safe only because the deployment's firewall lets nothing
   * but that edge reach the port — a header the wider internet can send is a rate-limit
   * key the caller picks.
   */
  readonly apiClientIpHeader: string | undefined;
  /**
   * The healthchecks.io ping base URL, or `null` when this deployment has no dead-man's
   * switch (a developer box). A **secret** — never logged, only passed (OPERATIONS §3).
   */
  readonly heartbeatPingBaseUrl: string | null;
}

const DEFAULT_DATABASE_ROLE = 'fire_watch_app';

/** Behind the proxy, so the number matters only to the compose file and the proxy config. */
export const DEFAULT_API_PORT = 8080;

const DEFAULT_API_HOST = '127.0.0.1';

/**
 * 10 minutes — the low end of the DATA-SOURCES §A1 cadence. Three live VIIRS sources at
 * that rate is 18 requests an hour against a quota of 5,000 per 10 minutes, so the cost
 * of polling often is latency on our side, not quota.
 */
export const DEFAULT_POLL_INTERVAL_MS = 600_000;

/** Below this the overlap window stops being the point and the quota starts being one. */
const MIN_POLL_INTERVAL_MS = 60_000;

/** Above this a source could go stale for longer than any freshness budget in §1.2. */
const MAX_POLL_INTERVAL_MS = 3_600_000;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: Environment, applicationName = 'fire-watch'): ServerConfig {
  const missing: string[] = [];

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  };

  const databaseUrl = required('DATABASE_URL');
  const firmsMapKey = required('FIRMS_MAP_KEY');

  if (missing.length > 0) {
    throw new ConfigError(
      `missing required environment variable(s): ${missing.join(', ')}. ` +
        'They are supplied by the VM env file, not by a file in the repository.',
    );
  }

  // Refused on *presence*, whatever the value. Both of its settings keyed the rate limiter
  // on a value an attacker could choose (client-written X-Forwarded-For) or share (the
  // proxy's socket address) — and a security-relevant variable that is silently ignored
  // looks exactly like one that works.
  if (env['FIRE_WATCH_TRUST_PROXY'] !== undefined) {
    throw new ConfigError(
      'FIRE_WATCH_TRUST_PROXY has been replaced by FIRE_WATCH_CLIENT_IP_HEADER ' +
        '(the header the edge overwrites with the real client IP); remove it from the environment.',
    );
  }

  return {
    databaseUrl,
    firmsMapKey,
    firmsBaseUrl: readBaseUrl(env['FIRMS_BASE_URL']?.trim()),
    databaseRole: readRole(env['FIRE_WATCH_DB_ROLE']?.trim()),
    applicationName,
    pollIntervalMs: readPollInterval(env['FIRE_WATCH_POLL_INTERVAL_MS']?.trim()),
    apiPort: readPort(env['FIRE_WATCH_API_PORT']?.trim()),
    apiHost: readHost(env['FIRE_WATCH_API_HOST']?.trim()),
    apiClientIpHeader: readClientIpHeader(env['FIRE_WATCH_CLIENT_IP_HEADER']),
    heartbeatPingBaseUrl: readHeartbeatUrl(env['FIRE_WATCH_HEARTBEAT_URL']?.trim()),
  };
}

function readHost(raw: string | undefined): string {
  return raw === undefined || raw === '' ? DEFAULT_API_HOST : raw;
}

/** A privileged port would mean the container runs as root for the sake of a number. */
function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_API_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new ConfigError(
      `FIRE_WATCH_API_PORT must be an integer between 1024 and 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

/**
 * Absent is a valid answer — a developer box has no dead-man's switch, and inventing one
 * would page a stranger. Present and malformed is not: the value is never echoed back,
 * because it is the secret itself.
 */
function readHeartbeatUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('FIRE_WATCH_HEARTBEAT_URL must be an absolute https URL');
  }
  if (url.protocol !== 'https:') {
    throw new ConfigError('FIRE_WATCH_HEARTBEAT_URL must be https');
  }
  return raw;
}

/**
 * Bounded on both sides. A typo that turns the cadence into 6 seconds burns the quota
 * for every key on the account; one that turns it into 6 hours makes the map quietly
 * wrong, which is worse than making it visibly absent.
 */
function readPollInterval(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_POLL_INTERVAL_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < MIN_POLL_INTERVAL_MS || ms > MAX_POLL_INTERVAL_MS) {
    throw new ConfigError(
      `FIRE_WATCH_POLL_INTERVAL_MS must be an integer between ${String(MIN_POLL_INTERVAL_MS)} ` +
        `and ${String(MAX_POLL_INTERVAL_MS)} ms, got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

/**
 * An absolute http(s) origin, because the key is appended to it as a path segment: a
 * relative or malformed value would put the MAP_KEY somewhere nobody audited.
 */
function readBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') return FIRMS_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`FIRMS_BASE_URL must be an absolute URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`FIRMS_BASE_URL must be http or https, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * The header the rate limiter keys on. Unset is a valid answer — a box reached directly
 * keys on the socket address. Set-but-empty is not: the operator meant something, and
 * guessing which something is how a limiter ends up keyed on nothing.
 *
 * `x-forwarded-for` and `forwarded` are refused *by name*: proxies append to those headers
 * rather than overwrite them, so the entry a limiter would read stays whatever the caller
 * wrote — no matter how trustworthy every proxy after it is. Only a header the edge
 * overwrites (for Cloudflare, `cf-connecting-ip`) can be a key the caller does not pick.
 */
function readClientIpHeader(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const header = raw.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(header)) {
    throw new ConfigError(
      `FIRE_WATCH_CLIENT_IP_HEADER must be a header name (letters, digits and dashes), ` +
        `got ${JSON.stringify(raw)}`,
    );
  }
  if (header === 'x-forwarded-for' || header === 'forwarded') {
    throw new ConfigError(
      `FIRE_WATCH_CLIENT_IP_HEADER must name a header the edge overwrites; ${header} is ` +
        'appended to by every proxy on the path, so keying on it hands the rate-limit key ' +
        'to the caller. Use the edge-owned header, e.g. cf-connecting-ip.',
    );
  }
  return header;
}

/**
 * The role reaches Postgres as a connection *startup option*, so it has to be a bare
 * identifier: anything else would be a way to smuggle further settings into the session.
 */
function readRole(role: string | undefined): string {
  if (role === undefined || role === '') return DEFAULT_DATABASE_ROLE;
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new ConfigError(
      `FIRE_WATCH_DB_ROLE must be a lowercase unquoted identifier, got ${JSON.stringify(role)}`,
    );
  }
  return role;
}

/**
 * A description safe to log. It exists so that "which database am I actually pointed at"
 * is answerable from the logs without the password ever being in them — and so that
 * nobody is tempted to log the config object itself to find out.
 */
export function describeConfig(config: ServerConfig): Record<string, string> {
  return {
    application_name: config.applicationName,
    database: redactUrl(config.databaseUrl),
    database_role: config.databaseRole,
    firms_map_key: `<${String(config.firmsMapKey.length)} characters>`,
    firms_base_url: config.firmsBaseUrl,
    poll_interval_ms: String(config.pollIntervalMs),
    api_listen: `${config.apiHost}:${String(config.apiPort)}`,
    // The header *name* is configuration worth logging; the addresses it will carry are not.
    client_ip_header: config.apiClientIpHeader ?? '<not configured>',
    // Whether, never which: the URL is the credential, so even its host is withheld.
    heartbeat: config.heartbeatPingBaseUrl === null ? '<not configured>' : '<configured>',
  };
}

function redactUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Unparseable is still not printable: it may be a DSN with `password=` in it.
    return '<unparseable DATABASE_URL>';
  }
  const user = url.username === '' ? '' : `${url.username}@`;
  return `${url.protocol}//${user}${url.host}${url.pathname}`;
}
