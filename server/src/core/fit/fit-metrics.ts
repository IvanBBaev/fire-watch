/**
 * The §4.2 clustering metrics over the EFFIS-labelled population (TASKS D7; review 11
 * §4.2; GATES §2).
 *
 * Every metric is accumulated as additive counts (a {@link Tally}) per *view* — a scope
 * (which detections) × a size stratum — so seasons pool by addition, and the pooled fit
 * number is exactly the number one big season would have produced. Rates come out as
 * `Rate` (`core/qa/rate.ts`): an empty denominator is `null`, never 0 or 1, and an
 * unmeasured gate input fails.
 *
 * Definitions (11 §4.2, with every open choice closed here and repeated in the report):
 *
 * - **Pairwise recall**: of same-fire labelled pairs, the fraction in the same event.
 *   Counted from per-fire × per-event tallies (`Σ C(n_fe, 2) / C(n_f, 2)`), never by
 *   enumerating pairs — a 5,000-detection fire is 12.5 M pairs.
 * - **Pairwise precision**: of hard-negative pairs (`season-frame.ts`), the fraction in
 *   different events. A pair's stratum is the stratum of the *smaller* fire: a merge
 *   across two fires hurts the small one, which is the one the bottom-stratum gate is
 *   about.
 * - **Over-split index**: per fire, the number of events holding ≥ 10 % of its labelled
 *   detections (integer basis-point test, so exactly 10 % counts). If no event reaches
 *   10 % — a fire scattered thinly over many events — the index is the number of distinct
 *   events, the honest upper reading rather than 0. A fire none of whose detections is in
 *   any event (GEO-only labels that attached nowhere) has no index; it is counted as
 *   `firesWithoutEvent`, not as 0 or 1.
 * - **Chimera rate**: of events with ≥ 1 labelled member (`judged`), the fraction where
 *   ≥ 2 fires each hold ≥ 10 % of the event's labelled members. Stratum: the fire with the
 *   largest share (ties: lower fire id).
 * - **Timeline agreement**: per fire, the event holding most of its labelled detections
 *   (ties: earliest `started_at`, then lowest event id) — its `started_at` within ± 12 h
 *   of the fire's first labelled detection, inclusive. A fire with no event is a miss.
 * - **ARI** over labelled detections; rows in no event are singletons.
 * - **Event count**: distinct events over all detections, labelled or not — the input to
 *   the plateau's event-count stability.
 *
 * Scopes (GATES §2 "per-source metrics next to every pooled number"):
 * `all`; `source:<id>` — pairs with both ends from that source, fires and events
 * restricted to that source's detections; `cross_source` — pairs whose ends differ in
 * source (pairs only; a fire has no cross-source "subset"); `attach_only` — the GEO
 * sources together, the scope the ε_geo exemption is judged on.
 *
 * Strata: each `sizeStrata` id, and `pooled` = the gated strata together. A sub-10 ha
 * fire's samples are reported under its stratum and stay out of `pooled`.
 */

import { quantileOf, type Quantile } from '../qa/quantile.js';
import { meetsAtLeast, meetsAtMost, quantizeRate, rateOf, type Rate } from '../qa/rate.js';
import { NO_EVENT, type SeasonPartition } from './fit-clustering.js';
import type { FitParams } from './fit-params.js';
import type { SeasonFrame } from './season-frame.js';

const HOUR_MS = 3_600_000;

export const POOLED = 'pooled';
export const SCOPE_ALL = 'all';
export const SCOPE_CROSS = 'cross_source';
export const SCOPE_ATTACH_ONLY = 'attach_only';

export interface Tally {
  recallSame: number;
  recallPairs: number;
  precisionSeparated: number;
  precisionPairs: number;
  overSplit: number[];
  firesWithoutEvent: number;
  chimeraEvents: number;
  judgedEvents: number;
  timelineWithin: number;
  timelineFires: number;
  /** ARI sums: Σ C(n_ij,2), Σ C(a_i,2) (fires), Σ C(b_j,2) (events), n. */
  ariPairsBoth: number;
  ariPairsFire: number;
  ariPairsEvent: number;
  ariN: number;
}

/** `scope|stratum` → tally. */
export type Tallies = Map<string, Tally>;

export interface SeasonEvaluation {
  readonly season: number;
  readonly eventCount: number;
  readonly tallies: Tallies;
}

export function viewKey(scope: string, stratum: string): string {
  return `${scope}|${stratum}`;
}

function emptyTally(): Tally {
  return {
    recallSame: 0,
    recallPairs: 0,
    precisionSeparated: 0,
    precisionPairs: 0,
    overSplit: [],
    firesWithoutEvent: 0,
    chimeraEvents: 0,
    judgedEvents: 0,
    timelineWithin: 0,
    timelineFires: 0,
    ariPairsBoth: 0,
    ariPairsFire: 0,
    ariPairsEvent: 0,
    ariN: 0,
  };
}

const c2 = (n: number): number => (n * (n - 1)) / 2;

/** Scores one season's partition against its frame. */
export function evaluateSeason(
  frame: SeasonFrame,
  partition: SeasonPartition,
  params: FitParams,
): SeasonEvaluation {
  const tallies: Tallies = new Map();
  const strataOf = (stratum: string, gated: boolean): string[] =>
    gated ? [stratum, POOLED] : [stratum];
  const at = (scope: string, stratum: string): Tally => {
    const key = viewKey(scope, stratum);
    let tally = tallies.get(key);
    if (tally === undefined) {
      tally = emptyTally();
      tallies.set(key, tally);
    }
    return tally;
  };
  const bp = params.shareBasisPoints;
  const reaches = (count: number, total: number): boolean => count * 10_000 >= bp * total;
  const sourceScope = (i: number): string =>
    `source:${(frame.detections[i] as { source: string }).source}`;
  /** Fire- and event-level scopes a detection belongs to. */
  const memberScopes = (i: number): string[] =>
    frame.attachOnly[i] === true
      ? [SCOPE_ALL, sourceScope(i), SCOPE_ATTACH_ONLY]
      : [SCOPE_ALL, sourceScope(i)];

  // ── Group labelled detections by fire, and by event ────────────────────────────────
  const fireMembers: number[][] = frame.fires.map(() => []);
  const eventMembers = new Map<number, number[]>();
  frame.fireIndex.forEach((f, i) => {
    if (f < 0) return;
    (fireMembers[f] as number[]).push(i);
    const e = partition.eventOf[i] as number;
    if (e === NO_EVENT) return;
    const list = eventMembers.get(e);
    if (list === undefined) eventMembers.set(e, [i]);
    else list.push(i);
  });

  // ── Fire-level: recall, over-split, timeline, ARI ──────────────────────────────────
  frame.fires.forEach((fire, f) => {
    const members = fireMembers[f] as number[];
    const strata = strataOf(fire.stratum, fire.gated);
    // Per scope: total count, per-event counts, first acq.
    const byScope = new Map<string, { n: number; events: Map<number, number>; firstMs: number }>();
    // Cross-source recall needs the per-event per-source split.
    const perEventSource = new Map<number, Map<string, number>>();
    const perSource = new Map<string, number>();
    for (const i of members) {
      const e = partition.eventOf[i] as number;
      const src = sourceScope(i);
      perSource.set(src, (perSource.get(src) ?? 0) + 1);
      if (e !== NO_EVENT) {
        let m = perEventSource.get(e);
        if (m === undefined) {
          m = new Map();
          perEventSource.set(e, m);
        }
        m.set(src, (m.get(src) ?? 0) + 1);
      }
      for (const scope of memberScopes(i)) {
        let entry = byScope.get(scope);
        if (entry === undefined) {
          entry = { n: 0, events: new Map(), firstMs: Infinity };
          byScope.set(scope, entry);
        }
        entry.n += 1;
        entry.firstMs = Math.min(entry.firstMs, frame.acqMs[i] as number);
        if (e !== NO_EVENT) entry.events.set(e, (entry.events.get(e) ?? 0) + 1);
      }
    }

    for (const [scope, entry] of byScope) {
      let same = 0;
      for (const count of entry.events.values()) same += c2(count);
      const ranked = [...entry.events.entries()];
      let index: number | null = null;
      if (ranked.length > 0) {
        const holding = ranked.filter(([, count]) => reaches(count, entry.n)).length;
        index = holding > 0 ? holding : ranked.length;
      }
      let within = false;
      if (ranked.length > 0) {
        ranked.sort(
          ([ea, ca], [eb, cb]) =>
            cb - ca ||
            (partition.startedAt.get(ea) as number) - (partition.startedAt.get(eb) as number) ||
            ea - eb,
        );
        const dominant = (ranked[0] as [number, number])[0];
        const started = partition.startedAt.get(dominant) as number;
        within = Math.abs(started - entry.firstMs) <= params.timelineToleranceHours * HOUR_MS;
      }
      for (const stratum of strata) {
        const t = at(scope, stratum);
        t.recallSame += same;
        t.recallPairs += c2(entry.n);
        if (index === null) t.firesWithoutEvent += 1;
        else t.overSplit.push(index);
        t.timelineFires += 1;
        if (within) t.timelineWithin += 1;
        t.ariPairsBoth += same;
        t.ariPairsFire += c2(entry.n);
        t.ariN += entry.n;
      }
    }

    // Cross-source pairs: all pairs minus same-source pairs, likewise for same-event.
    let crossPairs = c2(members.length);
    for (const n of perSource.values()) crossPairs -= c2(n);
    if (crossPairs > 0) {
      let crossSame = 0;
      for (const m of perEventSource.values()) {
        let total = 0;
        let sameSource = 0;
        for (const n of m.values()) {
          total += n;
          sameSource += c2(n);
        }
        crossSame += c2(total) - sameSource;
      }
      for (const stratum of strata) {
        const t = at(SCOPE_CROSS, stratum);
        t.recallSame += crossSame;
        t.recallPairs += crossPairs;
      }
    }
  });

  // ── Event-level: chimera, and the event side of ARI ────────────────────────────────
  for (const [, members] of [...eventMembers.entries()].sort(([a], [b]) => a - b)) {
    const byScope = new Map<string, Map<number, number>>();
    for (const i of members) {
      const f = frame.fireIndex[i] as number;
      for (const scope of memberScopes(i)) {
        let m = byScope.get(scope);
        if (m === undefined) {
          m = new Map();
          byScope.set(scope, m);
        }
        m.set(f, (m.get(f) ?? 0) + 1);
      }
    }
    for (const [scope, perFire] of byScope) {
      let total = 0;
      for (const n of perFire.values()) total += n;
      let holders = 0;
      let lead = -1;
      let leadCount = -1;
      for (const [f, n] of perFire) {
        if (reaches(n, total)) holders += 1;
        const leadId = lead < 0 ? '' : (frame.fires[lead] as { fireId: string }).fireId;
        const id = (frame.fires[f] as { fireId: string }).fireId;
        if (n > leadCount || (n === leadCount && id < leadId)) {
          lead = f;
          leadCount = n;
        }
      }
      const leadFire = frame.fires[lead] as { stratum: string; gated: boolean };
      for (const stratum of strataOf(leadFire.stratum, leadFire.gated)) {
        const t = at(scope, stratum);
        t.judgedEvents += 1;
        if (holders >= 2) t.chimeraEvents += 1;
      }
      // ARI's event marginal is per stratum of each member's own fire.
      const perStratum = new Map<string, number>();
      for (const [f, n] of perFire) {
        const fire = frame.fires[f] as { stratum: string; gated: boolean };
        for (const stratum of strataOf(fire.stratum, fire.gated)) {
          perStratum.set(stratum, (perStratum.get(stratum) ?? 0) + n);
        }
      }
      for (const [stratum, n] of perStratum) at(scope, stratum).ariPairsEvent += c2(n);
    }
  }

  // ── Hard negatives: precision ──────────────────────────────────────────────────────
  const { a, b } = frame.hardNegatives;
  for (let k = 0; k < a.length; k += 1) {
    const i = a[k] as number;
    const j = b[k] as number;
    const ei = partition.eventOf[i] as number;
    const ej = partition.eventOf[j] as number;
    const separated = ei === NO_EVENT || ej === NO_EVENT || ei !== ej;
    const fi = frame.fires[frame.fireIndex[i] as number] as {
      fireId: string;
      areaHa: number;
      stratum: string;
      gated: boolean;
    };
    const fj = frame.fires[frame.fireIndex[j] as number] as typeof fi;
    const smaller =
      fi.areaHa < fj.areaHa || (fi.areaHa === fj.areaHa && fi.fireId < fj.fireId) ? fi : fj;
    const si = sourceScope(i);
    const sj = sourceScope(j);
    const scopes =
      si === sj
        ? frame.attachOnly[i] === true
          ? [SCOPE_ALL, si, SCOPE_ATTACH_ONLY]
          : [SCOPE_ALL, si]
        : frame.attachOnly[i] === true && frame.attachOnly[j] === true
          ? [SCOPE_ALL, SCOPE_CROSS, SCOPE_ATTACH_ONLY]
          : [SCOPE_ALL, SCOPE_CROSS];
    for (const scope of scopes) {
      for (const stratum of strataOf(smaller.stratum, smaller.gated)) {
        const t = at(scope, stratum);
        t.precisionPairs += 1;
        if (separated) t.precisionSeparated += 1;
      }
    }
  }

  return { season: frame.season, eventCount: partition.eventCount, tallies };
}

/** Sums seasons into one evaluation (the pooled fit number over 2020–23). */
export function poolEvaluations(evaluations: readonly SeasonEvaluation[]): {
  readonly eventCount: number;
  readonly tallies: Tallies;
} {
  const tallies: Tallies = new Map();
  let eventCount = 0;
  for (const evaluation of evaluations) {
    eventCount += evaluation.eventCount;
    for (const [key, t] of evaluation.tallies) {
      const sum = tallies.get(key) ?? emptyTally();
      sum.recallSame += t.recallSame;
      sum.recallPairs += t.recallPairs;
      sum.precisionSeparated += t.precisionSeparated;
      sum.precisionPairs += t.precisionPairs;
      sum.overSplit = sum.overSplit.concat(t.overSplit);
      sum.firesWithoutEvent += t.firesWithoutEvent;
      sum.chimeraEvents += t.chimeraEvents;
      sum.judgedEvents += t.judgedEvents;
      sum.timelineWithin += t.timelineWithin;
      sum.timelineFires += t.timelineFires;
      sum.ariPairsBoth += t.ariPairsBoth;
      sum.ariPairsFire += t.ariPairsFire;
      sum.ariPairsEvent += t.ariPairsEvent;
      sum.ariN += t.ariN;
      tallies.set(key, sum);
    }
  }
  return { eventCount, tallies };
}

export interface MetricView {
  readonly pairwiseRecall: Rate;
  readonly pairwisePrecision: Rate;
  /** Harmonic mean of recall and precision; `null` unless both are measured and non-zero. */
  readonly pairwiseF1: number | null;
  readonly overSplitMean: number | null;
  readonly overSplitP95: Quantile;
  readonly firesWithoutEvent: number;
  readonly chimeraRate: Rate;
  readonly timelineAgreement: Rate;
  readonly ari: number | null;
  /** Fires judged (each fire is one timeline sample). */
  readonly fires: number;
}

export function viewOf(tally: Tally | undefined): MetricView {
  const t = tally ?? emptyTally();
  const recall = rateOf(t.recallSame, t.recallPairs);
  const precision = rateOf(t.precisionSeparated, t.precisionPairs);
  const f1 =
    recall.rate !== null && precision.rate !== null && recall.rate + precision.rate > 0
      ? (2 * recall.rate * precision.rate) / (recall.rate + precision.rate)
      : null;
  const sum = t.overSplit.reduce((acc, v) => acc + v, 0);
  return {
    pairwiseRecall: recall,
    pairwisePrecision: precision,
    pairwiseF1: f1,
    overSplitMean: t.overSplit.length === 0 ? null : sum / t.overSplit.length,
    overSplitP95: quantileOf(t.overSplit, 0.95),
    firesWithoutEvent: t.firesWithoutEvent,
    chimeraRate: rateOf(t.chimeraEvents, t.judgedEvents),
    timelineAgreement: rateOf(t.timelineWithin, t.timelineFires),
    ari: adjustedRand(t),
    fires: t.timelineFires,
  };
}

/** Hubert–Arabie ARI from the pair sums; `null` when it is undefined (0/0). */
export function adjustedRand(t: Tally): number | null {
  const total = c2(t.ariN);
  if (total === 0) return null;
  const expected = (t.ariPairsFire * t.ariPairsEvent) / total;
  const max = (t.ariPairsFire + t.ariPairsEvent) / 2;
  if (max - expected === 0) return null;
  return (t.ariPairsBoth - expected) / (max - expected);
}

export interface ThresholdCheck {
  readonly metric: string;
  readonly target: string;
  /** `null` = unmeasured, which fails the gate (an unmeasured pass is not a pass). */
  readonly met: boolean | null;
}

export interface ViewVerdict {
  readonly view: string;
  readonly checks: readonly ThresholdCheck[];
  readonly pass: boolean;
}

export interface Verdict {
  /** Pooled (gated strata) and the bottom stratum, both on scope `all`. */
  readonly views: readonly ViewVerdict[];
  readonly pass: boolean;
}

export function judgeView(name: string, view: MetricView, params: FitParams): ViewVerdict {
  const th = params.thresholds;
  const mean = view.overSplitMean;
  const p95 = view.overSplitP95.value;
  const checks: ThresholdCheck[] = [
    {
      metric: 'pairwise_recall',
      target: `>= ${String(th.pairwiseRecallMin)}`,
      met: meetsAtLeast(view.pairwiseRecall, th.pairwiseRecallMin),
    },
    {
      metric: 'pairwise_precision',
      target: `>= ${String(th.pairwisePrecisionMin)}`,
      met: meetsAtLeast(view.pairwisePrecision, th.pairwisePrecisionMin),
    },
    {
      metric: 'over_split_mean',
      target: `<= ${String(th.overSplitMeanMax)}`,
      met: mean === null ? null : quantizeRate(mean) <= quantizeRate(th.overSplitMeanMax),
    },
    {
      metric: 'over_split_p95',
      target: `<= ${String(th.overSplitP95Max)}`,
      met: p95 === null ? null : p95 <= th.overSplitP95Max,
    },
    {
      metric: 'chimera_rate',
      target: `<= ${String(th.chimeraRateMax)}`,
      met: meetsAtMost(view.chimeraRate, th.chimeraRateMax),
    },
    {
      metric: 'timeline_agreement',
      target: `>= ${String(th.timelineAgreementMin)}`,
      met: meetsAtLeast(view.timelineAgreement, th.timelineAgreementMin),
    },
  ];
  return { view: name, checks, pass: checks.every((c) => c.met === true) };
}

/**
 * GATES §2: the pooled view and the bottom stratum must both meet every target. A pooled
 * pass with a failing — or unmeasured — bottom stratum is a fail. Per-source views are
 * reported next to these, not gated: the gate is stated on the pooled number.
 */
export function verdictOf(tallies: Tallies, params: FitParams): Verdict {
  const views = [
    judgeView(viewKey(SCOPE_ALL, POOLED), viewOf(tallies.get(viewKey(SCOPE_ALL, POOLED))), params),
    judgeView(
      viewKey(SCOPE_ALL, params.bottomStratumId),
      viewOf(tallies.get(viewKey(SCOPE_ALL, params.bottomStratumId))),
      params,
    ),
  ];
  return { views, pass: views.every((v) => v.pass) };
}

/** Every view present, in a stable order: scope `all` first, then by key. */
export function allViews(tallies: Tallies): { readonly key: string; readonly view: MetricView }[] {
  return [...tallies.keys()]
    .sort((x, y) => {
      const ax = x.startsWith(`${SCOPE_ALL}|`) ? 0 : 1;
      const ay = y.startsWith(`${SCOPE_ALL}|`) ? 0 : 1;
      return ax - ay || (x < y ? -1 : x > y ? 1 : 0);
    })
    .map((key) => ({ key, view: viewOf(tallies.get(key)) }));
}
