/**
 * Sign-in and the signed-in account's routes on the API process — registered only when
 * accounts are switched on and sign-in can send mail (TASKS I1–I4, I6; 05 §5.4.1 C1–C2).
 *
 * Two conditions, both explicit. `FIRE_WATCH_AUTH_ENABLED` is off by default, so a
 * deployment that has never heard of accounts serves no auth or account route at all (a
 * `404`, not a route that fails). And `loadConfig` refuses to start with the flag on but
 * the mailer incomplete (`config.ts`, `readAuth`), so "enabled" here always means "can
 * deliver a link": a sign-in route that accepts an address and cannot mail it would answer
 * `202` to a person who will never get anything.
 *
 * **One flag, one session guard.** Every account route below is mounted under the same
 * flag as sign-in and authenticates through the same `authenticate` — the one
 * `createPgSignInFlows` builds over the session table — so there is exactly one notion of
 * "signed in" on the API. Every state-changing route runs C1's Origin check before any
 * work; the GETs are exempt, as on the auth routes.
 *
 *   * `GET /api/v1/account` — am I signed in (`account-route.ts`); sign-out is
 *     `POST /api/v1/auth/logout`.
 *   * `DELETE /api/v1/account` — erasure through `createPgAccountEraser`, the production
 *     path the erasure drill exercises (I4).
 *   * `GET|POST /api/v1/zones`, `DELETE /api/v1/zones/:id` (I2) and
 *     `GET /api/v1/account/export` (I6) — **only with a zone keyring**. Both seal or open
 *     zone centres, and `zones-config.ts` fixes what a process without a key does: it does
 *     not register them, never "store zones in clear". The export is limited per account
 *     ({@link ACCOUNT_EXPORT_RATE_LIMIT}).
 *   * `/api/v1/channels/*` (I3) — registered **unarmed**: the confirmation mailer and the
 *     Telegram Bot API have no implementation, so asking for a channel is `503` before any
 *     row is written, the webhook is `404`, and only confirm and unlink reach the database.
 *
 * The pools are the API's own, small and separate from the read pools, and from each
 * other: a link request holds a transaction across the SES call (the row rolls back if the
 * mail fails), and that wait must never starve an erasure or a zone write — nor the
 * snapshot or the stream.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { systemClock } from '../adapters/clock/system-clock.js';
import { createAuthTokens } from '../adapters/crypto/auth-tokens.js';
import {
  createAesGcmZoneCipher,
  type ZoneKeyring,
} from '../adapters/crypto/aes-gcm-zone-cipher.js';
import { createPgAccountEraser } from '../adapters/db/pg-account-erasure.js';
import { createPgAccountExporter } from '../adapters/db/pg-account-export.js';
import { createPgSignInFlows } from '../adapters/db/pg-auth.js';
import { createPgChannelOptInFlows } from '../adapters/db/pg-channel-opt-in.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createPgWatchZoneStore } from '../adapters/db/pg-watch-zone-store.js';
import { createPgZoneCreator } from '../adapters/db/pg-zone-creation.js';
import {
  registerAccountExportRoutes,
  type AccountExportRouteDeps,
} from '../adapters/http/account-export-route.js';
import { registerAccountRoutes, type AccountRouteDeps } from '../adapters/http/account-route.js';
import { registerAuthRoutes, type SignInFlows } from '../adapters/http/auth-route.js';
import {
  registerChannelOptInRoutes,
  type ChannelOptInFlows,
} from '../adapters/http/channel-opt-in-route.js';
import type { ProblemObserver } from '../adapters/http/problem.js';
import { registerZonesRoutes, type ZonesRouteDeps } from '../adapters/http/zones-route.js';
import { createSesAuthMailer } from '../adapters/mail/ses-auth-mailer.js';
import { ChannelOptInRefusal } from '../core/channels/channel-opt-in.js';
import { createRateLimiter } from '../core/http/rate-limiter.js';
import type { AuthMailer } from '../core/ports/auth-stores.js';
import type {
  ChannelConfirmationMailer,
  TelegramBotApi,
} from '../core/ports/channel-opt-in-store.js';
import type { Clock } from '../core/ports/clock.js';
import type { ZoneCentreCipher } from '../core/ports/zone-centre-cipher.js';
import { listOwnedWatchZones } from '../core/zones/create-watch-zone.js';
import type { ServerConfig } from './config.js';

/** A link request holds one connection for the length of an SES call; a few is plenty. */
export const AUTH_POOL_MAX = 4;
/** Must outlast the mailer's own timeout, or the transaction dies before SES answers. */
export const AUTH_STATEMENT_TIMEOUT_MS = 15_000;
export const AUTH_CONNECTION_TIMEOUT_MS = 2_000;

/** Erasure, zone writes, export and channel rows: short transactions, one per request. */
export const ACCOUNT_POOL_MAX = 4;
/** An erasure of an account with a long outbox history is the slowest thing here. */
export const ACCOUNT_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Exports per account per hour. **Not a design number** — the DPIA asks for a limit and
 * names none; three is "enough to retry a failed download, too few to scrape with".
 */
export const ACCOUNT_EXPORT_RATE_LIMIT = { limit: 3, windowMs: 3_600_000 } as const;

export interface AuthWiring {
  /** Whether the routes were registered. */
  readonly enabled: boolean;
  /** Whether the zone and export routes were registered (a keyring was configured). */
  readonly zonesEnabled: boolean;
  readonly close: () => Promise<void>;
}

/** The zone-centre routes' dependencies, present only when there is a cipher. */
export interface ZoneSurface {
  readonly create: ZonesRouteDeps['create'];
  readonly list: ZonesRouteDeps['list'];
  readonly remove: ZonesRouteDeps['remove'];
  readonly exportAccount: AccountExportRouteDeps['exportAccount'];
}

/** Everything the routes call, built over Postgres in production. */
export interface AccountSurface {
  readonly signIn: SignInFlows;
  /** The single session guard every account route uses. */
  readonly authenticate: AccountRouteDeps['authenticate'];
  readonly erase: AccountRouteDeps['erase'];
  readonly channels: ChannelOptInFlows;
  readonly zones: ZoneSurface | null;
}

export interface AuthWiringDeps {
  readonly onProblem: ProblemObserver;
  readonly clock?: Clock;
  /** For tests: the SES transport. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The zone-centre keyring (`loadZonesConfig`). Absent or `null`: the zone and export
   * routes are not registered.
   */
  readonly zoneKeyring?: ZoneKeyring | null;
  /**
   * For tests: the surface over the real mailer, in place of Postgres. Its `zones` are
   * ignored without a keyring — the keyring, not the surface, decides whether zone
   * routes exist.
   */
  readonly createSurface?: (mailer: AuthMailer, cipher: ZoneCentreCipher | null) => AccountSurface;
}

export function wireAuthRoutes(
  app: FastifyInstance,
  config: Pick<ServerConfig, 'auth' | 'databaseUrl' | 'databaseRole' | 'applicationName'>,
  deps: AuthWiringDeps,
): AuthWiring {
  const auth = config.auth;
  if (!auth.enabled) {
    return { enabled: false, zonesEnabled: false, close: () => Promise.resolve() };
  }

  const clock = deps.clock ?? systemClock;
  const mailer = createSesAuthMailer({
    region: auth.ses.region,
    accessKeyId: auth.ses.accessKeyId,
    secretAccessKey: auth.ses.secretAccessKey,
    fromAddress: auth.fromAddress,
    configurationSetName: auth.ses.configurationSetName,
    landingUrl: auth.landingUrl,
    now: () => clock.now(),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  const keyring = deps.zoneKeyring ?? null;
  const cipher = keyring === null ? null : createAesGcmZoneCipher(keyring);

  const pools: Pool[] = [];
  let surface: AccountSurface;
  if (deps.createSurface === undefined) {
    const pg = {
      databaseUrl: config.databaseUrl,
      role: config.databaseRole,
      connectionTimeoutMs: AUTH_CONNECTION_TIMEOUT_MS,
    };
    const authPool = createPgPool({
      ...pg,
      applicationName: `${config.applicationName}-auth`,
      max: AUTH_POOL_MAX,
      statementTimeoutMs: AUTH_STATEMENT_TIMEOUT_MS,
    });
    const accountPool = createPgPool({
      ...pg,
      applicationName: `${config.applicationName}-account`,
      max: ACCOUNT_POOL_MAX,
      statementTimeoutMs: ACCOUNT_STATEMENT_TIMEOUT_MS,
    });
    pools.push(authPool, accountPool);
    surface = pgAccountSurface({ authPool, accountPool, mailer, cipher });
  } else {
    surface = deps.createSurface(mailer, cipher);
  }

  const common = {
    authenticate: surface.authenticate,
    allowedOrigins: auth.allowedOrigins,
    clock,
    onProblem: deps.onProblem,
  };

  registerAuthRoutes(app, {
    flows: surface.signIn,
    allowedOrigins: auth.allowedOrigins,
    clock,
    onProblem: deps.onProblem,
  });
  registerAccountRoutes(app, { ...common, erase: surface.erase });
  registerChannelOptInRoutes(app, {
    ...common,
    flows: unarmedChannelFlows(surface.channels),
    telegramBotUsername: null,
    telegramWebhookSecret: null,
  });

  const zones = cipher === null ? null : surface.zones;
  if (zones !== null) {
    registerZonesRoutes(app, {
      ...common,
      create: zones.create,
      list: zones.list,
      remove: zones.remove,
    });
    registerAccountExportRoutes(app, {
      ...common,
      exportAccount: zones.exportAccount,
      limiter: createRateLimiter(ACCOUNT_EXPORT_RATE_LIMIT),
    });
  }

  return {
    enabled: true,
    zonesEnabled: zones !== null,
    close: async () => {
      await Promise.all(pools.map((pool) => pool.end()));
    },
  };
}

/** The production surface: every dependency over Postgres, one session guard. */
function pgAccountSurface(options: {
  readonly authPool: Pool;
  readonly accountPool: Pool;
  readonly mailer: AuthMailer;
  readonly cipher: ZoneCentreCipher | null;
}): AccountSurface {
  const { authPool, accountPool, cipher } = options;
  const tokens = createAuthTokens();
  const signIn = createPgSignInFlows(authPool, { tokens, mailer: options.mailer });
  const zoneStore = createPgWatchZoneStore(accountPool);
  return {
    signIn,
    authenticate: (token, at) => signIn.authenticate(token, at),
    erase: createPgAccountEraser(accountPool),
    channels: createPgChannelOptInFlows(accountPool, {
      tokens,
      mailer: UNWIRED_CONFIRMATION_MAILER,
      bot: UNWIRED_TELEGRAM_BOT,
    }),
    zones:
      cipher === null
        ? null
        : {
            create: createPgZoneCreator(accountPool, { cipher, newZoneId: randomUUID }),
            list: (accountId) => listOwnedWatchZones(accountId, { cipher, zones: zoneStore }),
            remove: (accountId, zoneId, atIso) => zoneStore.softDelete(accountId, zoneId, atIso),
            exportAccount: createPgAccountExporter(accountPool, cipher),
          },
  };
}

/**
 * The channel flows with their delivery half switched off. Asking for an email channel
 * or a Telegram link refuses `unarmed` (`503`) before a transaction is opened, so no
 * pending subscription or confirmation row is ever written that nothing could deliver.
 * Confirm and unlink pass through: they need no provider.
 */
export function unarmedChannelFlows(flows: ChannelOptInFlows): ChannelOptInFlows {
  return {
    requestEmail: () => Promise.reject(new ChannelOptInRefusal('unarmed')),
    confirmEmail: (request, at) => flows.confirmEmail(request, at),
    requestTelegramLink: () => Promise.reject(new ChannelOptInRefusal('unarmed')),
    handleTelegramStart: () => Promise.reject(new ChannelOptInRefusal('unarmed')),
    unlink: (request, at) => flows.unlink(request, at),
  };
}

/**
 * I3's delivery ports, explicitly unwired: no confirmation copy, sender or landing page
 * exists for a channel mail, and no bot identity for Telegram. Unreachable through
 * {@link unarmedChannelFlows}; they throw rather than pretend, should anything else call
 * them.
 */
const UNWIRED_CONFIRMATION_MAILER: ChannelConfirmationMailer = {
  sendConfirmation: () => Promise.reject(new ChannelOptInRefusal('unarmed')),
};
const UNWIRED_TELEGRAM_BOT: TelegramBotApi = {
  acknowledgeLink: () => Promise.reject(new ChannelOptInRefusal('unarmed')),
};
