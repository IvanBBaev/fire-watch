/**
 * The freshness budget table (OPERATIONS §1.2 and §1.3), as versioned data.
 *
 * §1.1(3) is the reason this is one table and not four constants: the health endpoint, the
 * Grafana rules, the freshness metadata stamped into every payload and the client's
 * staleness banner all have to agree on when a feed is late, and the only way to keep four
 * consumers in agreement is to give them one source. It is a {@link VersionedConfig} for
 * the same reason the clustering parameters are: a threshold that changes must change
 * visibly, with a digest a page can cite.
 *
 * ## What the numbers mean, and what they deliberately do not
 *
 * Every budget is measured on **`last_success_at` — the moment the provider last answered
 * us** — and never on the age of the observation inside the answer (§1.1(1)). The
 * difference is the whole point: satellites are late by nature, and a budget on observation
 * age would page every time a polar orbit did what polar orbits do. What we are entitled to
 * hold a provider to is that it keeps answering.
 *
 * `warn` sits at roughly two to four nominal cycles — long enough that one skipped poll is
 * not an alert, short enough that a real stall is caught inside a fire's growth window.
 * `critical` is roughly twice `warn`.
 *
 * `pages` is the narrow question of whether *this endpoint* may return 500 for the row, not
 * whether anyone is woken up. Two rows here are deliberately `false` while still being
 * monitored: the weather context and Sentinel-3 SLSTR degrade the product without blinding
 * it (§1.2), and a backup that is late pages through healthchecks.io instead, because
 * "one paging condition, one primary leg" (§1.3) — a 500 here would be a second leg for a
 * condition that already has one, and two legs for one condition is how an outage gets
 * acknowledged twice and fixed zero times.
 *
 * A budget that can never be met again is a config change, never a permanently muted rule
 * (§1.1(4)): a retired source leaves {@link MONITORED_SOURCE_IDS}, and with it this table.
 */

import { BUDGETED_JOB_IDS, MONITORED_FEED_IDS, type FreshnessRowId } from '@fire-watch/contracts';

import { defineConfig, type VersionedConfig } from './versioned-config.js';

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/** One row's thresholds. */
export interface FreshnessBudget {
  readonly row: FreshnessRowId;
  /**
   * How often the row is expected to move, from the provider's published cadence or our
   * own schedule. Reported so a page can say "20 minutes, which is four cycles" rather
   * than just "20 minutes"; never used in the verdict.
   */
  readonly nominalCadenceSeconds: number | null;
  readonly warnSeconds: number;
  readonly criticalSeconds: number;
  /** Whether passing `criticalSeconds` may turn `/api/health/freshness` into a 500. */
  readonly pages: boolean;
}

/**
 * A known upstream outage, silenced for at most 24 h with a reason (§1.1(6)).
 *
 * Three properties are load-bearing and all three are enforced below. It **expires on its
 * own** — an operator who forgets is not how monitoring comes back. It **carries a
 * reason**, because a mute nobody can explain in six weeks is indistinguishable from a bug.
 * And it is **data in this config**, so adding one bumps the digest and is a recorded
 * change rather than a click in a dashboard.
 */
export interface FreshnessMute {
  readonly row: FreshnessRowId;
  readonly fromIso: string;
  readonly untilIso: string;
  readonly reason: string;
}

export interface FreshnessBudgetTable {
  readonly rows: readonly FreshnessBudget[];
  readonly mutes: readonly FreshnessMute[];
}

/** The §1.1(6) ceiling. Longer than a working day, shorter than a forgettable weekend. */
export const MAX_MUTE_SECONDS = 24 * HOUR;

const ROWS: readonly FreshnessBudget[] = [
  // FIRMS Area API, polled every 5 minutes. Warn at four cycles: the API is routinely slow
  // for one, and paging on one is how a rota learns to ignore the pager.
  {
    row: 'firms:viirs:snpp',
    nominalCadenceSeconds: 5 * MINUTE,
    warnSeconds: 20 * MINUTE,
    criticalSeconds: 45 * MINUTE,
    pages: true,
  },
  {
    row: 'firms:viirs:noaa20',
    nominalCadenceSeconds: 5 * MINUTE,
    warnSeconds: 20 * MINUTE,
    criticalSeconds: 45 * MINUTE,
    pages: true,
  },
  {
    row: 'firms:viirs:noaa21',
    nominalCadenceSeconds: 5 * MINUTE,
    warnSeconds: 20 * MINUTE,
    criticalSeconds: 45 * MINUTE,
    pages: true,
  },

  // Geostationary FRP: a 15-minute product that lands about 30 minutes after the slot it
  // describes. The budget is on the *arrival* of the next product, not on that latency —
  // 30 minutes of inherent lateness is the product working as designed.
  {
    row: 'lsasaf:seviri:frp-pixel',
    nominalCadenceSeconds: 15 * MINUTE,
    warnSeconds: 30 * MINUTE,
    criticalSeconds: 60 * MINUTE,
    pages: true,
  },
  {
    row: 'lsasaf:fci:frp-pixel',
    nominalCadenceSeconds: 15 * MINUTE,
    warnSeconds: 30 * MINUTE,
    criticalSeconds: 60 * MINUTE,
    pages: true,
  },

  // Sentinel-3 SLSTR is roughly daily over the box. Late SLSTR degrades the archive; it
  // does not blind the map, so it never 500s.
  {
    row: 'eumetsat:slstr:frp',
    nominalCadenceSeconds: 24 * HOUR,
    warnSeconds: 6 * HOUR,
    criticalSeconds: 12 * HOUR,
    pages: false,
  },

  // Cloud mask (MTG FCI L2 CLM / MSG SEVIRI CLM), 15-minute cadence but a wider budget:
  // WP1 only records it, so a gap costs evidence rather than availability.
  {
    row: 'eumetsat:clm',
    nominalCadenceSeconds: 15 * MINUTE,
    warnSeconds: 45 * MINUTE,
    criticalSeconds: 90 * MINUTE,
    pages: true,
  },

  // EFFIS refreshes daily. 26 h tolerates one missed day plus the hours a European daily
  // product can drift; 50 h is two missed days, by which point the danger layer is fiction.
  {
    row: 'effis:layers',
    nominalCadenceSeconds: 24 * HOUR,
    warnSeconds: 26 * HOUR,
    criticalSeconds: 50 * HOUR,
    pages: true,
  },

  // Weather context refreshes hourly to six-hourly depending on the provider A19 settles
  // on, so the budget is set for the slowest of them. Never 500s: stale wind makes the
  // spread arrows wrong, and wrong arrows are worse than absent ones — but that is a
  // degradation tier (ADR-004), not an outage of the map.
  {
    row: 'weather:context',
    nominalCadenceSeconds: 6 * HOUR,
    warnSeconds: 6 * HOUR,
    criticalSeconds: 24 * HOUR,
    pages: false,
  },

  // The snapshot push is the only job that 500s, and 5 minutes is not a round number: it is
  // exactly where ADR-003's "the map is never more than 5 minutes stale" promise breaks.
  {
    row: 'snapshot-push',
    nominalCadenceSeconds: 1 * MINUTE,
    warnSeconds: 5 * MINUTE,
    criticalSeconds: 15 * MINUTE,
    pages: true,
  },

  // Backup lateness is a paging condition with its own primary leg (healthchecks.io). It is
  // reported here so the status page can show it, and it does not 500 (§1.3).
  {
    row: 'nightly-backup',
    nominalCadenceSeconds: 24 * HOUR,
    warnSeconds: 26 * HOUR,
    criticalSeconds: 50 * HOUR,
    pages: false,
  },

  // WAL archive lag is the difference between RPO 24 h and RPO ≤15 min (OPERATIONS §5).
  // Continuous, so it has no cadence — only a tolerated lag.
  {
    row: 'wal-archive',
    nominalCadenceSeconds: null,
    warnSeconds: 15 * MINUTE,
    criticalSeconds: 60 * MINUTE,
    pages: false,
  },

  // The EFFIS refresh job and the EFFIS feed share a condition; the feed row carries the
  // endpoint effect so that one late refresh cannot 500 twice.
  {
    row: 'effis-refresh',
    nominalCadenceSeconds: 24 * HOUR,
    warnSeconds: 26 * HOUR,
    criticalSeconds: 50 * HOUR,
    pages: false,
  },
];

/**
 * Active mutes. Empty, and expected to be empty: a mute is written when a provider has
 * announced an outage, and deleted when it ends or expires by itself.
 */
const MUTES: readonly FreshnessMute[] = [];

/**
 * The table. Bumping the `_vN` suffix is for a change of *policy* — new rows, moved
 * thresholds; the digest moves on its own for everything, including a mute, which is what
 * makes a mute a recorded change.
 */
export const FRESHNESS_BUDGETS: VersionedConfig<FreshnessBudgetTable> = defineConfig(
  'freshness_budgets',
  'freshness_budgets_v1',
  validate({ rows: ROWS, mutes: MUTES }),
);

/**
 * Checks the table at module load, so a malformed budget is a boot failure rather than a
 * verdict that quietly never fires. Exported for the tests, which have to be able to build
 * a bad table on purpose.
 */
export function validate(table: FreshnessBudgetTable): FreshnessBudgetTable {
  const expected: readonly FreshnessRowId[] = [...MONITORED_FEED_IDS, ...BUDGETED_JOB_IDS];
  const seen = new Set<string>();

  for (const budget of table.rows) {
    if (seen.has(budget.row)) {
      throw new RangeError(`freshness budget for ${budget.row} is defined twice`);
    }
    seen.add(budget.row);
    if (!expected.includes(budget.row)) {
      throw new RangeError(`freshness budget names ${budget.row}, which is not a monitored row`);
    }
    if (!Number.isInteger(budget.warnSeconds) || budget.warnSeconds <= 0) {
      throw new RangeError(`freshness budget for ${budget.row} has a non-positive warn`);
    }
    // Checked before the ordering below, because `NaN <= warnSeconds` is false: a NaN
    // critical would sail through that comparison and ship a row whose `age >= critical`
    // band can never fire — exactly the quiet non-verdict this function exists to prevent.
    if (!Number.isInteger(budget.criticalSeconds) || budget.criticalSeconds <= 0) {
      throw new RangeError(`freshness budget for ${budget.row} has a non-positive critical`);
    }
    if (budget.criticalSeconds <= budget.warnSeconds) {
      throw new RangeError(
        `freshness budget for ${budget.row} has critical ${String(budget.criticalSeconds)} ` +
          `at or below warn ${String(budget.warnSeconds)}`,
      );
    }
    const cadence = budget.nominalCadenceSeconds;
    if (cadence !== null && (!Number.isInteger(cadence) || cadence <= 0)) {
      throw new RangeError(`freshness budget for ${budget.row} has a non-positive cadence`);
    }
  }

  // A monitored row without a budget is the failure this whole file exists to prevent: it
  // would be polled, it would stop, and nothing would have a threshold to compare it to.
  const missing = expected.filter((row) => !seen.has(row));
  if (missing.length > 0) {
    throw new RangeError(`monitored rows without a freshness budget: ${missing.join(', ')}`);
  }

  for (const mute of table.mutes) validateMute(mute, seen);
  return table;
}

function validateMute(mute: FreshnessMute, known: ReadonlySet<string>): void {
  if (!known.has(mute.row)) {
    throw new RangeError(`freshness mute names ${mute.row}, which has no budget`);
  }
  if (mute.reason.trim() === '') {
    throw new RangeError(`freshness mute for ${mute.row} has no reason`);
  }
  const from = Date.parse(mute.fromIso);
  const until = Date.parse(mute.untilIso);
  if (Number.isNaN(from) || Number.isNaN(until)) {
    throw new RangeError(`freshness mute for ${mute.row} has an unparseable window`);
  }
  if (until <= from) {
    throw new RangeError(`freshness mute for ${mute.row} ends before it starts`);
  }
  if (until - from > MAX_MUTE_SECONDS * 1000) {
    throw new RangeError(
      `freshness mute for ${mute.row} lasts longer than the ${String(MAX_MUTE_SECONDS)}s cap`,
    );
  }
}

/** The budget for one row, or `undefined` when the row is not monitored by this table. */
export function budgetFor(
  row: FreshnessRowId,
  table: FreshnessBudgetTable = FRESHNESS_BUDGETS.values,
): FreshnessBudget | undefined {
  return table.rows.find((budget) => budget.row === row);
}

/**
 * The mute in force for a row at `now`, if any. A mute outside its window is inert data,
 * not a state — which is what "expires automatically" means in code.
 */
export function activeMute(
  row: FreshnessRowId,
  now: number,
  table: FreshnessBudgetTable = FRESHNESS_BUDGETS.values,
): FreshnessMute | undefined {
  return table.mutes.find(
    (mute) =>
      mute.row === row && Date.parse(mute.fromIso) <= now && now < Date.parse(mute.untilIso),
  );
}
