/**
 * Creating a watch zone: coarsen, seal, write, seed — in that order, in one transaction
 * (TASKS I2; ADR-004 D8, A1.8, A1.10; 05 §5.3.2).
 *
 * The order is the design:
 *
 *   1. **Everything that can be refused is refused before any I/O.** Name, radius, floor,
 *      and the centre (finite, on the globe, inside the alertable envelope) are pure
 *      checks. A request that fails one never opens a transaction.
 *   2. **The centre is coarsened before it is anything else** (`prepareCentre`), when the
 *      user left coarsening on — ADR-004 D8's default. From here on the click is gone: the
 *      sealed value, the index cell, and every distance A1.10 lets the product state are
 *      all computed from the stored centre, so there is no second, more precise copy for a
 *      later edit to reach for.
 *   3. **Sealed under the zone's own id.** The id is minted here rather than by the
 *      database's default, because the cipher binds the ciphertext to it (associated data)
 *      and the row cannot be sealed before it has an id.
 *   4. **Written, then seeded.** A1.8's seed plan is computed over the stored centre and
 *      written through the same store handle the caller `BEGIN`ed, so a zone never exists
 *      without its seed — and never, even briefly, in the state that made week-old fires
 *      arrive as "нов пожар".
 *   5. **Logged.** Every seed-pass decision — seeded or skipped — is appended to the H7
 *      decision log with `pass = 'zone_creation'`, keyed on the event's `seq` at the
 *      snapshot the seed read, in the same transaction. The entries carry ids and reasons
 *      only; no coordinate or distance reaches the log.
 *
 * **Why `states` is empty.** `buildZoneSeedPlan` takes the zone's existing `alert_states`
 * rows so an *enlargement* does not re-stamp an old seed. A zone created here has an id
 * minted a moment ago, and `alert_states.watch_zone_id` references `watch_zones` — so no
 * row can exist for it, and reading the table to confirm would be a round trip that can
 * only return nothing. Zone *edits* are where that read matters; they are not built yet.
 *
 * No clock and no randomness: `at` and `newZoneId` are parameters, like everything else in
 * the core.
 */

import type { Coordinate } from '../clustering/geometry.js';
import { ALERT_GATING, type AlertGatingParams } from '../config/alert-gating.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import { decisionLogEntryFor } from '../alerts/decision-log.js';
import type { AlertDecisionLog, DecisionLogEntry } from '../ports/alert-decision-log.js';
import type { AlertStateStore } from '../ports/alert-state-store.js';
import type { WatchZoneStore } from '../ports/watch-zone-store.js';
import type { ZoneCentreCipher } from '../ports/zone-centre-cipher.js';
import type {
  ZoneSeedCandidateReader,
  ZoneSeedCandidateRow,
} from '../ports/zone-seed-candidate-reader.js';
import { buildZoneSeedPlan, type ZoneSeedPlan } from '../registry/zone-seed-plan.js';
import {
  assertCoordinate,
  assertRadiusM,
  prepareCentre,
  ZONE_GRID,
  type ZoneGridParams,
} from './zone-geometry.js';

/**
 * Longest zone name accepted, in UTF-16 code units. An input bound for a free-text column,
 * not a product rule — no spec names one, and the I2 report lists it as a placeholder.
 */
export const MAX_ZONE_NAME_LENGTH = 100;

export type ZoneRequestErrorCode =
  | 'invalid_name'
  | 'invalid_radius'
  | 'invalid_min_score'
  | 'invalid_centre'
  | 'outside_area'
  | 'account_unavailable';

/**
 * A refusal the caller can show. The message is a literal per code: nothing here echoes a
 * coordinate, a name, or a value back, so the error is safe to log whole.
 */
export class ZoneRequestError extends Error {
  readonly code: ZoneRequestErrorCode;
  constructor(code: ZoneRequestErrorCode) {
    super(ZONE_REQUEST_MESSAGES[code]);
    this.name = 'ZoneRequestError';
    this.code = code;
  }
}

const ZONE_REQUEST_MESSAGES: Readonly<Record<ZoneRequestErrorCode, string>> = {
  invalid_name: 'zone name must be non-empty and at most 100 characters',
  invalid_radius: 'zone radius must be whole metres within the allowed range',
  invalid_min_score: 'zone sensitivity must be one of the published floors',
  invalid_centre: 'zone centre must be a finite latitude and longitude',
  outside_area: 'zone centre lies outside the alertable area',
  account_unavailable: 'account does not exist or is deleted',
};

export interface CreateWatchZoneRequest {
  readonly accountId: string;
  readonly name: string;
  /** The click. Never stored as-is when `coarsen` is on. */
  readonly centre: Coordinate;
  /** Defaults to the grid's `defaultRadiusM` (10 km). */
  readonly radiusM?: number;
  /** ADR-004 D8: on unless the user turned it off. */
  readonly coarsen?: boolean;
  /**
   * One of A1.7's floors — `sensitivityFloors` in the gating config: Confirmed, Likely, or
   * the Early-signals opt-in. Defaults to Likely, which is also 001's column default.
   */
  readonly minScore?: number;
}

export interface CreateWatchZoneDeps {
  readonly cipher: ZoneCentreCipher;
  readonly zones: WatchZoneStore;
  readonly candidates: ZoneSeedCandidateReader;
  /** Only `upsert` is used; the narrower type says so. */
  readonly alertStates: Pick<AlertStateStore, 'upsert'>;
  /** TASKS H7: the seed pass's decisions, `pass = 'zone_creation'`. Same transaction. */
  readonly decisionLog: Pick<AlertDecisionLog, 'append'>;
  readonly newZoneId: () => string;
  readonly gating?: VersionedConfig<AlertGatingParams>;
  readonly grid?: VersionedConfig<ZoneGridParams>;
}

export interface CreatedWatchZone {
  readonly zoneId: string;
  readonly name: string;
  readonly radiusM: number;
  readonly minScore: number;
  readonly coarsened: boolean;
  /**
   * The stored centre, for the owner's own map. The caller returns it to that account and
   * nowhere else, and never logs it.
   */
  readonly storedCentre: Coordinate;
  readonly createdAtIso: string;
  /** A1.8's onboarding list and skips come from here; it carries no coordinate. */
  readonly seed: ZoneSeedPlan;
}

/**
 * Validates, coarsens, seals, writes and seeds one zone. Must be called with stores bound
 * to one transaction: the zone row and its seed commit or roll back together.
 */
export async function createWatchZone(
  request: CreateWatchZoneRequest,
  at: EpochMs,
  deps: CreateWatchZoneDeps,
): Promise<CreatedWatchZone> {
  const grid = deps.grid ?? ZONE_GRID;
  const gating = deps.gating ?? ALERT_GATING;

  const name = request.name.trim();
  if (name.length === 0 || name.length > MAX_ZONE_NAME_LENGTH) {
    throw new ZoneRequestError('invalid_name');
  }
  const radiusM = request.radiusM ?? grid.values.defaultRadiusM;
  try {
    assertRadiusM(radiusM, grid.values);
  } catch {
    throw new ZoneRequestError('invalid_radius');
  }
  const minScore = resolveMinScore(request.minScore, gating.values);
  try {
    assertCoordinate(request.centre);
  } catch {
    throw new ZoneRequestError('invalid_centre');
  }
  let prepared;
  try {
    prepared = prepareCentre(request.centre, { coarsen: request.coarsen ?? true }, grid);
  } catch {
    // The coordinate is already known to be valid, so the envelope is the only refusal left.
    throw new ZoneRequestError('outside_area');
  }

  const settings = await deps.zones.loadAccountAlertSettings(request.accountId);
  if (settings === null) throw new ZoneRequestError('account_unavailable');

  const zoneId = deps.newZoneId();
  const createdAtIso = isoFromEpochMs(at);
  await deps.zones.insert({
    id: zoneId,
    accountId: request.accountId,
    name,
    radiusM,
    minScore,
    sealed: deps.cipher.seal(zoneId, prepared.stored),
    coarsened: prepared.coarsened,
    gridVersion: prepared.gridVersion,
    gridCell: prepared.indexCell,
    createdAtIso,
  });

  const candidates = await deps.candidates.candidatesWithin(prepared.stored, radiusM);
  const seed = buildZoneSeedPlan(
    {
      zone: { zoneId, minScore, ...settings },
      candidates,
      states: [],
      at,
    },
    gating,
  );
  if (seed.upserts.length > 0) await deps.alertStates.upsert(seed.upserts);
  const entries = seedDecisionLogEntries(seed, candidates, at);
  if (entries.length > 0) await deps.decisionLog.append(entries);

  return {
    zoneId,
    name,
    radiusM,
    minScore,
    coarsened: prepared.coarsened,
    storedCentre: prepared.stored,
    createdAtIso,
    seed,
  };
}

/**
 * Only the three published floors are accepted. A free-form number would let a client
 * write a floor below Early signals, and A1.7 is explicit that there is no such floor.
 */
function resolveMinScore(requested: number | undefined, gating: AlertGatingParams): number {
  const floors = gating.sensitivityFloors;
  if (requested === undefined) return floors.likely;
  if ([floors.confirmed, floors.likely, floors.earlySignals].includes(requested)) {
    return requested;
  }
  throw new ZoneRequestError('invalid_min_score');
}

/** One of the account's zones, opened for its owner. */
export interface OwnedWatchZone {
  readonly zoneId: string;
  readonly name: string;
  readonly radiusM: number;
  readonly minScore: number;
  readonly coarsened: boolean;
  readonly storedCentre: Coordinate;
  readonly createdAtIso: string;
}

/**
 * The account's zones with their centres opened — the owner's map needs them, and nothing
 * else does. A zone that fails to open throws rather than being skipped: a zone silently
 * missing from its owner's list is a zone they believe they deleted.
 */
export async function listOwnedWatchZones(
  accountId: string,
  deps: Pick<CreateWatchZoneDeps, 'cipher' | 'zones'>,
): Promise<readonly OwnedWatchZone[]> {
  const zones = await deps.zones.listForAccount(accountId);
  return zones.map((zone) => ({
    zoneId: zone.id,
    name: zone.name,
    radiusM: zone.radiusM,
    minScore: zone.minScore,
    coarsened: zone.coarsened,
    storedCentre: deps.cipher.open(zone.id, zone.sealed),
    createdAtIso: zone.createdAtIso,
  }));
}

/**
 * The seed plan's decisions as H7 log entries. The plan speaks public ids; the log keys on
 * `fire_events.id` and the `seq` the seed read, which only the candidate rows carry.
 */
function seedDecisionLogEntries(
  seed: ZoneSeedPlan,
  candidates: readonly ZoneSeedCandidateRow[],
  at: EpochMs,
): readonly DecisionLogEntry[] {
  const refs = new Map(candidates.map((c) => [c.event.publicId, c] as const));
  return seed.decisions.map((decision) => {
    const ref = refs.get(decision.eventPublicId);
    if (ref === undefined) {
      // Unreachable: the plan decides only over the candidates it was handed.
      throw new RangeError(`seed decision for ${decision.eventPublicId} has no candidate row`);
    }
    return decisionLogEntryFor(decision, {
      fireEventId: ref.fireEventId,
      triggerRefSeq: ref.seq,
      pass: 'zone_creation',
      decidedAt: at,
    });
  });
}
