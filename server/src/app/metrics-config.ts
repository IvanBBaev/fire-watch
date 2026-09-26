/**
 * The internal metrics listener's settings (TASKS C5; OPERATIONS §3, §8, §9).
 *
 * In its own module, like `r2-mirror-config.ts`, because it is optional and shared by the
 * API and the worker, and because `app/config.ts` stays the one place for what every
 * process needs.
 *
 *   * FIRE_WATCH_METRICS_PORT — unset or empty: no metrics listener at all (the default,
 *     and what every existing deployment gets). Otherwise an integer in 1024–65535 that is
 *     not the API port: the metrics listener is never the public listener.
 *   * FIRE_WATCH_METRICS_HOST — the bind address, default `127.0.0.1`. In compose, where
 *     Alloy reaches the process over the compose network, this is `0.0.0.0` and the port
 *     is never published (OPERATIONS §9.2: the firewall passes 80/443 and SSH only).
 *   * FIRE_WATCH_METRICS_TOKEN_FILE — a file holding the bearer token the scraper must
 *     send. Optional on loopback; **required** on any other bind address, so a listener
 *     reachable from anything but this host is never unauthenticated. A file, not a
 *     variable: the same secret is mounted into Alloy as `bearer_token_file`, and neither
 *     side ever has it in an environment block or a `docker inspect` (OPERATIONS §8.2
 *     rule 2).
 *   * FIRE_WATCH_METRICS_TEXTFILE_DIR — for the backup CLI only: the directory it writes
 *     its `.prom` file into after a successful run, for Alloy's textfile collector. A
 *     one-shot job has no listener to scrape.
 *
 * **No token ever reaches an error or a log line.** {@link describeMetricsConfig} says only
 * whether one is set.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { Environment } from './config.js';
import { ConfigError } from './config.js';

export interface MetricsConfig {
  readonly port: number;
  readonly host: string;
  /** `null` only on a loopback bind. */
  readonly bearerToken: string | null;
}

/** Long enough that it was generated, not typed (`openssl rand -hex 32` gives 64). */
export const MIN_METRICS_TOKEN_LENGTH = 32;

const PORT = 'FIRE_WATCH_METRICS_PORT';
const HOST = 'FIRE_WATCH_METRICS_HOST';
const TOKEN_FILE = 'FIRE_WATCH_METRICS_TOKEN_FILE';
const TEXTFILE_DIR = 'FIRE_WATCH_METRICS_TEXTFILE_DIR';

const DEFAULT_HOST = '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const TOKEN_RE = /^[\x21-\x7e]+$/;

export type SecretFileReader = (path: string) => string;

const readSecretFile: SecretFileReader = (path) => readFileSync(path, 'utf8');

export function loadMetricsConfig(
  env: Environment,
  apiPort: number,
  readFile: SecretFileReader = readSecretFile,
): MetricsConfig | null {
  const portText = env[PORT]?.trim() ?? '';
  const hostText = env[HOST]?.trim() ?? '';
  const tokenPath = env[TOKEN_FILE]?.trim() ?? '';
  if (portText === '') {
    if (hostText !== '' || tokenPath !== '') {
      throw new ConfigError(`${hostText !== '' ? HOST : TOKEN_FILE} is set but ${PORT} is not`);
    }
    return null;
  }

  if (!/^\d+$/.test(portText)) throw new ConfigError(`${PORT} must be an integer`);
  const port = Number(portText);
  if (port < 1024 || port > 65_535) throw new ConfigError(`${PORT} must be in 1024-65535`);
  if (port === apiPort) {
    throw new ConfigError(`${PORT} must differ from the API port: metrics are never public`);
  }

  const host = hostText === '' ? DEFAULT_HOST : hostText;
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) throw new ConfigError(`${HOST} is not a bind address`);

  let bearerToken: string | null = null;
  if (tokenPath !== '') {
    if (!isAbsolute(tokenPath)) throw new ConfigError(`${TOKEN_FILE} must be an absolute path`);
    let text: string;
    try {
      text = readFile(tokenPath);
    } catch {
      throw new ConfigError(`${TOKEN_FILE} could not be read`);
    }
    bearerToken = text.trim();
    if (bearerToken.length < MIN_METRICS_TOKEN_LENGTH || !TOKEN_RE.test(bearerToken)) {
      throw new ConfigError(
        `${TOKEN_FILE} must hold one printable token of at least ${String(MIN_METRICS_TOKEN_LENGTH)} characters`,
      );
    }
  } else if (!LOOPBACK.has(host)) {
    throw new ConfigError(`${TOKEN_FILE} is required when ${HOST} is not loopback`);
  }

  return { port, host, bearerToken };
}

/** The backup CLI's textfile directory, or `null` when unset. */
export function loadMetricsTextfileDir(env: Environment): string | null {
  const dir = env[TEXTFILE_DIR]?.trim() ?? '';
  if (dir === '') return null;
  if (!isAbsolute(dir)) throw new ConfigError(`${TEXTFILE_DIR} must be an absolute path`);
  return dir;
}

/** Safe to print: never the token. */
export function describeMetricsConfig(config: MetricsConfig | null): Record<string, unknown> {
  if (config === null) return { metrics: 'unset' };
  return {
    metrics_host: config.host,
    metrics_port: config.port,
    metrics_token: config.bearerToken === null ? 'unset' : 'set',
  };
}
