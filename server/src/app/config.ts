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

import {
  CLIENT_POLL_INTERVAL_MAX_MS,
  CLIENT_POLL_INTERVAL_MIN_MS,
  type ClientImageryBlock,
  isImageryApiKey,
  isImageryTileUrlTemplate,
} from '@fire-watch/contracts';
import { isAbsolute } from 'node:path';

import { EFFIS_BASE_URL } from '../adapters/effis/effis-http-client.js';
import { FIRMS_BASE_URL } from '../adapters/firms/firms-http-client.js';
import { assertPingBaseUrl } from '../adapters/monitoring/healthchecks-heartbeat.js';
import { ECMWF_BASE_URL } from '../adapters/weather/ecmwf-http-client.js';
import {
  ARCGIS_FREE_TIER_TILES_PER_PERIOD,
  type ImageryMeterConfig,
} from '../core/imagery/imagery-meter.js';

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
   * The healthchecks.io ping base URL — validated and normalized (trailing slashes
   * stripped) by the heartbeat adapter's own gate, so a value that boots is exactly a
   * value the adapter can use — or `null` when this deployment has no dead-man's switch
   * (a developer box). A **secret** — never logged, only passed (OPERATIONS §3).
   */
  readonly heartbeatPingBaseUrl: string | null;
  /**
   * Where the context refresh jobs (C4) keep payloads and feed-status rows — the
   * directory the EFFIS proxy route serves `current.*` from. Absolute, because it is
   * shared between the worker (writes) and the API process (reads) and a relative path
   * would mean "wherever each process happened to start". `null` on a developer box:
   * the refresh loops simply do not run, and the health endpoint does not claim their
   * rows — absent budget-tracked work, not permanently-warn budget-tracked work.
   */
  readonly stateDir: string | null;
  /** Overridable so a smoke test can point the refresh at a stub; production leaves it unset. */
  readonly effisBaseUrl: string;
  readonly ecmwfBaseUrl: string;
  /**
   * The alert providers this deployment can reach. Each is `null` when its variables are
   * absent, and a channel with no provider is simply not wired — a developer box, or
   * A8's shadow season, sends nothing and says so in the logged config. The **values**
   * are tier-0 secrets (OPERATIONS §3): the VAPID private key alone can impersonate us
   * to every subscriber, the bot token can post as the bot, the AWS key can spend.
   */
  readonly alertChannels: AlertChannelsConfig;
  /**
   * Whether the worker runs the alert dispatch job (H4). Off unless set to exactly `true`:
   * turning it on is the moment real messages start leaving, and a flag that defaults to
   * sending is one a fresh host enables by accident. Enabling it without
   * {@link stateDir} is refused at start-up, because the kill switch lives there.
   */
  readonly alertDispatchEnabled: boolean;
  /**
   * The operator kill for the SSE tier (ADR-003 D1 "server-side transport control"):
   * `false` makes `/api/v1/client-config` say `poll` for everyone and the stream refuse
   * every connect, whatever the load says. The edge holds the document for 30 s and the
   * process restarts in seconds, so an environment change is as fast as a live toggle.
   */
  readonly sseEnabled: boolean;
  /**
   * The cadence `/api/v1/client-config` tells the fleet to poll the snapshot at. Bounded
   * to what the web client's reader accepts, because a value it ignores is a fleet that
   * silently keeps its build-time cadence.
   */
  readonly clientPollIntervalMs: number;
  /**
   * The public CDN URL of the static snapshot copy (ADR-003 A1.2), handed to the fleet
   * verbatim, or `null` when there is none yet. Not a secret — every client is told it.
   */
  readonly staticSnapshotUrl: string | null;
  /**
   * The imagery tripwire's inputs (ADR-001 A1.3/A2.3, TASKS G6):
   *
   *   FIRE_WATCH_ARCGIS_API_KEY            the ArcGIS Location Platform client key
   *   FIRE_WATCH_ARCGIS_IMAGERY_TILE_URL   the https raster tile template, `{z}`/`{y}`/`{x}`
   *   FIRE_WATCH_ARCGIS_TILE_CEILING       tiles per quota period at which imagery turns off
   *
   * The key and the template come together or not at all, and there is no default
   * template: which ArcGIS endpoint serves World Imagery to this account is part of
   * provisioning the key, and a guessed URL would be a toggle that shows broken tiles.
   * Neither set means imagery does not exist. The key is handed to every browser that is
   * offered imagery (it is a referrer-restricted client key), but it is still a credential
   * that spends quota, so it is never logged.
   *
   * The ceiling is the founder decision A2.3 leaves open. Unset is valid and means
   * *unarmed*: imagery stays off until someone chooses a number. Set means an integer
   * strictly below the 2M free tier. The requirement for {@link stateDir} is checked where
   * the meter is built (`imagery-config.ts`), not here, because only the API process runs it.
   */
  readonly imagery: ImageryMeterConfig;
  /**
   * First-party sign-in (TASKS I1): whether the API registers `/api/v1/auth/*`, and the
   * sender it mails magic links from.
   *
   *   FIRE_WATCH_AUTH_ENABLED           `true` registers the routes; off unless set
   *   FIRE_WATCH_AUTH_MAIL_FROM         the verified sender of sign-in mail
   *   FIRE_WATCH_AUTH_MAIL_DOMAIN       the auth-mail subdomain the sender must sit on
   *   FIRE_WATCH_AUTH_LANDING_URL       the https page a link opens; the token rides its fragment
   *                                     (canonically `https://<host>/sign-in/continue`)
   *   FIRE_WATCH_AUTH_ALLOWED_ORIGINS   comma-separated exact origins the web app is served from
   *
   * None of the four has a default: the sender, the subdomain and the landing page are the
   * founder's choice, and a guessed value would be mail from an address nobody verified or a
   * link to a page that does not exist. The four come together or not at all. Enabling
   * sign-in without them — or without the `FIRE_WATCH_SES_*` credentials the mailer reuses,
   * or with an SES region outside the EU — is refused at start-up, by name.
   */
  readonly auth: AuthConfig;
}

/** Sign-in is off, or on with everything its mailer and routes need. */
export type AuthConfig =
  { readonly enabled: false } | ({ readonly enabled: true } & AuthMailConfig);

export interface AuthMailConfig {
  readonly fromAddress: string;
  /** Lower-cased; `fromAddress` is on exactly this domain. */
  readonly mailDomain: string;
  /** Absolute https URL with no fragment; the link is this plus `#token=…`. */
  readonly landingUrl: string;
  /** Exact `scheme://host[:port]` origins; the landing URL's origin is one of them. */
  readonly allowedOrigins: readonly string[];
  /** The SES credentials and region, shared with the email alert channel; EU region only. */
  readonly ses: EmailConfig;
}

export const AUTH_ENABLED_ENV = 'FIRE_WATCH_AUTH_ENABLED';

export const ARCGIS_API_KEY_ENV = 'FIRE_WATCH_ARCGIS_API_KEY';
export const ARCGIS_TILE_URL_ENV = 'FIRE_WATCH_ARCGIS_IMAGERY_TILE_URL';
export const ARCGIS_TILE_CEILING_ENV = 'FIRE_WATCH_ARCGIS_TILE_CEILING';

export interface AlertChannelsConfig {
  readonly webPush: WebPushConfig | null;
  readonly telegram: TelegramConfig | null;
  readonly email: EmailConfig | null;
}

export interface WebPushConfig {
  /** Raw base64url P-256 point; what the client subscribes with. Not a secret. */
  readonly publicKey: string;
  /** Raw base64url P-256 scalar. Rotating it invalidates every subscription. */
  readonly privateKey: string;
  /** `mailto:` or `https:` contact for the push services (RFC 8292 §2.1). */
  readonly subject: string;
}

export interface TelegramConfig {
  readonly botToken: string;
}

export interface EmailConfig {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fromAddress: string;
  /** SES configuration set for bounce/complaint events, or `null` for the account default. */
  readonly configurationSetName: string | null;
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

/** The web client's own default, so an unset variable changes nothing the fleet does. */
export const DEFAULT_CLIENT_POLL_INTERVAL_MS = 45_000;

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
    stateDir: readStateDir(env['FIRE_WATCH_STATE_DIR']?.trim()),
    effisBaseUrl: readHttpBaseUrl(
      env['FIRE_WATCH_EFFIS_BASE_URL']?.trim(),
      'FIRE_WATCH_EFFIS_BASE_URL',
      EFFIS_BASE_URL,
    ),
    ecmwfBaseUrl: readHttpBaseUrl(
      env['FIRE_WATCH_ECMWF_BASE_URL']?.trim(),
      'FIRE_WATCH_ECMWF_BASE_URL',
      ECMWF_BASE_URL,
    ),
    alertChannels: readAlertChannels(env),
    alertDispatchEnabled: readFlag(
      env['FIRE_WATCH_ALERT_DISPATCH_ENABLED']?.trim(),
      'FIRE_WATCH_ALERT_DISPATCH_ENABLED',
      false,
    ),
    sseEnabled: readFlag(env['FIRE_WATCH_SSE_ENABLED']?.trim(), 'FIRE_WATCH_SSE_ENABLED', true),
    clientPollIntervalMs: readClientPollInterval(env['FIRE_WATCH_CLIENT_POLL_INTERVAL_MS']?.trim()),
    staticSnapshotUrl: readStaticSnapshotUrl(env['FIRE_WATCH_STATIC_SNAPSHOT_URL']?.trim()),
    imagery: {
      handles: readImageryHandles(env),
      ceilingTiles: readImageryCeiling(env[ARCGIS_TILE_CEILING_ENV]?.trim()),
    },
    auth: readAuth(env),
  };
}

function readImageryHandles(env: Environment): ClientImageryBlock | null {
  const key = env[ARCGIS_API_KEY_ENV]?.trim() ?? '';
  const template = env[ARCGIS_TILE_URL_ENV]?.trim() ?? '';
  if (key === '' && template === '') return null;
  if (key === '' || template === '') {
    throw new ConfigError(
      `${ARCGIS_API_KEY_ENV} and ${ARCGIS_TILE_URL_ENV} are configured together or not at all`,
    );
  }
  // The key is never echoed back, even in a refusal — only what is wrong with it.
  if (!isImageryApiKey(key)) {
    throw new ConfigError(`${ARCGIS_API_KEY_ENV} must be URL-safe characters only`);
  }
  if (!isImageryTileUrlTemplate(template)) {
    throw new ConfigError(
      `${ARCGIS_TILE_URL_ENV} must be an https template with {z}, {x} and {y} and no token, got ${JSON.stringify(template)}`,
    );
  }
  return { tile_url_template: template, api_key: key };
}

function readImageryCeiling(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value >= ARCGIS_FREE_TIER_TILES_PER_PERIOD) {
    throw new ConfigError(
      `${ARCGIS_TILE_CEILING_ENV} must be an integer in [1, ${String(ARCGIS_FREE_TIER_TILES_PER_PERIOD)}), got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Exactly `true` or `false`, case-insensitively. Anything else — `0`, `off`, `no`, a typo —
 * is refused rather than read as one of them: this flag turns a tier off for the whole
 * fleet, and "I set it to `off` and it stayed on" is not a mistake to discover mid-season.
 */
function readFlag(raw: string | undefined, name: string, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const lowered = raw.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  throw new ConfigError(`${name} must be "true" or "false", got ${JSON.stringify(raw)}`);
}

/** The bounds are the web reader's (contracts): a value outside them would be ignored there. */
function readClientPollInterval(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_CLIENT_POLL_INTERVAL_MS;
  const ms = Number(raw);
  if (
    !Number.isInteger(ms) ||
    ms < CLIENT_POLL_INTERVAL_MIN_MS ||
    ms > CLIENT_POLL_INTERVAL_MAX_MS
  ) {
    throw new ConfigError(
      `FIRE_WATCH_CLIENT_POLL_INTERVAL_MS must be an integer between ` +
        `${String(CLIENT_POLL_INTERVAL_MIN_MS)} and ${String(CLIENT_POLL_INTERVAL_MAX_MS)} ms, ` +
        `got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

/**
 * Unset is a valid answer — there is no static copy until the publisher exists. Set is
 * an absolute http(s) URL, passed on verbatim: the fleet fetches exactly this string.
 */
function readStaticSnapshotUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  return readHttpBaseUrl(raw, 'FIRE_WATCH_STATIC_SNAPSHOT_URL', raw);
}

const WEB_PUSH_VARIABLES = [
  'FIRE_WATCH_VAPID_PUBLIC_KEY',
  'FIRE_WATCH_VAPID_PRIVATE_KEY',
  'FIRE_WATCH_VAPID_SUBJECT',
] as const;
const TELEGRAM_VARIABLES = ['FIRE_WATCH_TELEGRAM_BOT_TOKEN'] as const;
const EMAIL_VARIABLES = [
  'FIRE_WATCH_SES_REGION',
  'FIRE_WATCH_SES_ACCESS_KEY_ID',
  'FIRE_WATCH_SES_SECRET_ACCESS_KEY',
  'FIRE_WATCH_SES_FROM_ADDRESS',
] as const;

/**
 * A provider is configured by all of its variables or by none of them. Half a provider —
 * a public key with no private key, a region with no credentials — is refused by name,
 * because "set two of three and the channel silently stays off" is how a season starts
 * with no push at all and nobody notices until the first fire.
 *
 * Only presence is checked here. The *shape* of each value (is that a P-256 point, does
 * the public key belong to the private key, is that a bot token) is the adapter's own
 * gate, run when the channel is built in `alert-wiring.ts`; a copy of it here would be
 * a weaker copy, for the reason {@link readHeartbeatUrl} gives.
 */
function readAlertChannels(env: Environment): AlertChannelsConfig {
  const webPush = readGroup(env, WEB_PUSH_VARIABLES);
  const telegram = readGroup(env, TELEGRAM_VARIABLES);
  const email = readGroup(env, EMAIL_VARIABLES);
  const configurationSet = env['FIRE_WATCH_SES_CONFIGURATION_SET']?.trim();
  if (email === null && configurationSet !== undefined && configurationSet !== '') {
    throw new ConfigError(
      'FIRE_WATCH_SES_CONFIGURATION_SET is set but the SES channel is not configured; ' +
        `set ${EMAIL_VARIABLES.join(', ')} or remove it.`,
    );
  }
  return {
    webPush:
      webPush === null
        ? null
        : {
            publicKey: webPush.FIRE_WATCH_VAPID_PUBLIC_KEY,
            privateKey: webPush.FIRE_WATCH_VAPID_PRIVATE_KEY,
            subject: webPush.FIRE_WATCH_VAPID_SUBJECT,
          },
    telegram: telegram === null ? null : { botToken: telegram.FIRE_WATCH_TELEGRAM_BOT_TOKEN },
    email:
      email === null
        ? null
        : {
            region: email.FIRE_WATCH_SES_REGION,
            accessKeyId: email.FIRE_WATCH_SES_ACCESS_KEY_ID,
            secretAccessKey: email.FIRE_WATCH_SES_SECRET_ACCESS_KEY,
            fromAddress: email.FIRE_WATCH_SES_FROM_ADDRESS,
            configurationSetName:
              configurationSet === undefined || configurationSet === '' ? null : configurationSet,
          },
  };
}

const AUTH_MAIL_VARIABLES = [
  'FIRE_WATCH_AUTH_MAIL_FROM',
  'FIRE_WATCH_AUTH_MAIL_DOMAIN',
  'FIRE_WATCH_AUTH_LANDING_URL',
  'FIRE_WATCH_AUTH_ALLOWED_ORIGINS',
] as const;

/** The SES regions that are in the EU all start `eu-` (EXTERNAL-ACCOUNTS row 20). */
const EU_SES_REGION_RE = /^eu-[a-z]+-\d$/;

/**
 * Off unless {@link AUTH_ENABLED_ENV} is exactly `true`. The mail group is all-or-none
 * whatever the flag says, like every other group; its shapes, the SES credentials and the
 * EU region are checked only when the flag is on, because only then is anything mailed.
 * No value is ever quoted back except the non-secret ones (a URL, an origin, a region).
 */
function readAuth(env: Environment): AuthConfig {
  const enabled = readFlag(env[AUTH_ENABLED_ENV]?.trim(), AUTH_ENABLED_ENV, false);
  let group: Readonly<Record<(typeof AUTH_MAIL_VARIABLES)[number], string>> | null;
  try {
    group = readGroup(env, AUTH_MAIL_VARIABLES);
  } catch (error) {
    if (!enabled) throw error;
    throw new ConfigError(`${AUTH_ENABLED_ENV} is true but ${(error as Error).message}`);
  }
  if (!enabled) return { enabled: false };

  const ses = readGroup(env, EMAIL_VARIABLES);
  const missing = [
    ...(group === null ? AUTH_MAIL_VARIABLES : []),
    ...(ses === null ? EMAIL_VARIABLES : []),
  ];
  if (group === null || ses === null) {
    throw new ConfigError(
      `${AUTH_ENABLED_ENV} is true but the sign-in mailer is not configured; ` +
        `missing: ${missing.join(', ')}. These have no defaults: the sender, its subdomain ` +
        'and the landing page are chosen when the auth-mail domain is provisioned.',
    );
  }

  const region = ses.FIRE_WATCH_SES_REGION;
  if (!EU_SES_REGION_RE.test(region)) {
    throw new ConfigError(
      `${AUTH_ENABLED_ENV} is true but FIRE_WATCH_SES_REGION is not an EU region ` +
        `(got ${JSON.stringify(region)}); sign-in mail is sent from the EU only.`,
    );
  }

  const mailDomain = group.FIRE_WATCH_AUTH_MAIL_DOMAIN.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(mailDomain)) {
    throw new ConfigError(
      'FIRE_WATCH_AUTH_MAIL_DOMAIN must be a domain name, e.g. auth.example.org',
    );
  }
  const fromAddress = group.FIRE_WATCH_AUTH_MAIL_FROM;
  const at = fromAddress.lastIndexOf('@');
  if (at <= 0 || /[\s<>",]/.test(fromAddress)) {
    throw new ConfigError('FIRE_WATCH_AUTH_MAIL_FROM must be a bare e-mail address');
  }
  if (fromAddress.slice(at + 1).toLowerCase() !== mailDomain) {
    throw new ConfigError(
      'FIRE_WATCH_AUTH_MAIL_FROM must be an address on FIRE_WATCH_AUTH_MAIL_DOMAIN',
    );
  }

  const landingUrl = readLandingUrl(group.FIRE_WATCH_AUTH_LANDING_URL);
  const allowedOrigins = readAllowedOrigins(group.FIRE_WATCH_AUTH_ALLOWED_ORIGINS);
  if (!allowedOrigins.includes(new URL(landingUrl).origin)) {
    throw new ConfigError(
      'FIRE_WATCH_AUTH_ALLOWED_ORIGINS must include the origin of FIRE_WATCH_AUTH_LANDING_URL: ' +
        'the landing page POSTs the token from there, and a foreign origin is refused.',
    );
  }

  const configurationSet = env['FIRE_WATCH_SES_CONFIGURATION_SET']?.trim();
  return {
    enabled: true,
    fromAddress,
    mailDomain,
    landingUrl,
    allowedOrigins,
    ses: {
      region,
      accessKeyId: ses.FIRE_WATCH_SES_ACCESS_KEY_ID,
      secretAccessKey: ses.FIRE_WATCH_SES_SECRET_ACCESS_KEY,
      fromAddress: ses.FIRE_WATCH_SES_FROM_ADDRESS,
      configurationSetName:
        configurationSet === undefined || configurationSet === '' ? null : configurationSet,
    },
  };
}

/**
 * https only, and no fragment or credentials: the token is appended as the fragment, and a
 * URL that already had one would carry two, while userinfo would put a secret in every mail.
 */
function readLandingUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      `FIRE_WATCH_AUTH_LANDING_URL must be an absolute URL, got ${JSON.stringify(raw)}`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new ConfigError(`FIRE_WATCH_AUTH_LANDING_URL must be https, got ${JSON.stringify(raw)}`);
  }
  if (raw.includes('#') || url.username !== '' || url.password !== '') {
    throw new ConfigError(
      'FIRE_WATCH_AUTH_LANDING_URL must carry no fragment and no credentials; the token is ' +
        'appended as the fragment',
    );
  }
  return url.href;
}

/** Each entry an exact https origin, as a browser sends it in `Origin` — no path, no slash. */
function readAllowedOrigins(raw: string): readonly string[] {
  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (origins.length === 0) {
    throw new ConfigError('FIRE_WATCH_AUTH_ALLOWED_ORIGINS must name at least one origin');
  }
  for (const origin of origins) {
    const parsed = parseUrlOrNull(origin);
    if (parsed === null || parsed.protocol !== 'https:' || parsed.origin !== origin) {
      throw new ConfigError(
        `FIRE_WATCH_AUTH_ALLOWED_ORIGINS entries must be exact https origins ` +
          `(scheme://host[:port], no path), got ${JSON.stringify(origin)}`,
      );
    }
  }
  return [...new Set(origins)];
}

function parseUrlOrNull(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** All of `names` (trimmed, non-empty) or `null` when all are absent; anything between throws. */
function readGroup<const Names extends readonly string[]>(
  env: Environment,
  names: Names,
): Readonly<Record<Names[number], string>> | null {
  const present: Partial<Record<Names[number], string>> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value === undefined || value === '') missing.push(name);
    else present[name as Names[number]] = value;
  }
  if (missing.length === names.length) return null;
  if (missing.length > 0) {
    throw new ConfigError(
      `${names.join(', ')} are configured together or not at all; missing: ${missing.join(', ')}`,
    );
  }
  return present as Readonly<Record<Names[number], string>>;
}

/**
 * Unset is a valid answer — a developer box runs no refresh jobs. Set means absolute:
 * the same directory is read by two processes with different working directories, so a
 * relative path would quietly split it into two.
 */
function readStateDir(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!isAbsolute(raw)) {
    throw new ConfigError(
      `FIRE_WATCH_STATE_DIR must be an absolute path, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
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
 * would page a stranger. Present goes through the *adapter's* own gate
 * ({@link assertPingBaseUrl}), not a local copy of it: a weaker copy here once accepted a
 * bare origin — an operator who pasted the host and forgot the ping key — which booted
 * cleanly and only died inside the worker, as a RangeError with no variable name and the
 * generic exit code instead of a ConfigError naming what to fix. Whatever the gate
 * refuses is re-thrown under the variable's name; its messages describe only the shape of
 * the problem, never the value, because the value is the secret itself.
 */
function readHeartbeatUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  try {
    // Returned normalized (trailing slashes stripped), so config and adapter agree on the
    // exact string — the adapter's log redaction matches on it verbatim.
    return assertPingBaseUrl(raw);
  } catch (error: unknown) {
    throw new ConfigError(
      `FIRE_WATCH_HEARTBEAT_URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
 * Exported for the backfill CLI, which reads the same variable with the same rules.
 */
export function readBaseUrl(raw: string | undefined): string {
  return readHttpBaseUrl(raw, 'FIRMS_BASE_URL', FIRMS_BASE_URL);
}

/** The same rule for every overridable endpoint, always naming the variable at fault. */
function readHttpBaseUrl(raw: string | undefined, name: string, fallback: string): string {
  if (raw === undefined || raw === '') return fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${name} must be http or https, got ${JSON.stringify(raw)}`);
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
    // Not secrets — a path and two open endpoints — and exactly what "why is the map's
    // FWI layer stale" needs answered from the logs.
    state_dir: config.stateDir ?? '<not configured>',
    effis_base_url: config.effisBaseUrl,
    ecmwf_base_url: config.ecmwfBaseUrl,
    // Whether each channel has a provider — the question "why did nothing go out" starts
    // with. The public key is the one value here that is public, and it is what the
    // subscribe route hands every browser, so it is worth having next to the answer.
    push_channel:
      config.alertChannels.webPush === null
        ? '<not configured>'
        : `<configured, public key ${config.alertChannels.webPush.publicKey}>`,
    telegram_channel: config.alertChannels.telegram === null ? '<not configured>' : '<configured>',
    email_channel:
      config.alertChannels.email === null
        ? '<not configured>'
        : `<configured, ${config.alertChannels.email.region}, from ${config.alertChannels.email.fromAddress}>`,
    alert_dispatch_enabled: String(config.alertDispatchEnabled),
    // The fleet-control inputs: the first question after "why is everyone polling".
    sse_enabled: String(config.sseEnabled),
    client_poll_interval_ms: String(config.clientPollIntervalMs),
    static_snapshot_url: config.staticSnapshotUrl ?? '<not configured>',
    // Whether a key is set, never the key; the template is not secret (the key travels
    // separately) and is what "why are the imagery tiles broken" needs answered.
    imagery_key: config.imagery.handles === null ? '<not configured>' : '<configured>',
    imagery_tile_url: config.imagery.handles?.tile_url_template ?? '<not configured>',
    imagery_ceiling_tiles:
      config.imagery.ceilingTiles === null ? '<unarmed>' : String(config.imagery.ceilingTiles),
    // The sender, the landing page and the origins are public by construction (every
    // sign-in mail shows the first two); the credentials are the email channel's, withheld.
    auth_enabled: String(config.auth.enabled),
    auth_mail: config.auth.enabled
      ? `<configured, ${config.auth.ses.region}, from ${config.auth.fromAddress}, landing ${config.auth.landingUrl}>`
      : '<not enabled>',
    auth_allowed_origins: config.auth.enabled
      ? config.auth.allowedOrigins.join(',')
      : '<not enabled>',
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
