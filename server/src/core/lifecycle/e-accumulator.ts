/**
 * The miss-evidence accumulator E (TASKS D4; ADR-002 D6 as amended by A2.3(1); 11 §5).
 *
 * One question, asked arithmetically: *did something that should have seen this fire fail
 * to see it, and how strong is that failure as evidence?* Every overpass the constellation
 * model expected over the event's centroid is weighed — by which instrument it was, by
 * which half of the day, by how much sky was in the way, and by whether that instrument
 * was even reporting at the time — and the weights are summed into E.
 *
 * What this module deliberately does **not** do is decide anything. It returns a
 * {@link MissEvidence} value; the thresholds (3.0, 5.0), the 24 h floor, the "both diurnal
 * phases" condition and the 14-day unobservability fallback all live one layer up. The
 * split is the seam `types.ts` describes and it is what lets the fallback close an event
 * *regardless of E* without this file knowing that closing is possible.
 *
 * Three properties are load-bearing:
 *
 *   - **No clock, no store, no I/O.** The window is a parameter, the cloud history is a
 *     parameter, the outages are a parameter. A replay of last September reaches last
 *     September's E (I5).
 *   - **A fixed fold order.** E is a float sum of 0.05s and 1.25s, and float addition is
 *     not associative, so "the same input" only means "the same number" if the order is
 *     pinned. Every weighed pass — polar overpass and geostationary slot alike — is folded
 *     in one stream sorted by `(atMs, source)`, and every comparison that can decide
 *     anything goes through {@link quantizeE}, for the reason `geometry.ts` gives about
 *     ties being unreachable otherwise.
 *   - **The freeze is per-source (A2.3(1)).** A blown freshness budget silences the source
 *     that blew it and nothing else. Thresholds are never rescaled to compensate: a thinner
 *     constellation simply takes longer to reach them, which is the honest behaviour and
 *     the one that cannot deadlock.
 *
 * ## The two judgement calls this file makes
 *
 * **A pass with no cloud sample covering its hour does not accumulate.** It is recorded as
 * `cloud_blocked` — the closed verdict vocabulary has no "sky unknown" member, and of the
 * members it does have this is the one whose consequence is right. Missing weather context
 * is not evidence that a satellite had a clear look; treating it as one would manufacture
 * miss evidence out of a gap in a third-party feed and retire a burning fire on the
 * strength of it. The direction to be wrong in is the one that keeps an event `active`
 * longer, and A2.3(3)'s 14-day fallback is the ceiling that stops this choice from being a
 * deadlock: weeks of unusable sky close the event under `reason = unobservable`, with copy
 * that says observation was impossible rather than that anyone looked.
 *
 * **The GEO daily cap is applied per UTC day across GEO sources, not per source.** SEVIRI
 * and FCI look at the same scene from nearly the same place; two of them failing to see a
 * fire in the same ten minutes is one failure observed twice, and
 * `geoSlot.dailyCapWeight` is documented as the ceiling on what "all of a UTC day's
 * slots" may contribute *together*.
 *
 * ## The GEO cap spans ticks, not windows
 *
 * A tick only ever sees its own window, so a cap enforced over the window alone is a cap
 * per tick: four ticks a day would let a stationary sensor contribute four times what
 * `geoSlot.dailyCapWeight` permits. The balance is therefore carried, exactly the way
 * `accumulatedE` is — in through {@link EventObservationSnapshot.geoWeightSpent} and back
 * out through {@link MissEvidence.geoWeightSpent} for the tick job to persist. A balance
 * naming an earlier UTC day imposes nothing on the current one; the day starts over.
 *
 * The outgoing value is the balance standing on the UTC day the window *ends* in, and
 * `null` where no such balance exists — a fresh event, or a window that spent nothing on
 * its final day. Note that a window which weighs GEO slots and spends nothing on them
 * (every slot cloud-blocked, say) still reports the balance it carried in for that day:
 * the field exists so the next tick continues the day rather than restarting it, and
 * dropping a live balance because this particular window happened to add nothing to it
 * would reopen the very cap-per-tick hole it was added to close.
 */

import { SOURCE_IDS, SOURCE_REGISTRY, type SourceId } from '@fire-watch/contracts';

import {
  LIFECYCLE_PARAMS,
  quantizeE,
  type LifecycleParams,
  type PassMissWeight,
} from '../config/lifecycle-params.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import { DIURNAL_PHASES, type DiurnalPhase, type PassPredictor } from '../ports/pass-predictor.js';
import type {
  CloudCoverSample,
  EventObservationSnapshot,
  GeoWeightSpent,
  MissEvidence,
  PassVerdict,
  SourceOutage,
  WeighedPass,
} from './types.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * Verdicts that describe a pass which was never a chance to see the fire. Their complement
 * is {@link MissEvidence.accumulableOpportunities}, and `detected` is deliberately *not*
 * here: a satellite that looked and saw the fire had the best opportunity of all.
 */
const NON_OPPORTUNITY_VERDICTS: ReadonlySet<PassVerdict> = new Set<PassVerdict>([
  'cloud_blocked',
  'source_frozen',
  'geo_gated',
]);

export interface MissEvidenceInput {
  readonly event: EventObservationSnapshot;
  readonly predictor: PassPredictor;
  /** Half-open `[windowFromMs, windowToMs)`, matching `PassPredictor.expectedPasses`. */
  readonly windowFromMs: EpochMs;
  readonly windowToMs: EpochMs;
  /**
   * Hourly `cloud_cover` over the window. Order is irrelevant — the samples are indexed by
   * their hour — and a duplicated hour resolves to its **highest** percentage, so a
   * re-fetched forecast row cannot change E by arriving in a different order.
   */
  readonly cloud: readonly CloudCoverSample[];
  /** Freshness-budget outages, in any order. Scoped per source and nothing else. */
  readonly outages: readonly SourceOutage[];
}

/**
 * Weighs every expected observation of `event.centroid` in the window and returns the
 * evidence that nothing saw it.
 *
 * Takes the whole {@link VersionedConfig} rather than the bare values because
 * {@link MissEvidence.paramsVersion} is part of the answer: evidence that cannot say which
 * calibration produced it is evidence a refit turns retroactively into a different claim,
 * which is the entire argument for `lifecycle_params_v1` being versioned data.
 */
export function accumulateMissEvidence(
  input: MissEvidenceInput,
  config: VersionedConfig<LifecycleParams> = LIFECYCLE_PARAMS,
): MissEvidence {
  const params = config.values;
  const { event, predictor, windowFromMs, windowToMs } = input;

  assertWindow(windowFromMs, windowToMs);
  assertFrp(event.lastFrpMw);
  assertGeoCarry(event.geoWeightSpent);
  assertBlindCarry(event.blindSinceMs);
  const cloud = indexCloud(input.cloud);
  const outages = indexOutages(input.outages);

  const geo = weighGeoSlots(input, params, cloud, outages);
  const weighed = [...weighExpectedPasses(input, params, cloud, outages), ...geo.passes].sort(
    compareWeighedPasses,
  );

  // The fold: one stream, sorted by (atMs, source), summed left to right. Geostationary
  // slots are not appended after the overpasses — they interleave by instant, so the sum
  // is a function of the timeline rather than of which producer happened to run first.
  let addedE = 0;
  const phases = new Set<DiurnalPhase>();
  const opportunities: EpochMs[] = [];
  for (const pass of weighed) {
    addedE += pass.weight;
    if (!NON_OPPORTUNITY_VERDICTS.has(pass.verdict)) {
      opportunities.push(pass.atMs);
    }
    // Geostationary slots are excluded on purpose: `DiurnalPhase` is "which of a polar
    // source's two daily passes this was", a GEO sensor has neither, and letting one
    // satisfy the "misses spanning both diurnal phases" condition would let a single
    // instrument stand in for the constellation the condition exists to require.
    if (pass.weight > 0 && !isGeoSource(pass.source, params)) {
      phases.add(pass.phase);
    }
  }
  const added = quantizeE(addedE, params);
  // The unobservable run spans ticks (see `EventObservationSnapshot.blindSinceMs`): a
  // carried start is where it began, and a fresh event's run begins with its first window.
  const blindFromMs = event.blindSinceMs ?? windowFromMs;

  return {
    publicId: event.publicId,
    windowFromMs,
    windowToMs,
    e: quantizeE(event.accumulatedE + added, params),
    addedE: added,
    passes: weighed,
    phasesWithMisses: DIURNAL_PHASES.filter((phase) => phases.has(phase)),
    accumulableOpportunities: opportunities.length,
    trailingUnobservableDays: trailingUnobservableDays(opportunities, blindFromMs, windowToMs),
    blindSinceMs: nextBlindSince(opportunities, blindFromMs),
    geoWeightSpent: standingGeoBalance(geo.dayWeight, windowFromMs, windowToMs),
    paramsVersion: config.version,
    tableVersion: predictor.tableVersion,
  };
}

/**
 * The polar half: one weighed pass per `ExpectedPass`, in the order the predictor
 * returned them.
 *
 * The order of the gates is the order of their authority. `detected` first, because a pass
 * the fire was still burning through is not a miss no matter what the sky or the feed was
 * doing. Then the per-source freeze, because a source we were not receiving cannot testify
 * that it saw nothing. Only then the cloud gate, which is the only one that produces a
 * partial weight.
 */
function weighExpectedPasses(
  input: MissEvidenceInput,
  params: LifecycleParams,
  cloud: ReadonlyMap<EpochMs, number>,
  outages: ReadonlyMap<SourceId, readonly SourceOutage[]>,
): readonly WeighedPass[] {
  const { event, predictor, windowFromMs, windowToMs } = input;
  const out: WeighedPass[] = [];
  for (const pass of predictor.expectedPasses(event.centroid, windowFromMs, windowToMs)) {
    const base = passMissWeight(pass.source, pass.phase, params);
    const record = (verdict: PassVerdict, weight: number): void => {
      out.push({ source: pass.source, atMs: pass.atMs, phase: pass.phase, verdict, weight });
    };
    if (pass.atMs <= event.lastDetectionAtMs) {
      record('detected', 0);
      continue;
    }
    if (isFrozen(pass.source, pass.atMs, outages)) {
      record('source_frozen', 0);
      continue;
    }
    switch (cloudBand(pass.atMs, cloud, params)) {
      case 'blocked':
        record('cloud_blocked', 0);
        break;
      case 'half':
        record('half_weight', quantizeE(base * params.cloudGate.halfWeightFactor, params));
        break;
      case 'clear':
        record('counted', quantizeE(base, params));
        break;
    }
  }
  return out;
}

/**
 * The geostationary half, which the predictor cannot supply: a GEO sensor has no
 * overpasses, so there is no `ExpectedPass` to weigh. It stares, and the evidence is the
 * accumulated failure of a long series of ten-minute slots.
 *
 * Slots are on the epoch grid (600 000 ms divides a UTC day exactly, so the grid and the
 * day boundaries agree), and a slot belongs to the window when its **start** does — the
 * same half-open convention `expectedPasses` uses, so a slot is never counted by two
 * adjacent windows.
 *
 * The FRP gate is checked before anything else and gates the whole source for the whole
 * window: below 1.5× the GEO detection floor, a geostationary sensor not seeing the fire is
 * not evidence about the fire, it is a statement about the sensor. `lastFrpMw === null`
 * cannot satisfy a numeric floor and so gates the same way — the absence of a reported FRP
 * is never read as a bright fire.
 */
function weighGeoSlots(
  input: MissEvidenceInput,
  params: LifecycleParams,
  cloud: ReadonlyMap<EpochMs, number>,
  outages: ReadonlyMap<SourceId, readonly SourceOutage[]>,
): GeoSlotResult {
  const { event, windowFromMs, windowToMs } = input;
  const rule = params.geoSlot;
  // Seeded from the carried balance, keyed by day: a carry for a day this window also
  // covers restricts that day, and a carry for any other day simply never matches a slot.
  // "An earlier day is spent" therefore needs no branch — it falls out of the keying.
  const dayWeight = new Map<EpochMs, number>();
  if (event.geoWeightSpent !== null) {
    dayWeight.set(event.geoWeightSpent.utcDayStartMs, event.geoWeightSpent.weight);
  }
  const sources = geoSources(params);
  if (sources.length === 0) return { passes: [], dayWeight };

  const slotMs = rule.slotMinutes * MINUTE_MS;
  if (!Number.isFinite(slotMs) || slotMs <= 0) {
    throw new RangeError(`GEO slot length must be positive, got ${String(rule.slotMinutes)} min`);
  }
  const gateOpen =
    event.lastFrpMw !== null && event.lastFrpMw >= rule.frpFloorMultiple * rule.detectionFloorMw;

  const out: WeighedPass[] = [];
  const firstSlot = Math.ceil(windowFromMs / slotMs) * slotMs;
  for (let at = firstSlot; at < windowToMs; at += slotMs) {
    const day = utcDayStart(at);
    const phase = geoSlotPhase(at);
    for (const source of sources) {
      // A retired source leaves the expected-observation set entirely (A2.3(2)) — the same
      // rule the predictor applies to overpasses, applied here because nothing else can.
      // Without it a permanently dead sensor would keep producing miss evidence forever.
      if (source.retiredFromMs !== null && at >= source.retiredFromMs) continue;
      const record = (verdict: PassVerdict, weight: number): void => {
        out.push({ source: source.id, atMs: at, phase, verdict, weight });
      };
      if (!gateOpen) {
        record('geo_gated', 0);
        continue;
      }
      if (at <= event.lastDetectionAtMs) {
        record('detected', 0);
        continue;
      }
      if (isFrozen(source.id, at, outages)) {
        record('source_frozen', 0);
        continue;
      }
      const band = cloudBand(at, cloud, params);
      if (band === 'blocked') {
        record('cloud_blocked', 0);
        continue;
      }
      const weight = quantizeE(
        band === 'half'
          ? rule.weightPerSlot * params.cloudGate.halfWeightFactor
          : rule.weightPerSlot,
        params,
      );
      // The cap gates whole slots rather than clipping one: a `counted` slot whose weight
      // is neither the full nor the half slot weight would be provenance nobody could read.
      const used = dayWeight.get(day) ?? 0;
      const next = quantizeE(used + weight, params);
      if (next > quantizeE(rule.dailyCapWeight, params)) {
        record('geo_gated', 0);
        continue;
      }
      dayWeight.set(day, next);
      record(band === 'half' ? 'half_weight' : 'counted', weight);
    }
  }
  return { passes: out, dayWeight };
}

/** The GEO half's two answers: the weighed slots, and the daily balances they leave behind. */
interface GeoSlotResult {
  readonly passes: readonly WeighedPass[];
  /** UTC day start → weight spent on that day, carry included. */
  readonly dayWeight: ReadonlyMap<EpochMs, number>;
}

/**
 * The balance to hand the next tick: what stands on the UTC day the window's *last instant*
 * falls in.
 *
 * The last instant rather than `windowToMs`, because the window is half-open — a window
 * ending exactly at midnight spent its weight on the day before, and naming the day it
 * never reached would hand the next tick a balance for a day it is about to start fresh.
 */
function standingGeoBalance(
  dayWeight: ReadonlyMap<EpochMs, number>,
  windowFromMs: EpochMs,
  windowToMs: EpochMs,
): GeoWeightSpent | null {
  const lastInstant = windowToMs > windowFromMs ? windowToMs - 1 : windowFromMs;
  const day = utcDayStart(lastInstant);
  const weight = dayWeight.get(day);
  if (weight === undefined) return null;
  return { utcDayStartMs: day, weight };
}

/** A source that contributes through `geoSlot` instead of through overpasses. */
interface GeoSource {
  readonly id: SourceId;
  /** When its retirement took effect, or `null` while it is still watching. */
  readonly retiredFromMs: EpochMs | null;
}

/**
 * The geostationary set, read off the weight table rather than matched on id substrings: a
 * `null` weight is precisely how `lifecycle_params_v1` says "this source has no passes to
 * miss". Sorted by id so the slot stream is already in `(atMs, source)` order.
 */
function geoSources(params: LifecycleParams): readonly GeoSource[] {
  const table: Readonly<Partial<Record<SourceId, PassMissWeight | null>>> = params.passMissWeights;
  return [...SOURCE_IDS]
    .filter((id) => table[id] === null)
    .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
    .map((id) => {
      const entry = SOURCE_REGISTRY[id];
      return {
        id,
        retiredFromMs:
          entry.status === 'retired'
            ? epochMsFromIso(`${entry.statusEffectiveFrom}T00:00:00.000Z`)
            : null,
      };
    });
}

function isGeoSource(source: SourceId, params: LifecycleParams): boolean {
  const table: Readonly<Partial<Record<SourceId, PassMissWeight | null>>> = params.passMissWeights;
  return table[source] === null;
}

/**
 * The weight a missed pass of this source in this phase is worth.
 *
 * Read through a partial view for the reason `epsRuleFor` gives: the source id is typed,
 * but it reaches here from a pass table that is fitted data, and a missing row must be a
 * loud error rather than an `undefined` that becomes a NaN and quietly stops E from ever
 * crossing a threshold.
 */
function passMissWeight(source: SourceId, phase: DiurnalPhase, params: LifecycleParams): number {
  const table: Readonly<Partial<Record<SourceId, PassMissWeight | null>>> = params.passMissWeights;
  const weights = table[source];
  if (weights === undefined) {
    throw new RangeError(`no miss weight configured for source ${JSON.stringify(source)}`);
  }
  if (weights === null) {
    throw new RangeError(
      `${source} is geostationary and has no overpasses; it must not appear in expectedPasses`,
    );
  }
  const weight = weights[phase];
  if (!Number.isFinite(weight) || weight < 0) {
    throw new RangeError(
      `miss weight for ${source} ${phase} must be finite and non-negative, got ${String(weight)}`,
    );
  }
  return weight;
}

type CloudBand = 'clear' | 'half' | 'blocked';

/**
 * The hourly cloud gate. Both boundaries are closed in the direction of *less*
 * accumulation — exactly 80 % is half weight, exactly 50 % is half weight — so a rounded
 * forecast percentage can never buy the extra half of a miss.
 */
function cloudBand(
  atMs: EpochMs,
  cloud: ReadonlyMap<EpochMs, number>,
  params: LifecycleParams,
): CloudBand {
  const percent = cloud.get(hourStart(atMs));
  if (percent === undefined) return 'blocked';
  if (percent > params.cloudGate.blockAbovePercent) return 'blocked';
  if (percent >= params.cloudGate.halfWeightFromPercent) return 'half';
  return 'clear';
}

/**
 * A2.3(1). Membership is a per-source question and an unordered one — "does any window of
 * this source cover the instant" — so shuffling the outage array cannot move E. The window
 * is half-open, matching every other interval in the core: a pass at the instant an outage
 * ended is a pass by a source that was back.
 */
function isFrozen(
  source: SourceId,
  atMs: EpochMs,
  outages: ReadonlyMap<SourceId, readonly SourceOutage[]>,
): boolean {
  const windows = outages.get(source);
  if (windows === undefined) return false;
  return windows.some(
    (window) => atMs >= window.fromMs && (window.toMs === null || atMs < window.toMs),
  );
}

/**
 * Whole trailing UTC days with nothing that could have seen the fire, from the start of
 * the unobservable run (which may lie in an earlier tick) to the end of this window.
 *
 * UTC rather than local, because a day boundary that moved with a DST fold would make the
 * downstream 14-day count depend on where CI runs. Whole days only: a partial day at the
 * end of the window has not finished being unobservable yet, and an opportunity anywhere
 * inside that partial tail resets the count to zero outright — we can see *now*, which is
 * the fact the fallback is asking about.
 */
function trailingUnobservableDays(
  opportunities: readonly EpochMs[],
  blindFromMs: EpochMs,
  windowToMs: EpochMs,
): number {
  const firstWholeDay = Math.ceil(blindFromMs / DAY_MS) * DAY_MS;
  const lastWholeDay = Math.floor((windowToMs - DAY_MS) / DAY_MS) * DAY_MS;
  if (lastWholeDay < firstWholeDay) return 0;

  const tailStart = lastWholeDay + DAY_MS;
  const seen = new Set<EpochMs>();
  for (const at of opportunities) {
    if (at >= tailStart) return 0;
    seen.add(utcDayStart(at));
  }
  let days = 0;
  for (let day = lastWholeDay; day >= firstWholeDay; day -= DAY_MS) {
    if (seen.has(day)) break;
    days += 1;
  }
  return days;
}

/**
 * Where the unobservable run stands after this window: unchanged when the window gave no
 * opportunity, otherwise the start of the UTC day after the last one. That day, not the
 * opportunity's instant, because an opportunity makes its whole UTC day observable — the
 * same day granularity {@link trailingUnobservableDays} counts in, so splitting a window
 * across ticks cannot change the count.
 */
function nextBlindSince(opportunities: readonly EpochMs[], blindFromMs: EpochMs): EpochMs {
  if (opportunities.length === 0) return blindFromMs;
  return utcDayStart(Math.max(...opportunities)) + DAY_MS;
}

/**
 * Indexes the hourly samples by their hour and resolves a duplicated hour to its highest
 * percentage.
 *
 * The maximum, not the first or the last: it is the order-independent choice, and of the
 * two order-independent choices it is the one that accumulates less. Alignment is
 * *required* rather than rounded, because a feed that started emitting half-hour rows would
 * otherwise silently stop matching any pass and every pass would fall to the missing-sample
 * branch — E would quietly go to zero and nothing would say why.
 */
function indexCloud(samples: readonly CloudCoverSample[]): ReadonlyMap<EpochMs, number> {
  const index = new Map<EpochMs, number>();
  for (const sample of samples) {
    if (!Number.isInteger(sample.hourStartMs) || sample.hourStartMs % HOUR_MS !== 0) {
      throw new RangeError(
        `cloud sample must start on a UTC hour, got ${String(sample.hourStartMs)}`,
      );
    }
    if (!Number.isFinite(sample.percent) || sample.percent < 0 || sample.percent > 100) {
      throw new RangeError(`cloud cover must be a percentage, got ${String(sample.percent)}`);
    }
    const held = index.get(sample.hourStartMs);
    index.set(
      sample.hourStartMs,
      held === undefined ? sample.percent : Math.max(held, sample.percent),
    );
  }
  return index;
}

function indexOutages(
  outages: readonly SourceOutage[],
): ReadonlyMap<SourceId, readonly SourceOutage[]> {
  const index = new Map<SourceId, SourceOutage[]>();
  for (const outage of outages) {
    if (!Number.isFinite(outage.fromMs)) {
      throw new RangeError(`outage start must be finite, got ${String(outage.fromMs)}`);
    }
    if (outage.toMs !== null && (!Number.isFinite(outage.toMs) || outage.toMs < outage.fromMs)) {
      throw new RangeError(
        `outage of ${outage.source} ends at ${String(outage.toMs)}, before it starts`,
      );
    }
    const held = index.get(outage.source);
    if (held === undefined) index.set(outage.source, [outage]);
    else held.push(outage);
  }
  return index;
}

/**
 * A label, not a claim. `DiurnalPhase` is defined as which of a polar source's two daily
 * passes something was, and a geostationary slot is neither — but {@link WeighedPass}
 * requires a phase, so the slot is labelled by the crude UTC daylight split that covers the
 * Bulgarian AOI. Nothing consults it: geostationary slots are excluded from
 * {@link MissEvidence.phasesWithMisses}, so this value can only ever be read by a human
 * scanning provenance.
 */
function geoSlotPhase(atMs: EpochMs): DiurnalPhase {
  const hour = Math.floor((((atMs % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
  return hour >= 6 && hour < 18 ? 'day' : 'night';
}

/** Total, so the fold order is fully determined; no two records share an instant and a source. */
function compareWeighedPasses(a: WeighedPass, b: WeighedPass): number {
  if (a.atMs !== b.atMs) return a.atMs - b.atMs;
  if (a.source === b.source) return 0;
  return a.source < b.source ? -1 : 1;
}

function utcDayStart(atMs: EpochMs): EpochMs {
  return Math.floor(atMs / DAY_MS) * DAY_MS;
}

function hourStart(atMs: EpochMs): EpochMs {
  return Math.floor(atMs / HOUR_MS) * HOUR_MS;
}

function assertWindow(fromMs: EpochMs, toMs: EpochMs): void {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new RangeError(
      `accumulation window must be finite, got [${String(fromMs)}, ${String(toMs)})`,
    );
  }
  if (toMs < fromMs) {
    throw new RangeError(
      `accumulation window ends before it starts: [${String(fromMs)}, ${String(toMs)})`,
    );
  }
}

/**
 * The carried balance is state a previous tick wrote and a store round-tripped, so it is
 * checked like any other input. A misaligned day would silently never match a slot and the
 * cap would reopen without a word; a negative or non-finite weight would poison every
 * comparison downstream of it.
 */
function assertGeoCarry(carry: GeoWeightSpent | null): void {
  if (carry === null) return;
  if (!Number.isInteger(carry.utcDayStartMs) || carry.utcDayStartMs % DAY_MS !== 0) {
    throw new RangeError(
      `carried GEO balance must name a UTC midnight, got ${String(carry.utcDayStartMs)}`,
    );
  }
  if (!Number.isFinite(carry.weight) || carry.weight < 0) {
    throw new RangeError(
      `carried GEO balance must be finite and non-negative, got ${String(carry.weight)}`,
    );
  }
}

function assertBlindCarry(blindSinceMs: EpochMs | null): void {
  if (blindSinceMs !== null && !Number.isFinite(blindSinceMs)) {
    throw new RangeError(
      `carried unobservable-run start must be a finite epoch millisecond, got ${String(blindSinceMs)}`,
    );
  }
}

function assertFrp(lastFrpMw: number | null): void {
  if (lastFrpMw !== null && (!Number.isFinite(lastFrpMw) || lastFrpMw < 0)) {
    throw new RangeError(`last FRP must be finite and non-negative, got ${String(lastFrpMw)}`);
  }
}
