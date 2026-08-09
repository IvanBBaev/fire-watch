#!/usr/bin/env node
/**
 * Runs the golden-replay register and prints one canonical report (gates CI-1, CI-2).
 *
 *   node server/dist/adapters/fixtures/replay-cli.js [fixture-directory…]
 *
 * With no arguments it runs every fixture under `server/fixtures`, in sorted order.
 *
 * The in-process double-run lives in the test suite; this exists so CI can run the whole
 * register in *two separate processes* and byte-diff the output. That catches a class the
 * in-process check cannot: anything that depends on the environment rather than on the
 * code — a locale-sensitive comparison, a local-time format, an ICU version. CI runs it
 * once under `TZ=UTC` and once under a far-away zone and a Turkish locale, which is where
 * naive `localeCompare` and `toLowerCase` give different answers.
 *
 * The engine is the smoke placeholder until WP2 lands; only this line changes then.
 */

import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../core/determinism/canonical-json.js';
import { diffAgainstExpected, runReplay, type ReplayReport } from '../../core/replay/runner.js';
import { createSmokeEngine } from '../../core/replay/smoke-engine.js';
import { listFixtureDirectories, loadFixture } from './fixture-loader.js';

const DEFAULT_ROOT = fileURLToPath(new URL('../../../fixtures', import.meta.url));

function main(argv: readonly string[]): number {
  const directories = argv.length > 0 ? [...argv].sort() : listFixtureDirectories(DEFAULT_ROOT);
  if (directories.length === 0) {
    process.stderr.write(`no fixtures found under ${DEFAULT_ROOT}\n`);
    return 1;
  }

  const reports: { id: string; report: ReplayReport }[] = [];
  let failed = false;

  for (const directory of directories) {
    const fixture = loadFixture(directory);
    const report = runReplay(fixture, createSmokeEngine);
    const differences = diffAgainstExpected(report, fixture.expected);

    if (differences.length > 0) {
      failed = true;
      process.stderr.write(`${fixture.manifest.id}: ${fixture.manifest.asserts}\n`);
      for (const difference of differences) process.stderr.write(`  ${difference}\n`);
    }

    reports.push({ id: fixture.manifest.id, report });
  }

  // Sorted by id so the document does not depend on directory order even when the
  // directories were passed in by hand.
  reports.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  process.stdout.write(`${canonicalJson({ fixtures: reports })}\n`);

  return failed ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
