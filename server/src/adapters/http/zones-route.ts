/**
 * `GET|POST /api/v1/zones`, `DELETE /api/v1/zones/:id` — an account's watch zones (TASKS I2;
 * ADR-004 D8, A1.8, A1.10; 05 §5.3.2).
 *
 * **Every route is the account's own.** The account comes from the session cookie and
 * nowhere else — there is no account id in any path or body — so one account cannot name
 * another's zone, and a delete of a zone id the account does not own is the same `404` as
 * one that does not exist.
 *
 * **The centre the client sees is the stored one.** A create answers with the coarsened
 * centre (ADR-004 D8) so the owner's map draws what the server will match against, not
 * the click; nothing here, including the problem observer, ever sees a coordinate in an
 * error — `ZoneRequestError` messages are literals, and bodies are never echoed.
 *
 * **Sessions slide on use.** Each authenticated response re-issues the cookie with the
 * expiry `authenticateSession` just wrote (C1: thirty days from the last use); a request
 * whose cookie no longer resolves gets `401` and a clearing cookie, so the browser stops
 * sending a dead token.
 *
 * POST and DELETE are state-changing and pass C1's Origin check; GET does not need it —
 * `SameSite=Lax` already withholds the cookie from cross-site subresource requests, and
 * CORS keeps a cross-site script from reading the answer.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedSession } from '../../core/auth/sign-in.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../../core/ports/clock.js';
import {
  ZoneRequestError,
  type CreatedWatchZone,
  type CreateWatchZoneRequest,
  type OwnedWatchZone,
  type ZoneRequestErrorCode,
} from '../../core/zones/create-watch-zone.js';
import { INVALID_BODY, refuseForeignOrigin, setSessionCookie } from './auth-route.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';
import { readSessionCookie } from './session-cookie.js';

export const ZONES_PATH = '/api/v1/zones';
export const ZONE_PATH = '/api/v1/zones/:id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A name is capped at 100 by the core; this only stops a megabyte string reaching it. */
const MAX_NAME_INPUT = 400;

export interface ZonesRouteDeps {
  readonly authenticate: (
    sessionToken: string | undefined,
    at: EpochMs,
  ) => Promise<AuthenticatedSession | null>;
  /** `createPgZoneCreator(...)`: coarsen, seal, insert and seed in one transaction. */
  readonly create: (request: CreateWatchZoneRequest, at: EpochMs) => Promise<CreatedWatchZone>;
  /** `listOwnedWatchZones` over a pg store and the cipher. */
  readonly list: (accountId: string) => Promise<readonly OwnedWatchZone[]>;
  /**
   * `createPgZoneDeleter(...)`: soft-delete and cancel the zone's queued alerts in one
   * transaction (ADR-004 A1.9); false when the account owns no live zone by that id.
   */
  readonly remove: (accountId: string, zoneId: string, atIso: string) => Promise<boolean>;
  readonly allowedOrigins: readonly string[];
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
}

/** The wire shape of a zone. snake_case, as every other public document. */
export interface ZoneDocument {
  readonly id: string;
  readonly name: string;
  readonly radius_m: number;
  readonly min_score: number;
  readonly coarsened: boolean;
  readonly centre: { readonly lat: number; readonly lon: number };
  readonly created_at: string;
}

export function registerZonesRoutes(app: FastifyInstance, deps: ZonesRouteDeps): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (request, _reply, next) => {
      refuseForeignOrigin(request, deps.allowedOrigins);
      next();
    });

    scope.get(ZONES_PATH, async (request, reply) => {
      const { accountId } = await requireSession(request, reply, deps);
      const zones = await deps.list(accountId);
      return reply.send({ zones: zones.map(toDocument) });
    });

    scope.post(ZONES_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      const zoneRequest = parseCreate(request.body, accountId);
      const created = await mapZoneRefusal(deps.create(zoneRequest, at));
      return reply.code(201).send({
        zone: toDocument(created),
        // A1.8: the fires already burning inside the new zone, which it will not be
        // alerted about as "new". Event ids and distances only; no coordinates.
        onboarding: created.seed.onboarding.map((event) => ({
          event_id: event.eventPublicId,
          distance_km: event.distanceKm,
        })),
      });
    });

    scope.delete<{ Params: { id: string } }>(ZONE_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      const zoneId = request.params.id;
      if (!UUID_RE.test(zoneId) || !(await deps.remove(accountId, zoneId, isoFromEpochMs(at)))) {
        throw new ProblemError(ZONE_NOT_FOUND);
      }
      return reply.code(204).send();
    });

    done();
  });
}

async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<ZonesRouteDeps, 'authenticate' | 'clock'>,
): Promise<{ readonly accountId: string; readonly at: EpochMs }> {
  const at = deps.clock.now();
  const token = readSessionCookie(request.headers.cookie);
  const session = await deps.authenticate(token, at);
  if (session === null || token === undefined) {
    if (token !== undefined) setSessionCookie(reply, null, at);
    throw new ProblemError(NOT_SIGNED_IN);
  }
  setSessionCookie(reply, { token, expiresAt: session.expiresAt }, at);
  return { accountId: session.accountId, at };
}

/**
 * Types only; ranges, the name rule, the radius bounds and the sensitivity floors are the
 * core's (`createWatchZone`), so there is one place that says what a valid zone is.
 */
function parseCreate(body: unknown, accountId: string): CreateWatchZoneRequest {
  const refuse = (): never => {
    throw new ProblemError(INVALID_BODY);
  };
  if (typeof body !== 'object' || body === null) return refuse();
  const b = body as Record<string, unknown>;
  const { name, lat, lon } = b;
  if (typeof name !== 'string' || name.length > MAX_NAME_INPUT) return refuse();
  if (typeof lat !== 'number' || typeof lon !== 'number') return refuse();
  const radius = b['radius_m'];
  const coarsen = b['coarsen'];
  const minScore = b['min_score'];
  if (radius !== undefined && typeof radius !== 'number') return refuse();
  if (coarsen !== undefined && typeof coarsen !== 'boolean') return refuse();
  if (minScore !== undefined && typeof minScore !== 'number') return refuse();
  return {
    accountId,
    name,
    centre: { lat, lon },
    ...(radius === undefined ? {} : { radiusM: radius }),
    ...(coarsen === undefined ? {} : { coarsen }),
    ...(minScore === undefined ? {} : { minScore }),
  };
}

const NOT_SIGNED_IN: CodedProblemSpec = {
  status: 401,
  title: 'Not signed in',
  detail: 'Sign in to manage watch zones.',
  code: 'not_signed_in',
};

const ZONE_NOT_FOUND: CodedProblemSpec = {
  status: 404,
  title: 'Zone not found',
  detail: 'There is no such watch zone.',
  code: 'zone_not_found',
};

/** The core's refusals as the wire states them. Exported for the code-coverage test. */
export const ZONE_REFUSALS: Readonly<Record<ZoneRequestErrorCode, CodedProblemSpec>> = {
  invalid_name: {
    status: 400,
    title: 'Invalid zone name',
    detail: 'A zone name must be 1 to 100 characters.',
    code: 'zone_name_invalid',
  },
  invalid_radius: {
    status: 400,
    title: 'Invalid zone radius',
    detail: 'The radius must be whole metres within the allowed range.',
    code: 'zone_radius_invalid',
  },
  invalid_min_score: {
    status: 400,
    title: 'Invalid sensitivity',
    detail: 'The sensitivity must be one of the offered levels.',
    code: 'zone_sensitivity_invalid',
  },
  invalid_centre: {
    status: 400,
    title: 'Invalid zone centre',
    detail: 'The zone centre is not a valid coordinate.',
    code: 'zone_centre_invalid',
  },
  outside_area: {
    status: 400,
    title: 'Outside the covered area',
    detail: 'The zone centre is outside the area Fire Watch covers.',
    code: 'zone_outside_area',
  },
  // The session resolved but the account went away between the two reads (a deletion
  // racing the request): treat it as signed out.
  account_unavailable: NOT_SIGNED_IN,
};

/** Every refusal this module writes itself, beyond {@link ZONE_REFUSALS}. */
export const ZONES_PROBLEMS: readonly CodedProblemSpec[] = [NOT_SIGNED_IN, ZONE_NOT_FOUND];

async function mapZoneRefusal<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (!(error instanceof ZoneRequestError)) throw error;
    throw new ProblemError(ZONE_REFUSALS[error.code], { cause: error });
  }
}

function toDocument(zone: OwnedWatchZone): ZoneDocument {
  return {
    id: zone.zoneId,
    name: zone.name,
    radius_m: zone.radiusM,
    min_score: zone.minScore,
    coarsened: zone.coarsened,
    centre: { lat: zone.storedCentre.lat, lon: zone.storedCentre.lon },
    created_at: zone.createdAtIso,
  };
}
