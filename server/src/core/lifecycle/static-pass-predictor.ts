/**
 * `pass_table_v0` — the constellation, as a table of nominal overpass times
 * (TASKS D4; ADR-002 D6 as amended by A2.3; GLOSSARY §3b; DATA-SOURCES §A1–§A4).
 *
 * This is the v0 {@link PassPredictor}: no ephemeris, no propagator, no TLEs. A polar
 * source's overpass of a fixed point recurs at a nearly fixed *local solar* time, and
 * local solar time converts to UTC by subtracting the longitude — four minutes a degree,
 * which across the polled box (20°–31° E) is a real 44-minute spread and the one thing a
 * static table gets right for free. Everything else it gets approximately, and the
 * approximations are stated below rather than implied.
 *
 * ## What this model claims
 *
 *   - **Which half of the day a look falls in.** The day and night passes of a
 *     sun-synchronous source are twelve hours apart, so the `phase` a miss is charged
 *     under is right even when the instant is an hour out. `phase` is table data, never a
 *     sun-angle computation — it is which of the source's two daily looks this was, which
 *     is what the weight table is indexed by (see `PassPredictor`'s docblock).
 *   - **How many looks a day a point gets.** One per phase per platform, which is what
 *     DATA-SOURCES §A1 documents for Bulgaria (~4–6 usable VIIRS overpasses a day across
 *     the three satellites) and §A3 for SLSTR (~daily day and night passes).
 *   - **That a look was possible at all**, via {@link assuredDailyLooks}: a source is only
 *     credited with a daily look where its swath is at least as wide as the gap between
 *     consecutive ground tracks at that latitude. That ratio is where latitude enters the
 *     model, and it is not decoration — SLSTR's 1420 km swath does not tile the equator
 *     even with both platforms, while VIIRS' 3060 km swath tiles everything.
 *
 * ## What it does not claim, and must never be cited for
 *
 *   - **The instant, to better than about ±50 minutes.** The true overpass depends on
 *     which ground track of the 16-day repeat cycle happens to fall nearest the point that
 *     day; the spread is half the inter-track interval. A static table cannot represent
 *     that, and a propagator behind this same port is how it gets fixed. The delivery lag
 *     below is 1–3 h wide anyway, so the chip's window swallows the error whole.
 *   - **The second look.** At 39°–46° N between 30 % and 56 % of longitudes get a second,
 *     adjacent-orbit look per phase (that is the fractional part of
 *     {@link assuredDailyLooks}). It is deliberately floored away: its *time* is exactly
 *     the unpredictable part, one modelled look per phase already sits at the top of the
 *     documented 4–6 band, and under-counting expected passes is the direction that keeps
 *     an event `active` longer — never the one that declares a burning fire undetected.
 *   - **That an overpass happened, or saw anything.** Cloud, swath-edge geometry, sun
 *     glint and a feed being down are all somebody else's question; see the port's second
 *     load-bearing property.
 *
 * ## Retirement (A2.3(2)) is the point of this file
 *
 * A source that is `retired` contributes no expected passes **from its
 * `statusEffectiveFrom` onward**, and its full complement of passes **before** it: a
 * replay of last September must reproduce the constellation as it was then, not as it is
 * now. `firms:modis` is the live example — retired at the v1 freeze, still flying in every
 * fixture recorded before it.
 *
 * Only `retired` gates. An `active` source contributes at every instant, including before
 * its own `statusEffectiveFrom`: the v1 freeze stamped one date on every registry row, so
 * reading an active source's effective date as a start would erase the entire
 * constellation from every pre-freeze backfill and fixture. `packages/contracts` exposes
 * `expectedOverpassSources()`, which takes no instant and therefore cannot express any of
 * this — the rule is derived here, from `SOURCE_REGISTRY` and the effective date.
 *
 * ## Geostationary sources emit nothing
 *
 * `lsasaf:seviri:frp-pixel` and `lsasaf:fci:frp-pixel` stare; they have no overpass to
 * miss, and `lifecycle_params_v1` accounts for them through a separate 10-minute-slot rule
 * with its own FRP floor and daily cap. Giving them synthetic `ExpectedPass` rows here
 * would double-count them the moment the accumulator applied both rules. They are absent
 * from {@link nextWindow} for the same reason plus one more: their 15-minute product
 * cadence is already versioned data, in the freshness budget table's
 * `nominalCadenceSeconds`, and a second copy of a cadence is a second thing to keep in
 * sync.
 *
 * ## Determinism
 *
 * `Math.sin`, `Math.cos` and `Math.atan2` are *implementation-approximated* in ECMAScript
 * and are banned from anything a decision depends on — the argument is spelled out in
 * `clustering/geometry.ts`. Nothing below uses them: the whole model is `+ − × ÷`, one
 * `Math.floor` and one `Math.round`, all of which IEEE-754 pins exactly. Instants are
 * rounded to the whole minute, which is both the resolution this model honestly has and
 * what makes a pass instant something a fixture can write down.
 */

import { SOURCE_REGISTRY, type SourceId } from '@fire-watch/contracts';

import type { Coordinate } from '../clustering/geometry.js';
import { assertBoundingBox, POLLING_BBOX, type BoundingBox } from '../config/polling-bbox.js';
import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import type {
  DiurnalPhase,
  ExpectedPass,
  PassPredictor,
  PassWindow,
} from '../ports/pass-predictor.js';

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1_440;
const MS_PER_DAY = MINUTES_PER_DAY * MS_PER_MINUTE;

/**
 * One nominal look. `localSolarHour` is the local solar time of the overpass **at the
 * table's reference latitude**, not the source's published equator-crossing time: the
 * along-track travel from the node to 42.7° N and the westward convergence of the ground
 * track between them shift it by about 32 minutes, and folding that constant into the
 * table keeps the runtime formula to a subtraction.
 */
export interface NominalPass {
  readonly phase: DiurnalPhase;
  readonly localSolarHour: number;
}

export interface PolarSourceModel {
  readonly source: SourceId;
  /** At least one `day` and one `night`; one entry per platform that flies the sensor. */
  readonly passes: readonly NominalPass[];
  /**
   * Across-track width available to **one** modelled pass, already summed over the
   * platforms folded into it. MODIS lists Terra and Aqua as separate passes and so carries
   * one platform's swath; SLSTR folds S3A and S3B into a single daily look and carries
   * both.
   */
  readonly effectiveSwathKm: number;
  /** Longitude between consecutive ground tracks: 360° ÷ orbits per day. */
  readonly trackSpacingDegLon: number;
  /**
   * Overpass → API availability, as DATA-SOURCES documents it. The width is the honest
   * part; the split of the band is a placeholder to be refitted against WP1's measured
   * arrival times, which is the same refit that moves this table off `_v0`.
   */
  readonly deliveryLagMinutesFrom: number;
  readonly deliveryLagMinutesTo: number;
}

/**
 * Kilometres per degree of longitude, linear in latitude. The same plane the identity
 * engine measures on and the same three numbers, copied rather than imported for the
 * reason `clustering_params_v1` states about its own nadir footprint: this file is data,
 * and importing another config's values into it would make one digest depend on another.
 * `static-pass-predictor.test.ts` pins them equal so the two cannot drift.
 */
export interface PassTableMetric {
  readonly referenceLatDeg: number;
  readonly kmPerDegreeLonAtReference: number;
  readonly kmPerDegreeLonPerDegreeLat: number;
}

export interface PassTable {
  /**
   * Where the table was fitted, and the only region it answers about. Outside it both the
   * linear metric and the nominal local times are extrapolation, so the model says it has
   * nothing — which renders `freshness_chip_unknown` rather than an invented range.
   */
  readonly modelledArea: BoundingBox;
  readonly metric: PassTableMetric;
  readonly sources: readonly PolarSourceModel[];
}

/**
 * A window wider than this is a caller bug — the accumulator ticks over days, not decades
 * — and enumerating it would build a multi-million-element array before failing.
 */
export const MAX_WINDOW_DAYS = 400;

/** How far {@link PassPredictor.nextWindow} looks ahead before answering `null`. */
const NEXT_WINDOW_HORIZON_MS = 2 * MS_PER_DAY;

/**
 * Local solar times at 42.7° N, derived from each platform's published node crossing plus
 * the ~32-minute along-track/convergence correction described on {@link NominalPass}.
 *
 * The three VIIRS satellites share one orbital plane and therefore one equator-crossing
 * local time; they are entered ~50 minutes apart because that is their in-plane phasing
 * and it is the only place a static table can put it. It is **not** a claim that they
 * cross the equator at different local times — they do not — and which of the three leads
 * over a given point is a placeholder for WP1's measured arrival times.
 */
const SOURCES: readonly PolarSourceModel[] = [
  // VIIRS, 3060 km swath, 14.20 orbits/day. FIRMS Europe NRT is documented at 1–3 h from
  // overpass to API availability (§A1).
  {
    source: 'firms:viirs:noaa20',
    passes: [
      { phase: 'day', localSolarHour: 12.03 },
      { phase: 'night', localSolarHour: 1.11 },
    ],
    effectiveSwathKm: 3060,
    trackSpacingDegLon: 25.35,
    deliveryLagMinutesFrom: 60,
    deliveryLagMinutesTo: 180,
  },
  {
    source: 'firms:viirs:snpp',
    passes: [
      { phase: 'day', localSolarHour: 12.88 },
      { phase: 'night', localSolarHour: 1.96 },
    ],
    effectiveSwathKm: 3060,
    trackSpacingDegLon: 25.35,
    deliveryLagMinutesFrom: 60,
    deliveryLagMinutesTo: 180,
  },
  {
    source: 'firms:viirs:noaa21',
    passes: [
      { phase: 'day', localSolarHour: 13.72 },
      { phase: 'night', localSolarHour: 2.81 },
    ],
    effectiveSwathKm: 3060,
    trackSpacingDegLon: 25.35,
    deliveryLagMinutesFrom: 60,
    deliveryLagMinutesTo: 180,
  },
  // MODIS: Terra (10:30 descending / 22:30 ascending) and Aqua (13:30 ascending / 01:30
  // descending), 2330 km swath, 14.56 orbits/day, same FIRMS NRT pipeline and so the same
  // lag. Retired at the v1 freeze — these four rows exist for backfill, SP promotion and
  // fixture replay of periods when both platforms were still flying (§A2).
  {
    source: 'firms:modis',
    passes: [
      { phase: 'day', localSolarHour: 11.04 },
      { phase: 'day', localSolarHour: 12.96 },
      { phase: 'night', localSolarHour: 21.96 },
      { phase: 'night', localSolarHour: 2.04 },
    ],
    effectiveSwathKm: 2330,
    trackSpacingDegLon: 24.72,
    deliveryLagMinutesFrom: 60,
    deliveryLagMinutesTo: 180,
  },
  // Sentinel-3 SLSTR: S3A and S3B share a 10:00 descending node in one plane, 1420 km
  // swath each, 14.26 orbits/day. Neither tiles Bulgaria alone — together they do, which
  // is what §A3's "~daily day + night passes" means, so the pair is modelled as one look
  // per phase carrying both swaths. §A3 documents NRT as "< 3 h"; only the upper bound is
  // documented, so the lower one is a placeholder.
  {
    source: 'eumetsat:slstr:frp',
    passes: [
      { phase: 'day', localSolarHour: 10.54 },
      { phase: 'night', localSolarHour: 21.46 },
    ],
    effectiveSwathKm: 2840,
    trackSpacingDegLon: 25.24,
    deliveryLagMinutesFrom: 60,
    deliveryLagMinutesTo: 180,
  },
];

/**
 * Checks the table at module load, so a malformed row is a boot failure rather than a
 * source that silently never contributes a miss. Exported because the tests have to be
 * able to build a bad table on purpose.
 */
export function validate(table: PassTable): PassTable {
  assertBoundingBox(table.modelledArea);
  const metric = table.metric;
  if (!Number.isFinite(metric.referenceLatDeg) || Math.abs(metric.referenceLatDeg) > 90) {
    throw new RangeError(
      `pass table reference latitude ${String(metric.referenceLatDeg)} is not a latitude`,
    );
  }
  if (!(metric.kmPerDegreeLonAtReference > 0)) {
    throw new RangeError('pass table metric must have a positive longitudinal scale');
  }

  const seen = new Set<SourceId>();
  for (const model of table.sources) {
    const registry = SOURCE_REGISTRY[model.source];
    if (seen.has(model.source)) {
      throw new RangeError(`pass table lists ${model.source} twice`);
    }
    seen.add(model.source);
    // A GEO row here would be double-counted the moment the accumulator also applied the
    // 10-minute-slot rule, which is the one thing this table must never make possible.
    if (registry.productTier === 'GEO') {
      throw new RangeError(`${model.source} is geostationary and has no overpasses to model`);
    }
    if (!(model.effectiveSwathKm > 0) || !(model.trackSpacingDegLon > 0)) {
      throw new RangeError(`${model.source} has a non-positive swath or track spacing`);
    }
    if (
      !(model.deliveryLagMinutesFrom >= 0) ||
      !(model.deliveryLagMinutesTo > model.deliveryLagMinutesFrom)
    ) {
      throw new RangeError(`${model.source} has a delivery lag band that is empty or negative`);
    }
    const phases = new Set<DiurnalPhase>();
    for (const pass of model.passes) {
      if (!(pass.localSolarHour >= 0) || !(pass.localSolarHour < 24)) {
        throw new RangeError(
          `${model.source} has a local solar hour outside [0, 24): ${String(pass.localSolarHour)}`,
        );
      }
      phases.add(pass.phase);
    }
    // Both halves of the day, because `requireBothDiurnalPhases` is a hard condition on
    // leaving `active`: a source that could only ever contribute one phase would make that
    // condition depend on which sources happen to be flying rather than on observation.
    if (!phases.has('day') || !phases.has('night')) {
      throw new RangeError(`${model.source} must model both a day and a night pass`);
    }
  }
  return table;
}

/**
 * The table. The `_v0` is load-bearing: every number in it is either documented cadence or
 * a stated placeholder, and the refit against WP1's measured arrival times lands as
 * `pass_table_v1` rather than as an edit in place — so a `no_longer_detected` transition
 * archived this season stays readable as the model that produced it.
 */
export const PASS_TABLE: VersionedConfig<PassTable> = defineConfig(
  'pass_table',
  'pass_table_v0',
  validate({
    modelledArea: POLLING_BBOX.values,
    metric: {
      referenceLatDeg: 42.7,
      kmPerDegreeLonAtReference: 81.936,
      kmPerDegreeLonPerDegreeLat: -1.3146,
    },
    sources: SOURCES,
  }),
);

/** Kilometres per degree of longitude at `latDeg`, on the table's plane. */
export function kmPerDegreeLon(latDeg: number, metric: PassTableMetric): number {
  return (
    metric.kmPerDegreeLonAtReference +
    metric.kmPerDegreeLonPerDegreeLat * (latDeg - metric.referenceLatDeg)
  );
}

/**
 * Looks per phase per UTC day the source's swath guarantees at `latDeg`: swath width over
 * the ground distance between consecutive tracks. At or above 1 every point is seen; below
 * 1 the value is the fraction of longitudes that are, and the model declines to pretend
 * this particular point is one of them.
 *
 * This is where latitude enters. The tracks are a fixed number of degrees apart, so they
 * converge poleward in kilometres and a fixed swath tiles more of the surface the further
 * north the point is — 1.39 at 39° N against 1.56 at 46° N for VIIRS. The fractional part
 * is the second look this model deliberately does not emit.
 */
export function assuredDailyLooks(
  model: PolarSourceModel,
  latDeg: number,
  metric: PassTableMetric,
): number {
  const kmPerDegree = kmPerDegreeLon(latDeg, metric);
  if (!(kmPerDegree > 0)) {
    throw new RangeError(`the table's plane has no longitudinal scale at ${String(latDeg)}°`);
  }
  return model.effectiveSwathKm / (model.trackSpacingDegLon * kmPerDegree);
}

/** Is `at` inside the region the table was fitted for, edges included? */
export function isInsideModelledArea(at: Coordinate, area: BoundingBox): boolean {
  if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) {
    throw new RangeError(
      `pass predictor needs a finite coordinate, got (${String(at.lat)}, ${String(at.lon)})`,
    );
  }
  return at.lat >= area.south && at.lat <= area.north && at.lon >= area.west && at.lon <= area.east;
}

/**
 * The instant a `retired` source stops contributing, or `null` while it is active. UTC
 * midnight of the effective date: the registry records a date, and the only defensible
 * reading of "retired from that date" is that the whole of the previous day still counts.
 */
export function retirementInstantMs(source: SourceId): EpochMs | null {
  const entry = SOURCE_REGISTRY[source];
  if (entry.status !== 'retired') return null;
  return epochMsFromIso(`${entry.statusEffectiveFrom}T00:00:00Z`);
}

/**
 * Milliseconds past UTC midnight at which a pass of nominal local solar time
 * `localSolarHour` crosses `lonDeg`. Four minutes per degree of longitude, wrapped into
 * the day and rounded to the whole minute.
 */
function offsetMsOf(localSolarHour: number, lonDeg: number): number {
  const raw = localSolarHour * 60 - lonDeg * 4;
  const wrapped = ((raw % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  // The wrap can land exactly on 1440 when `raw` is a whole negative multiple of a day, and
  // a pass at 24:00 belongs to the next day, not to the end of this one.
  return (Math.round(wrapped) % MINUTES_PER_DAY) * MS_PER_MINUTE;
}

function assertInstant(value: EpochMs, what: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${what} must be a finite epoch millisecond, got ${String(value)}`);
  }
}

/**
 * `(atMs, source)`, with the source compared as a string rather than by registry position:
 * the registry is append-only, so a positional order would make today's sort depend on the
 * order rows were added in, and a future append would silently reorder an archived report.
 */
function compareExpectedPasses(a: ExpectedPass, b: ExpectedPass): number {
  if (a.atMs !== b.atMs) return a.atMs - b.atMs;
  if (a.source < b.source) return -1;
  if (a.source > b.source) return 1;
  return 0;
}

/**
 * The v0 predictor. Pure: the table, the coordinate and the instants are the whole input,
 * so a replay of last September reaches last September's answer on any machine.
 */
export function staticPassPredictor(table: VersionedConfig<PassTable> = PASS_TABLE): PassPredictor {
  const model = table.values;
  const retiredFrom = new Map<SourceId, EpochMs>();
  let maxLagMs = 0;
  for (const source of model.sources) {
    const instant = retirementInstantMs(source.source);
    if (instant !== null) retiredFrom.set(source.source, instant);
    maxLagMs = Math.max(maxLagMs, source.deliveryLagMinutesTo * MS_PER_MINUTE);
  }
  const lagBySource = new Map<SourceId, PolarSourceModel>(
    model.sources.map((source) => [source.source, source]),
  );

  function expectedPasses(at: Coordinate, fromMs: EpochMs, toMs: EpochMs): readonly ExpectedPass[] {
    assertInstant(fromMs, 'fromMs');
    assertInstant(toMs, 'toMs');
    if (toMs < fromMs) {
      throw new RangeError(
        `a pass window ends before it starts: ${String(fromMs)}..${String(toMs)}`,
      );
    }
    // Half-open, so an empty interval is empty rather than a point.
    if (toMs === fromMs) return [];
    const firstDay = Math.floor(fromMs / MS_PER_DAY);
    const lastDay = Math.floor((toMs - 1) / MS_PER_DAY);
    if (lastDay - firstDay > MAX_WINDOW_DAYS) {
      throw new RangeError(
        `a pass window of ${String(lastDay - firstDay + 1)} days exceeds the ` +
          `${String(MAX_WINDOW_DAYS)}-day limit`,
      );
    }
    if (!isInsideModelledArea(at, model.modelledArea)) return [];

    const passes: ExpectedPass[] = [];
    for (const source of model.sources) {
      if (assuredDailyLooks(source, at.lat, model.metric) < 1) continue;
      const retired = retiredFrom.get(source.source);
      for (const nominal of source.passes) {
        const offsetMs = offsetMsOf(nominal.localSolarHour, at.lon);
        for (let day = firstDay; day <= lastDay; day += 1) {
          const atMs = day * MS_PER_DAY + offsetMs;
          if (atMs < fromMs || atMs >= toMs) continue;
          if (retired !== undefined && atMs >= retired) continue;
          passes.push({ source: source.source, atMs, phase: nominal.phase });
        }
      }
    }
    passes.sort(compareExpectedPasses);
    return passes;
  }

  /**
   * The next delivery, which is not the same question as the next overpass — the pass that
   * happened twenty minutes ago is the one the user will next learn from, so the search
   * deliberately reaches back by a lag before `fromMs` and asks when *its* data is due.
   *
   * **The returned window may already have opened**, and that is deliberate. GLOSSARY §3b
   * is normative here: "the freshness chip is a promise about the user, not the satellite"
   * — the range is when we expect the *user* to know more. A delivery in progress is
   * precisely a period in which the user may know more at any moment, so the qualifying
   * test is that the window has not yet *elapsed* (`toMs > fromMs`), not that it has not
   * yet started.
   *
   * The stricter reading — only windows opening after `fromMs` — was rejected: at 13:00,
   * with a pass's data still landing until 14:13, it would skip that window and answer
   * with the following overpass, telling the user to wait half a day for something that
   * may arrive in minutes. That is false pessimism in the one case the chip exists to get
   * right, and worse than a range whose start is behind us. Whether the rendered start is
   * clamped to "now" is the client's decision; the port does not pre-empt it.
   *
   * `null` when nothing qualifies inside the horizon. It is a real answer, not a failure:
   * it renders `freshness_chip_unknown`, and the alternative — widening the horizon until
   * something turns up — would be inventing the range the chip is forbidden to guess.
   */
  function nextWindow(at: Coordinate, fromMs: EpochMs): PassWindow | null {
    assertInstant(fromMs, 'fromMs');
    if (!isInsideModelledArea(at, model.modelledArea)) return null;

    const candidates = expectedPasses(at, fromMs - maxLagMs, fromMs + NEXT_WINDOW_HORIZON_MS);
    let best: PassWindow | null = null;
    for (const pass of candidates) {
      const source = lagBySource.get(pass.source);
      if (source === undefined) continue;
      const window: PassWindow = {
        fromMs: pass.atMs + source.deliveryLagMinutesFrom * MS_PER_MINUTE,
        toMs: pass.atMs + source.deliveryLagMinutesTo * MS_PER_MINUTE,
      };
      if (window.toMs <= fromMs) continue;
      // `candidates` is already in `(atMs, source)` order, so taking only strict
      // improvements leaves a tie with the earlier sort key — the same window on every run.
      if (best === null || window.fromMs < best.fromMs) best = window;
    }
    return best;
  }

  return { tableVersion: table.version, expectedPasses, nextWindow };
}
