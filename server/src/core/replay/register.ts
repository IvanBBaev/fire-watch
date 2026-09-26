/**
 * The GATES §1.1 scenario register, as data (CI-1).
 *
 * The table in the document is the specification; this is the copy the gate can execute.
 * Keeping it here rather than deriving it from whatever directories happen to exist under
 * `server/fixtures/` is the whole point: a suite that only knows about the fixtures someone
 * wrote can never notice the one nobody wrote. CI-1 says "S1–S6 green before any change to
 * clustering, identity, lifecycle or alert-decision code merges" — an assertion about a set,
 * so the set has to be written down somewhere the code can read.
 *
 * `blockedBy` is the honest part. Some of these scenarios assert an outcome that no function
 * in this repo decides yet — a score bucket, a label, an alert — and there are only two ways
 * to hold that: pretend the entry does not exist, or record which task owes it and refuse to
 * demand the fixture until then. The second is what turns this file into a gate rather than
 * a wish, and it has already fired once: D4 landed, the five lifecycle flags cleared, and
 * the register demanded S6, S7, S8, S11 and S12 until they were authored. Clearing a flag
 * without writing the fixture is the mistake this is built to catch, so a flag is never
 * cleared "to make it pass".
 *
 * A blocked entry may still have a fixture, and S5 did. Half of a scenario is a real
 * regression test — "one detection, one event, no alert" fails loudly if identity breaks,
 * whatever the bucket ends up being called — and forbidding it would have traded a test we
 * could have for tidiness. What a partial fixture may never do is assert the missing half
 * with a plausible constant; that was enforced upstream, by `ReplayEvent.bucket` being
 * `null` for as long as nothing computed it. D12 then computed it: S5's expected bucket was
 * derived by hand from review 11 §3.5 (z = −2.163355, score = 0.103090, Unverified) and only
 * then compared with the engine, and this flag came down in that order — fixture first. S3
 * and S4 keep theirs, because the inputs their assertions turn on are still defaults.
 *
 * `provenBy` is the third state, and it exists for exactly one kind of row: a scenario the
 * register owns but a golden fixture cannot express. S15 asserts that a cursor-only client
 * converges after a removal within one full-snapshot cycle — a claim about *every* ordering
 * of polls and removals, which is a property test's job (GATES §1.1 says "fast-check" in the
 * row itself), and about the client's reconciler, which lives in `web/`. A fixture under
 * `server/fixtures/S15` would be one hand-picked ordering replayed through an engine that
 * has no client in it; demanding one would buy a directory, not a proof. So the entry names
 * the suite that does prove it, the stage that covers it reports it rather than demanding
 * it, and the CLI — which has a filesystem — refuses the gate if that suite has gone
 * missing. What it may never do is name a suite that does not assert the row: the path is
 * reviewable in one hop, which a bare "done elsewhere" would not be.
 */

import { FIXTURE_REQUIREMENTS, type FixtureRequirement } from './fixture-format.js';

export interface RegisterEntry {
  /** `S1`…`S16`, matching the fixture directory name. */
  readonly id: string;
  readonly title: string;
  /** The "Asserts" column of GATES §1.1, verbatim. */
  readonly asserts: string;
  readonly required: FixtureRequirement;
  /** The track that owes the fixture. */
  readonly owner: string;
  /**
   * `null` when every outcome this scenario asserts is decidable by code that exists.
   * Otherwise the task that owes the missing decision, in words a failure message can use.
   */
  readonly blockedBy: string | null;
  /**
   * `null` for a scenario the replay harness proves with a fixture under `server/fixtures/`.
   * Otherwise the repo-relative path of the suite that proves it instead, for a scenario
   * whose assertion is a property over every ordering rather than one golden trace. Only
   * meaningful with `blockedBy === null`: a blocked scenario is proven nowhere yet.
   */
  readonly provenBy: string | null;
}

const SCORE_INPUTS =
  'D12 landed the ADR-002 D6 score and every replayed event now carries a bucket, but the ' +
  'two inputs these scenarios turn on — the static hot-source mask hit and the ' +
  'arable-majority feature — have no field in the replay fixture format, so the identity ' +
  'engine supplies `false` and `null`; the assertion would be met by a default, not a decision';
const MASKS = 'D10 — no land-cover or static-hot-source mask data, so no event carries a label';

/**
 * GATES §1.1, in register order. The ids are the fixture directory names, which is what
 * makes "the register has an entry with no directory" a checkable sentence.
 */
export const FIXTURE_REGISTER: readonly RegisterEntry[] = Object.freeze([
  {
    id: 'S1',
    title: 'Slavyanka border-crossing',
    asserts: 'one cross-border cluster = one event',
    required: 'pre-merge',
    owner: 'WP2',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S2',
    title: 'Sakar/Harmanli merge',
    asserts: "survivor id rules; the merged id's permalink resolves 200 + mergedInto",
    required: 'pre-merge',
    owner: 'WP2',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S3',
    title: 'Agri-burn false positive',
    asserts: 'labeled likely_agri_burn, never Confirmed, no alert',
    required: 'pre-merge',
    owner: 'WP2',
    blockedBy: `${MASKS}; ${SCORE_INPUTS}`,
    provenBy: null,
  },
  {
    id: 'S4',
    title: 'Industrial static source',
    asserts: 'never becomes an event (hard override, score 0)',
    required: 'pre-merge',
    owner: 'WP2',
    blockedBy: `${MASKS}; ${SCORE_INPUTS}`,
    provenBy: null,
  },
  {
    id: 'S5',
    title: 'Single-detection noise',
    asserts: 'stays Unverified, no alert',
    required: 'pre-merge',
    owner: 'WP2',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S6',
    title: 'Megafire cooling + reignition',
    asserts: 'fuel-window relation on the same id; no false no_longer_detected; FER not charged',
    required: 'pre-merge',
    owner: 'WP2',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S7',
    title: 'Cloudy gap',
    asserts: 'E does not accrue on obscured opportunities; never reaches no_longer_detected',
    required: 'pre-season',
    owner: 'WP2',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S8',
    title: 'Transient source outage',
    asserts: 'E freezes for that source; lifecycle resumes on recovery',
    required: 'pre-season',
    owner: 'WP2',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S9',
    title: 'UTC/DST ingest boundary',
    asserts: 'acq-time handling stable across the transition',
    required: 'pre-season',
    owner: 'WP2',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S10',
    title: 'Solar-farm onset (day-only repeats)',
    asserts: 'quarantined after >= 3 day-only repeat detections; no alert ever',
    required: 'pre-season',
    owner: 'WP2',
    blockedBy: 'D10 — the day-only repeat quarantine rule has no implementation',
    provenBy: null,
  },
  {
    id: 'S11',
    title: 'Source retired mid-replay',
    asserts: 'E still accumulates from the remaining sources; lifecycle progresses',
    required: 'pre-season',
    owner: 'WP2',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S12',
    title: 'Re-detection within T_LINK after officially_extinguished',
    asserts: 'returns to active, dual-fact copy, escalation — never new_fire',
    required: 'pre-season',
    owner: 'WP2',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S13',
    title: 'Zone created over an active event',
    asserts:
      'zero pushes for pre-existing events at zone creation; the seeded fires return in the ' +
      'next 09:00 digest, not before it; normal alerts afterwards',
    required: 'suite',
    owner: 'WP6',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S14',
    title: 'Alert decisions at 03:30 local, 25 Oct 2026 / 28 Mar 2027',
    asserts:
      'quiet-hours classification is taken from the instant through the tz database on both ' +
      'transitions — the repeated 03:30 is inside them on both passes and the skipped hour ' +
      'needs no special case — and the deferrals a window collects fold into one digest per ' +
      'account under that window start, across a 25-hour window and a 23-hour one',
    required: 'suite',
    owner: 'WP6',
    blockedBy: null,
    provenBy: null,
  },
  {
    id: 'S15',
    title: 'Cursor-only polling client + event removal',
    asserts: 'convergence after <= 1 full-snapshot cycle (fast-check)',
    required: 'suite',
    owner: 'WP3',
    blockedBy: null,
    provenBy: 'web/src/core/feed/cursor-client.property.test.ts',
  },
  {
    id: 'S16',
    title: 'Fire straddling the polling-bbox edge',
    asserts: 'the bbox buffer absorbs it: one event, correct geometry',
    required: 'pre-season',
    owner: 'WP2',
    blockedBy: null,
    provenBy: null,
  },
]);

/**
 * Which requirements a gate stage covers. Cumulative: the pre-season gate re-runs the
 * pre-merge set, because a fixture that stopped being checked at the stricter gate is a
 * fixture nobody is checking.
 */
export function requirementsForStage(stage: FixtureRequirement): readonly FixtureRequirement[] {
  const index = FIXTURE_REQUIREMENTS.indexOf(stage);
  if (index < 0) throw new RangeError(`unknown gate stage ${JSON.stringify(stage)}`);
  return FIXTURE_REQUIREMENTS.slice(0, index + 1);
}

/** Register entries the given stage is responsible for, in register order. */
export function entriesForStage(stage: FixtureRequirement): readonly RegisterEntry[] {
  const covered = new Set(requirementsForStage(stage));
  return FIXTURE_REGISTER.filter((entry) => covered.has(entry.required));
}

/**
 * The entries a stage demands a fixture for right now: covered, not blocked, and not proven
 * by a suite outside the replay harness.
 */
export function demandedAtStage(stage: FixtureRequirement): readonly RegisterEntry[] {
  return entriesForStage(stage).filter(
    (entry) => entry.blockedBy === null && entry.provenBy === null,
  );
}

/** A register entry proven outside the replay harness, with the suite narrowed to a string. */
export type ElsewhereEntry = RegisterEntry & {
  readonly blockedBy: null;
  readonly provenBy: string;
};

/**
 * The unblocked entries a stage covers whose proof is another suite — printed, and checked
 * for existence by the CLI, so "proven elsewhere" cannot quietly become "proven nowhere".
 */
export function elsewhereAtStage(stage: FixtureRequirement): readonly ElsewhereEntry[] {
  return entriesForStage(stage).filter(
    (entry): entry is ElsewhereEntry => entry.blockedBy === null && entry.provenBy !== null,
  );
}

/**
 * What is wrong with the fixture set, as sentences, empty when nothing is.
 *
 * Three failures, and the second is the one worth having. A demanded scenario with no
 * directory is the obvious gap. A directory whose id is in no register entry is the subtler
 * one: it means a scenario was authored outside the specification, and the register — the
 * thing CI-1 is written against — does not know it is being relied on. The third is a
 * directory for a scenario the register says another suite proves: two proofs of one row
 * drift apart silently, and the register could only vouch for one of them.
 */
export function registerProblems(
  stage: FixtureRequirement,
  presentIds: readonly string[],
): readonly string[] {
  const present = new Set(presentIds);
  const known = new Set(FIXTURE_REGISTER.map((entry) => entry.id));
  const elsewhere = new Map(
    FIXTURE_REGISTER.filter((entry) => entry.provenBy !== null).map((entry) => [
      entry.id,
      entry.provenBy,
    ]),
  );
  const problems: string[] = [];

  for (const entry of demandedAtStage(stage)) {
    if (!present.has(entry.id)) {
      problems.push(
        `${entry.id} (${entry.title}) is required ${entry.required} and has no fixture — ` +
          `it must assert: ${entry.asserts}`,
      );
    }
  }

  for (const id of [...present].sort()) {
    // `harness-smoke` and any other local fixture is deliberately allowed: it is named
    // outside the `S<n>` space precisely because it is not a register scenario.
    if (/^S\d+$/.test(id) && !known.has(id)) {
      problems.push(`fixture ${id} claims a register id that GATES §1.1 does not define`);
    }
    const suite = elsewhere.get(id);
    if (suite !== undefined) {
      problems.push(`fixture ${id} duplicates a scenario the register says ${suite} proves`);
    }
  }

  return problems;
}

/** A register entry that is waiting on a task, with the reason narrowed to a string. */
export type BlockedEntry = RegisterEntry & { readonly blockedBy: string };

/** The blocked entries a stage would otherwise demand — printed so the gaps stay visible. */
export function blockedAtStage(stage: FixtureRequirement): readonly BlockedEntry[] {
  return entriesForStage(stage).filter((entry): entry is BlockedEntry => entry.blockedBy !== null);
}
