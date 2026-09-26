import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../core/determinism/canonical-json.js';
import { describeConfig, loadConfig, type Environment } from './config.js';
import { collectSecrets, createProcessLog, SECRET_ENV_VARS, type ProcessLog } from './logging.js';

/**
 * **These are not credentials.** Every one of them says so in its own text, and the
 * "random" parts are runs of zeroes. They are shaped like the real things — 32
 * alphanumerics for a FIRMS map key, a `user:password@host` DSN, an https URL whose path
 * *is* the healthchecks.io ping key — because shape is half of what the redactor matches
 * on, and a test using shapeless placeholders would pass while the real thing leaked.
 */
const FAKE_MAP_KEY = 'notarealfirmskey0000000000000000';
const FAKE_PASSWORD = 'notarealpassword0000';
const FAKE_DATABASE_URL = `postgres://fire_watch:${FAKE_PASSWORD}@db.invalid:5432/fire_watch`;
const FAKE_PING_KEY = 'notarealheartbeatkey00000000';
const FAKE_HEARTBEAT_URL = `https://hc.invalid/${FAKE_PING_KEY}`;

/** Every secret string that must never survive to a log line, in one place. */
const FORBIDDEN = [FAKE_MAP_KEY, FAKE_PASSWORD, FAKE_DATABASE_URL, FAKE_PING_KEY] as const;

/** The Area API URL shape verbatim — the credential is the path segment after `csv`. */
const firmsUrl = (key: string): string =>
  `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/-10,35,45,72/1/2026-08-14`;

function env(overrides: Environment = {}): Environment {
  return {
    DATABASE_URL: FAKE_DATABASE_URL,
    FIRMS_MAP_KEY: FAKE_MAP_KEY,
    FIRE_WATCH_HEARTBEAT_URL: FAKE_HEARTBEAT_URL,
    ...overrides,
  };
}

interface CapturedLog {
  readonly log: ProcessLog;
  readonly out: string[];
  readonly err: string[];
  /** What a `docker logs` capture of this process would contain. */
  all(): string;
}

function captureLog(environment: Environment): CapturedLog {
  const out: string[] = [];
  const err: string[] = [];
  const log = createProcessLog({
    env: environment,
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
  });
  return { log, out, err, all: () => [...out, ...err].join('') };
}

describe('createProcessLog', () => {
  it('writes one canonical-JSON line per record, events to stdout and notes to stderr', () => {
    const captured = captureLog(env());

    captured.log.event({ ingest_cycle: { recorded: 12, sources: 3 } });
    captured.log.note({ starting: { application_name: 'fire-watch-worker' } });

    expect(captured.out).toStrictEqual(['{"ingest_cycle":{"recorded":12,"sources":3}}\n']);
    expect(captured.err).toStrictEqual(['{"starting":{"application_name":"fire-watch-worker"}}\n']);
  });

  it('redacts an already-serialized line without breaking its JSON', () => {
    const captured = captureLog(env());

    captured.log.line(
      canonicalJson({ poll_run: { error: `GET ${firmsUrl(FAKE_MAP_KEY)} → 401` } }),
    );

    const line = captured.out[0] ?? '';
    expect(line).not.toContain(FAKE_MAP_KEY);
    expect(JSON.parse(line) as unknown).toStrictEqual({
      poll_run: {
        error:
          'GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/<32 characters>' +
          '/VIIRS_SNPP_NRT/-10,35,45,72/1/2026-08-14 → 401',
      },
    });
  });

  it('reads its secrets from the environment, so the config-failed line is covered too', () => {
    // The line most likely to quote a secret back is the one saying config could not be
    // parsed — written when no ServerConfig exists to take secrets from.
    expect(collectSecrets(env())).toStrictEqual([
      FAKE_MAP_KEY,
      FAKE_DATABASE_URL,
      FAKE_HEARTBEAT_URL,
    ]);
    expect(SECRET_ENV_VARS).toContain('FIRMS_MAP_KEY');
  });

  it('skips variables that are absent or blank', () => {
    expect(
      collectSecrets({ FIRMS_MAP_KEY: '  ', DATABASE_URL: `  ${FAKE_DATABASE_URL} ` }),
    ).toStrictEqual([FAKE_DATABASE_URL]);
  });
});

/**
 * C8's acceptance, executable: "grep for the key in logs finds nothing". The log below is
 * assembled from the paths that actually carry a URL — a fetch failure, a cause chain, a
 * stack, a config dump, a config *failure* quoting the offending value, a cycle report
 * carrying an adapter's error string verbatim, and a heartbeat failure — and then grepped.
 */
describe('the C8 gate', () => {
  it('finds no secret anywhere in a log built from every realistic failure path', () => {
    const captured = captureLog(env());
    const url = firmsUrl(FAKE_MAP_KEY);

    // 1. The config dump every entrypoint writes on the first line.
    captured.log.note({ starting: describeConfig(loadConfig(env(), 'fire-watch-worker')) });

    // 2. A config failure that quotes the offending value back: the operator pasted the
    //    map key into the wrong variable, and `loadConfig` says which value it choked on.
    try {
      loadConfig(env({ FIRE_WATCH_STATE_DIR: FAKE_MAP_KEY }));
      expect.unreachable('a relative state dir must be refused');
    } catch (error: unknown) {
      captured.log.fatal(error);
    }

    // 3. A fetch failure: the useful detail, and the URL, sit in the cause.
    captured.log.fatal(
      new TypeError('fetch failed', { cause: new Error(`connect ETIMEDOUT ${url}`) }),
    );

    // 4. A thrown error's stack, formatted by whoever caught it. The message is repeated
    //    in the first line of `.stack`, which is exactly how a URL escapes a handler that
    //    was careful about `.message`.
    const thrown = new Error(`GET ${url} → 401 Unauthorized`);
    captured.log.event({ poll_failed: { stack: String(thrown.stack) } });

    // 5. A cycle report: the reporters serialize their own line, and it carries each
    //    source's error string exactly as the adapter produced it.
    captured.log.line(
      canonicalJson({
        ingest_cycle: {
          sources: [{ source: 'firms:viirs:snpp', error: `GET ${url} → 401 Unauthorized` }],
        },
      }),
    );

    // 6. A heartbeat failure — the ping URL is itself the credential.
    captured.log.note({
      heartbeat_failed: {
        job: 'ingest-cycle',
        reason: `request to ${FAKE_HEARTBEAT_URL}/ingest-cycle failed`,
      },
    });

    // 7. The database URL, arriving through a driver error that quotes the DSN.
    captured.log.fatal(new Error(`connection terminated: ${FAKE_DATABASE_URL}`));

    const log = captured.all();
    for (const secret of FORBIDDEN) {
      expect(log).not.toContain(secret);
    }
    // Not a prefix either: half a key is a search space, not a redaction.
    expect(log).not.toContain(FAKE_MAP_KEY.slice(0, 8));
    expect(log).not.toContain(FAKE_PASSWORD.slice(0, 8));
    // And the log is still a log: the host, the product and the failure all survived.
    expect(log).toContain('firms.modaps.eosdis.nasa.gov');
    expect(log).toContain('VIIRS_SNPP_NRT');
    expect(log).toContain('401 Unauthorized');
  });

  it('redacts a key the process was never given', () => {
    // A second deployment's key, arriving inside an upstream error. Nothing in this
    // process's environment matches it, so only the shape leg can catch it.
    const captured = captureLog({});
    const foreignKey = 'notsomeoneelseskey00000000000000';

    captured.log.fatal(new Error(`upstream said: GET ${firmsUrl(foreignKey)} → 401`));

    expect(captured.all()).not.toContain(foreignKey);
    expect(captured.all()).toContain('<32 characters>');
  });

  it('leaves stdout machine-readable after redaction', () => {
    const captured = captureLog(env());

    captured.log.event({ poll_run: { error: `GET ${firmsUrl(FAKE_MAP_KEY)} → 401` } });
    captured.log.line(canonicalJson({ backfill_run: { failed: 1, url: firmsUrl(FAKE_MAP_KEY) } }));

    for (const written of captured.out) {
      expect(written.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(written) as unknown).not.toThrow();
    }
  });
});

/**
 * The personal-data half of the sink (05 §5.3.2; RoPA §7), end to end through a real
 * `createProcessLog`: an address or a chat id reaches a log line inside a string nobody
 * decided to log — a pg error echoing the row, a provider reply, a cause chain, a stack.
 * Neither is a secret the environment could name, so only the free-text leg catches them.
 */
describe('personal data in the process log', () => {
  const ADDRESS = 'someone.fake@example.com';
  const CHAT_ID = '111111111';
  /** Shaped like a Bot API token (`<id>:<35 mixed-case>`); not one. */
  const FAKE_BOT_TOKEN = '000000000:NotARealBotToken0000000000000000000';

  it('finds no address, chat id or bot token in a log built from realistic failure paths', () => {
    const captured = captureLog(env({ FIRE_WATCH_TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN }));

    // 1. The gap found on 2026-09-25: a pg adapter error echoing the value it choked on.
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "accounts_email_key"'),
      { code: '23505', detail: `Key (email)=(${ADDRESS}) already exists.` },
    );
    captured.log.fatal(
      new Error('sign-in link request failed', {
        cause: new Error(`insert into accounts failed: Key (email)=(${ADDRESS})`, {
          cause: pgError,
        }),
      }),
    );

    // 2. The same error as a structured field, and its stack as a string.
    captured.log.event({ auth_link_failed: { failure: pgError, detail: pgError.detail } });
    captured.log.note({ auth_link_failed: { stack: String(new Error(`for ${ADDRESS}`).stack) } });

    // 3. A Telegram failure: the Bot API URL carries the token, the reply a migrated chat.
    captured.log.event({
      dispatch_failed: {
        channel: 'telegram',
        chat_id: Number(CHAT_ID),
        error: `POST https://api.telegram.org/bot${FAKE_BOT_TOKEN}/sendMessage → 400`,
        reply: `{"ok":false,"parameters":{"migrate_to_chat_id":-100${CHAT_ID}}}`,
      },
    });

    // 4. A reporter that serialized its own line, quoting an SES rejection.
    captured.log.line(
      canonicalJson({ dispatch_cycle: { errors: [`SES MessageRejected for <${ADDRESS}>`] } }),
    );

    const log = captured.all();
    expect(log).not.toContain(ADDRESS);
    expect(log).not.toContain('someone.fake');
    expect(log).not.toContain(CHAT_ID);
    expect(log).not.toContain(FAKE_BOT_TOKEN.slice(10));
    expect(log).toContain('<email address>');
    expect(log).toContain('<chat id>');
    // Still a log: the failure, the constraint, the SQL state's text and the host survive.
    expect(log).toContain('accounts_email_key');
    expect(log).toContain('api.telegram.org');
    expect(log).toContain('MessageRejected');
    for (const written of captured.out) {
      expect(() => JSON.parse(written) as unknown).not.toThrow();
    }
  });

  it('lists every secret the configs read, so they are replaced by value', () => {
    for (const name of [
      'FIRE_WATCH_TELEGRAM_BOT_TOKEN',
      'FIRE_WATCH_VAPID_PRIVATE_KEY',
      'FIRE_WATCH_ARCGIS_API_KEY',
      'FIRE_WATCH_R2_ACCESS_KEY_ID',
      'FIRE_WATCH_R2_SECRET_ACCESS_KEY',
    ]) {
      expect(SECRET_ENV_VARS).toContain(name);
    }
  });
});
