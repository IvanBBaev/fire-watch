#!/usr/bin/env node
/**
 * Runs the golden-replay register and prints one canonical report (gates CI-1, CI-2).
 *
 *   node server/dist/adapters/fixtures/replay-cli.js [--gate=<stage>] [fixture-directory…]
 *
 * With no directory arguments it runs every fixture under `server/fixtures`, in sorted
 * order. `--gate=pre-merge` (the CI-1 default), `--gate=pre-season` or `--gate=suite`
 * additionally holds the run to the GATES §1.1 register: the stage's unblocked scenarios
 * must all have a fixture, and a directory may not claim an `S<n>` id the register does not
 * define. Passing directories by hand does not relax that — the check is about the whole
 * fixture root, so a partial run cannot report a clean gate. A scenario the register says
 * another suite proves (S15, a fast-check property in `web/`) is noted rather than
 * demanded, and the gate fails if that suite's file is no longer where the register says —
 * the one check this process can make about a proof it does not run.
 *
 * The in-process double-run lives in the test suite; this exists so CI can run the whole
 * register in *two separate processes* and byte-diff the output. That catches a class the
 * in-process check cannot: anything that depends on the environment rather than on the
 * code — a locale-sensitive comparison, a local-time format, an ICU version. CI runs it
 * once under `TZ=UTC` and once under a far-away zone and a Turkish locale, which is where
 * naive `localeCompare` and `toLowerCase` give different answers.
 *
 * Which engine a fixture drives is the manifest's `engine` field, not this file's choice:
 * register scenarios run the real identity path, an alert scenario runs that same path with
 * the D9 gate behind it, and `harness-smoke` keeps running the placeholder forever, because
 * it is the fixture that fails when the *harness* breaks rather than when the clustering
 * does.
 *
 * Both streams go through the process log sink (C8), for two different reasons. Stderr —
 * failures, gate problems, blocked-scenario notes — becomes canonical-JSON records, so a
 * CI log is greppable by field rather than by prose. Stdout keeps its exact bytes and only
 * passes the redactor on the way out: the report *is* the CI-2 diff, so it may not be
 * reshaped, but a fixture is checked-in data a contributor edits and the sink is what
 * guarantees no entrypoint writes an unredacted string. Redaction cannot disturb the
 * report in practice — the value leg replaces configured secrets, and the shape leg only
 * looks inside URL-like substrings, which is exactly why it does not eat `detection_uid`s.
 */

import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { processLog, type ProcessLog } from '../../app/logging.js';
import { canonicalJson } from '../../core/determinism/canonical-json.js';
import {
  FIXTURE_REQUIREMENTS,
  type FixtureRequirement,
  type ReplayEngineId,
} from '../../core/replay/fixture-format.js';
import { alertEngine } from '../../core/replay/alert-engine.js';
import { identityEngine } from '../../core/replay/identity-engine.js';
import { blockedAtStage, elsewhereAtStage, registerProblems } from '../../core/replay/register.js';
import {
  diffAgainstExpected,
  runReplay,
  type ReplayEngineFactory,
  type ReplayReport,
} from '../../core/replay/runner.js';
import { createSmokeEngine } from '../../core/replay/smoke-engine.js';
import { listFixtureDirectories, loadFixture } from './fixture-loader.js';

const DEFAULT_ROOT = fileURLToPath(new URL('../../../fixtures', import.meta.url));
/** `provenBy` paths are repo-relative; the fixture root is `server/fixtures`. */
const REPO_ROOT = resolve(DEFAULT_ROOT, '..', '..');

const ENGINES: Readonly<Record<ReplayEngineId, ReplayEngineFactory>> = {
  identity: identityEngine(),
  alert: alertEngine(),
  smoke: createSmokeEngine,
};

interface Options {
  readonly gate: FixtureRequirement | null;
  readonly directories: readonly string[];
}

function parseArgs(argv: readonly string[]): Options {
  let gate: FixtureRequirement | null = null;
  const directories: string[] = [];

  const prefix = '--gate=';
  for (const argument of argv) {
    if (!argument.startsWith('--')) {
      directories.push(argument);
      continue;
    }
    const stage = argument.startsWith(prefix)
      ? FIXTURE_REQUIREMENTS.find((candidate) => candidate === argument.slice(prefix.length))
      : undefined;
    if (stage === undefined) {
      throw new Error(
        `unknown option ${argument}; expected --gate=${FIXTURE_REQUIREMENTS.join('|')}`,
      );
    }
    gate = stage;
  }

  return { gate, directories: directories.length > 0 ? [...directories].sort() : [] };
}

function main(argv: readonly string[], log: ProcessLog): number {
  const options = parseArgs(argv);
  const directories =
    options.directories.length > 0 ? options.directories : listFixtureDirectories(DEFAULT_ROOT);
  if (directories.length === 0) {
    log.note({ replay_no_fixtures: { root: DEFAULT_ROOT } });
    return 1;
  }

  const reports: { id: string; report: ReplayReport }[] = [];
  let failed = false;

  for (const directory of directories) {
    const fixture = loadFixture(directory);
    const report = runReplay(fixture, ENGINES[fixture.manifest.engine]);
    const differences = diffAgainstExpected(report, fixture.expected);

    if (differences.length > 0) {
      failed = true;
      log.note({
        replay_fixture_failed: {
          id: fixture.manifest.id,
          asserts: fixture.manifest.asserts,
          differences,
        },
      });
    }

    reports.push({ id: fixture.manifest.id, report });
  }

  if (options.gate !== null) {
    // Read from the root rather than from `directories`: the gate asks whether the register
    // is covered, and a hand-picked run must not be able to answer that question.
    const present = listFixtureDirectories(DEFAULT_ROOT).map((path) => basename(path));
    for (const problem of registerProblems(options.gate, present)) {
      failed = true;
      log.note({ replay_gate_problem: { stage: options.gate, problem } });
    }
    for (const entry of blockedAtStage(options.gate)) {
      // Not a failure — a standing note that the gate is narrower than GATES §1.1 says it
      // will eventually be, printed every run so the gap cannot go quiet.
      log.note({
        replay_gate_blocked: { stage: options.gate, id: entry.id, blockedBy: entry.blockedBy },
      });
    }
    for (const entry of elsewhereAtStage(options.gate)) {
      // Existence only: this process cannot run a web property suite, and CI runs it in the
      // unit job. What it can refuse is a register pointing at a file that was moved or
      // deleted, which would otherwise turn "proven elsewhere" into "proven nowhere".
      if (!existsSync(resolve(REPO_ROOT, entry.provenBy))) {
        failed = true;
        log.note({
          replay_gate_problem: {
            stage: options.gate,
            problem: `${entry.id} (${entry.title}) names ${entry.provenBy} as its proof, and no such file exists`,
          },
        });
        continue;
      }
      log.note({
        replay_gate_elsewhere: { stage: options.gate, id: entry.id, provenBy: entry.provenBy },
      });
    }
  }

  // Sorted by id so the document does not depend on directory order even when the
  // directories were passed in by hand.
  reports.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  log.line(canonicalJson({ fixtures: reports }));

  return failed ? 1 : 0;
}

const log = processLog();

try {
  process.exitCode = main(process.argv.slice(2), log);
} catch (error) {
  // A bad `--gate=` value or an unreadable fixture used to surface as an uncaught throw,
  // which prints a stack straight to stderr — the one write the sink cannot redact.
  log.fatal(error);
  process.exitCode = 1;
}
