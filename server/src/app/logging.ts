/**
 * The one way a fire-watch process writes a log line (TASKS C8; OPERATIONS §8.3).
 *
 * Every entrypoint used to call `process.std{out,err}.write` directly. That is fine until
 * one of the strings being written turns out to contain a credential — and the FIRMS map
 * key travels as a *URL path segment* (`…/api/area/csv/<MAP_KEY>/…`), so it can arrive
 * inside a fetch error, a cause chain or a stack without any code having decided to log a
 * secret. A choke point makes that structural: the redactor runs on the way out, once, on
 * whatever the caller built, so a new call site cannot forget it and a reporter that
 * serialized its own line is covered too.
 *
 * Secrets come from the **environment**, not from the parsed config, on purpose: the log
 * line most likely to quote a secret back is the one reporting that config *failed*, and
 * that line is written when no `ServerConfig` exists. Reading `process.env` here costs
 * nothing and covers the fatal path from the first millisecond of the process.
 *
 * Personal data has no environment variable to read, so it is the redactor's free-text
 * leg (`core/observability/free-text.ts`) that keeps an e-mail address or a labelled
 * Telegram chat id echoed by a driver or provider error off the log line.
 *
 * pino is not a dependency (C8: no new packages). If it is ever adopted, this module is
 * the file that changes: `redactor.value` becomes its `formatters.log` and `redactor.text`
 * its `redact.censor`; `server/src/core/observability/redact.ts` and every call site below
 * stay as they are.
 */

import { canonicalJson } from '../core/determinism/canonical-json.js';
import { createRedactor, type Redactor } from '../core/observability/redact.js';
import type { Environment } from './config.js';

/**
 * The variables whose values must never appear in a log line (OPERATIONS §8.1). Adding a
 * secret to `config.ts` means adding its variable here in the same change — the list is
 * short enough to keep honest, and a secret missing from it still gets the shape-based
 * leg of the redactor rather than nothing.
 */
export const SECRET_ENV_VARS = [
  'FIRMS_MAP_KEY',
  'DATABASE_URL',
  // The ping URL *is* the credential: whoever holds it can silence the dead-man's switch.
  'FIRE_WATCH_HEARTBEAT_URL',
  // The backup's write-only token and the restore's separate read token (C6).
  'FIRE_WATCH_BACKUP_R2_ACCESS_KEY_ID',
  'FIRE_WATCH_BACKUP_R2_SECRET_ACCESS_KEY',
  'FIRE_WATCH_RESTORE_R2_ACCESS_KEY_ID',
  'FIRE_WATCH_RESTORE_R2_SECRET_ACCESS_KEY',
  // A path, not the key — but it says where the key is, so it is kept out of logs too.
  'FIRE_WATCH_RESTORE_AGE_IDENTITY',
  // The SES pair, shared by the email alert channel and the sign-in mailer (I1). The id is
  // not a secret on its own, but half a credential in a log is an invitation to find the
  // other half.
  'FIRE_WATCH_SES_ACCESS_KEY_ID',
  'FIRE_WATCH_SES_SECRET_ACCESS_KEY',
  // The zone-centre keys (I2). The active key and the retired list, which carries keys
  // inline as `id:base64`; the key ids alone are labels and are not listed.
  'FIRE_WATCH_ZONE_KEY',
  'FIRE_WATCH_ZONE_KEYS_RETIRED',
  // Added 2026-09-26: secrets `config.ts` and the channel/mirror configs read that were
  // missing from this list, so they had only the shape legs of the redactor. The bot
  // token's `:` defeats the URL leg's opaque-segment rule; the VAPID private key signs as
  // us; the ArcGIS key spends quota; the R2 mirror pair (E3) writes the public bucket.
  'FIRE_WATCH_TELEGRAM_BOT_TOKEN',
  'FIRE_WATCH_VAPID_PRIVATE_KEY',
  'FIRE_WATCH_ARCGIS_API_KEY',
  'FIRE_WATCH_R2_ACCESS_KEY_ID',
  'FIRE_WATCH_R2_SECRET_ACCESS_KEY',
  // A path, like the age identity: it says where the metrics bearer token lives.
  'FIRE_WATCH_METRICS_TOKEN_FILE',
] as const;

export function collectSecrets(env: Environment): string[] {
  const secrets: string[] = [];
  for (const name of SECRET_ENV_VARS) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== '') secrets.push(value);
  }
  return secrets;
}

export interface ProcessLog {
  /** One canonical-JSON line to stdout — the machine-readable stream. */
  event(record: Record<string, unknown>): void;
  /** One canonical-JSON line to stderr — lifecycle notes, kept out of piped output. */
  note(record: Record<string, unknown>): void;
  /** An already-serialized canonical-JSON line to stdout, redacted on the way out. */
  line(line: string): void;
  /** The last thing a failing process says: the error's message, redacted, on stderr. */
  fatal(error: unknown): void;
  /** For the rare call site that has to build a string itself. */
  readonly redactor: Redactor;
}

export interface ProcessLogOptions {
  readonly env: Environment;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
}

export function createProcessLog(options: ProcessLogOptions): ProcessLog {
  const redactor = createRedactor(collectSecrets(options.env));

  const emit = (write: (text: string) => void, record: Record<string, unknown>): void => {
    // Structural redaction *before* serialization, so a secret sitting in a nested field
    // is replaced by its length rather than by a mangled JSON string, and text redaction
    // is then a no-op second pass rather than the only defence.
    write(`${canonicalJson(redactor.value(record))}\n`);
  };

  return {
    event: (record) => {
      emit(options.writeOut, record);
    },
    note: (record) => {
      emit(options.writeErr, record);
    },
    line: (line) => {
      options.writeOut(`${redactor.text(line)}\n`);
    },
    fatal: (error) => {
      options.writeErr(`${redactor.error(error)}\n`);
    },
    redactor,
  };
}

/** The default wiring: this process's environment and its two standard streams. */
export function processLog(env: Environment = process.env): ProcessLog {
  return createProcessLog({
    env,
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
  });
}
