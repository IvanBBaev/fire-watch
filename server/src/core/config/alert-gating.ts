/**
 * `alert_gating_v1` — every number the alert decision is allowed to consult (ADR-004 D3
 * and D4 as amended by A1.5, A1.7, A1.11, A1.12; ADR-002 D5 config-as-data).
 *
 * These are parameters, not constants, for the same reason the clustering ε is: an alert
 * that went out last August went out under last August's thresholds, and the only way a
 * replay can prove what we sent is if the decision cites a version and the version
 * carries a digest of the values. `rule_version` on `alert_outbox` is exactly this
 * config's version string, which is why the ladder lives here rather than next to the
 * function that walks it.
 *
 * Two numbers below look like duplicates of a per-account column and are not:
 * {@link AlertGatingParams.quietHours} is the *default* an account is created with, and
 * the decision reads the account's own values; the default is here so that the fixture
 * suite and the account table cannot disagree about what 22:00–07:00 means.
 */

import { defineConfig, type VersionedConfig } from './versioned-config.js';

/**
 * Ladder v1 (A1.11), in rung order. The array index is the step number minus one, and
 * that ordering is load-bearing twice over: it is what `escalation_watermark` stores and
 * what "strictly greater" compares. Reordering the array rewrites the meaning of every
 * watermark already in the database, so a v2 ladder is a new config version, never an
 * edit to this one.
 */
export const ESCALATION_LADDER = ['score_upgrade', 'area_doubling', 'lifecycle_worsening'] as const;
export type EscalationRung = (typeof ESCALATION_LADDER)[number];

/** Trigger vocabulary of `alert_outbox` (A1.1). `manual` is human-initiated. */
export const TRIGGER_TYPES = ['manual', 'new_fire', 'escalation', 'digest'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** The three types a decision may produce. `manual` is not one of them, by construction. */
export const ALERT_TYPES = ['new_fire', 'escalation', 'digest'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Local wall-clock time of day, as the `time` columns store it. */
export type LocalTimeOfDay = `${number}:${number}`;

export interface QuietHoursWindow {
  readonly timezone: string;
  readonly start: LocalTimeOfDay;
  readonly end: LocalTimeOfDay;
}

export interface AlertGatingParams {
  /**
   * The system gate's persistence half (D4, A1.7). **Not user-adjustable** — the
   * sensitivity control moves the score threshold only, so this stays out of
   * {@link sensitivityFloors} where a product knob could reach it.
   */
  readonly minDetections: number;
  /** …or one night-time high-confidence detection, which stands in for the count. */
  readonly minNightHighConfidenceDetections: number;

  /**
   * The three positions of A1.7's sensitivity table. A zone may sit at any of them and
   * nowhere below `earlySignals`.
   */
  readonly sensitivityFloors: {
    readonly confirmed: number;
    readonly likely: number;
    readonly earlySignals: number;
  };
  /**
   * D4's system default. A zone is *created* stricter than this (A1.7 puts new zones at
   * `confirmed`) and opts down; the number is kept because it is what the schema
   * defaults `watch_zones.min_score` to and what "the system gate" means in the docs.
   */
  readonly systemScoreFloor: number;
  /**
   * A zone at or above this floor may let `new_fire` pierce quiet hours. Alerts issued
   * under the 0.30 early-signals opt-in never do (A1.7) — the override belongs to
   * `new_fire` at Likely+ only.
   */
  readonly quietHoursOverrideFloor: number;

  /** D3's ~6 h window between successive notifications. */
  readonly suppressionWindowMs: number;
  /** D3's digest floor: never more than one notification per user per event per 30 min. */
  readonly digestFloorMs: number;
  /**
   * The push TTL of A1.5. A `new_fire` whose triggering detection is already older than
   * this folds into the next digest instead of pushing — a released quarantine batch
   * must not arrive as a burst of "new fire" about fires that started hours ago.
   */
  readonly pushTtlMs: number;

  /**
   * The 10 ha floor under rung 2 (A1.11). Doubling 1 ha to 2 ha is arithmetic, not news.
   */
  readonly areaDoublingFloorHa: number;
  readonly ladder: readonly EscalationRung[];

  readonly quietHours: QuietHoursWindow;
  /**
   * Queue class per trigger type (A1.2), stored on the row. Lower sorts first. Priority
   * reorders the queue and never raises a ceiling.
   */
  readonly priorities: Readonly<Record<TriggerType, number>>;

  /**
   * Quantum for the A1.12 nearest-zone comparison, in kilometres. 1 m, and the point of
   * it is not precision but reachability: two zones drawn round the same village are
   * equidistant in intent and differ by ~1e-13 km in double arithmetic, so an
   * unquantised comparison would let floating-point noise pick the rendering zone and
   * the pinned lowest-zone-id tie-break would be unreachable code. It is deliberately
   * *not* the clustering quantum — this distance comes from a geography column, not from
   * the identity metric, and borrowing 1 mm here would imply a precision that A1.10's
   * ~1 km centre coarsening has already destroyed.
   */
  readonly zoneDistanceQuantumKm: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const ALERT_GATING: VersionedConfig<AlertGatingParams> = defineConfig(
  'alert_gating',
  'alert_gating_v1',
  {
    minDetections: 2,
    minNightHighConfidenceDetections: 1,
    sensitivityFloors: { confirmed: 0.75, likely: 0.45, earlySignals: 0.3 },
    systemScoreFloor: 0.45,
    quietHoursOverrideFloor: 0.45,
    suppressionWindowMs: 6 * HOUR_MS,
    digestFloorMs: 30 * MINUTE_MS,
    pushTtlMs: 1800 * 1000,
    areaDoublingFloorHa: 10,
    ladder: ESCALATION_LADDER,
    quietHours: { timezone: 'Europe/Sofia', start: '22:00', end: '07:00' },
    priorities: { manual: 0, new_fire: 10, escalation: 20, digest: 30 },
    zoneDistanceQuantumKm: 0.001,
  } as const,
);

/**
 * The step number of a rung: its position in the ladder, one-based, so that 0 can mean
 * "no rung holds" and be the initial watermark the schema already defaults to.
 */
export function ladderStepOf(
  rung: EscalationRung,
  params: AlertGatingParams = ALERT_GATING.values,
): number {
  const index = params.ladder.indexOf(rung);
  if (index < 0) {
    throw new RangeError(`rung ${JSON.stringify(rung)} is not in ${params.ladder.join(', ')}`);
  }
  return index + 1;
}

/**
 * A1.2's priority, as the pure function of `trigger_type` it is specified to be. Stored
 * on the row rather than recomputed at dispatch: the queue order has to be reproducible
 * from the rows alone years later, when this table may read differently.
 */
export function priorityFor(
  trigger: TriggerType,
  params: AlertGatingParams = ALERT_GATING.values,
): number {
  const priority = params.priorities[trigger];
  if (priority === undefined) {
    throw new RangeError(`no priority configured for trigger ${JSON.stringify(trigger)}`);
  }
  return priority;
}

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Minutes since local midnight, parsed strictly. Strictly, because the source of these
 * strings is a Postgres `time` column that will happily render `22:00:00` — accepting it
 * loosely and dropping the seconds would silently answer a question about text.
 */
export function minuteOfDay(value: string): number {
  if (!TIME_OF_DAY_RE.test(value)) {
    throw new RangeError(`expected a HH:MM time of day, got ${JSON.stringify(value)}`);
  }
  // Fixed-width by the pattern above, so slicing reads the two fields without an
  // indexed capture that the type system would then have to be talked out of.
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}
