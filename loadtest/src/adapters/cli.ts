/**
 * `loadtest` — the runner. Parses flags, builds the scenario, drives it, writes the
 * report, and exits with the verdict:
 *
 *   0 pass · 1 fail · 2 usage error · 3 invalid or incomplete run
 *
 * Built and run from the repo root:
 *
 *   tsc --build loadtest && node loadtest/dist/src/adapters/cli.js run --base-url … --dry-run
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { argv, exit, stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import { USAGE, UsageError, parseArgs, type MergeArgs, type RunArgs } from '../args.js';
import { BaselineError, PLANNING_BASELINE, parseBaseline } from '../baseline.js';
import type { Overall } from '../evaluate.js';
import { buildReport, mergeReports, renderMarkdown, ReportError, type Report } from '../report.js';
import { buildScenario, ScenarioError } from '../scenario.js';
import { runScenario } from './driver.js';

export const EXIT_CODES: Readonly<Record<Overall, number>> = {
  pass: 0,
  fail: 1,
  invalid: 3,
  incomplete: 3,
};
const EXIT_USAGE = 2;

export async function main(args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n\n${USAGE}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  try {
    return parsed.command === 'run' ? await run(parsed) : await merge(parsed);
  } catch (error) {
    if (
      error instanceof BaselineError ||
      error instanceof ScenarioError ||
      error instanceof ReportError
    ) {
      stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
}

async function run(args: RunArgs): Promise<number> {
  const baseline =
    args.baselineFile === null
      ? PLANNING_BASELINE
      : parseBaseline(JSON.parse(await readFile(args.baselineFile, 'utf8')) as unknown);
  const scenario = buildScenario({
    baseline,
    multiplier: args.multiplier,
    scale: args.scale,
    sseCap: args.sseCap,
    shard: args.shard,
    durationsMs: args.durationsMs,
  });

  if (args.dryRun) {
    stdout.write(`${JSON.stringify(scenario, null, 2)}\n`);
    return 0;
  }

  const startedAt = new Date().toISOString();
  const metrics = await runScenario({
    scenario,
    baseUrl: args.baseUrl,
    t2Url: args.t2Url,
    cacheStatusHeader: args.cacheStatusHeader,
    seed: args.seed,
    maxInFlight: args.maxInFlight,
    log: (line) => stderr.write(`[loadtest ${new Date().toISOString()}] ${line}\n`),
    onPhaseStart: async (phase) => {
      if (phase !== 'origin-kill') return;
      if (args.killOriginCmd === null) {
        stderr.write(
          '[loadtest] origin-kill phase: no --kill-origin-cmd, kill the origin by hand now\n',
        );
        return;
      }
      await shell(args.killOriginCmd);
    },
  });
  const report = buildReport(scenario, metrics, {
    startedAt,
    finishedAt: new Date().toISOString(),
    target: { baseUrl: args.baseUrl, t2Url: args.t2Url },
    seed: args.seed,
    generator: `${hostname()} shard ${args.shard.index}/${args.shard.count}`,
  });
  return emit(report, args.out);
}

async function merge(args: MergeArgs): Promise<number> {
  const reports = await Promise.all(
    args.inputs.map(async (file) => JSON.parse(await readFile(file, 'utf8')) as Report),
  );
  return emit(mergeReports(reports), args.out);
}

async function emit(report: Report, out: string | null): Promise<number> {
  const markdown = renderMarkdown(report);
  if (out !== null) {
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(out.replace(/\.json$/, '') + '.md', markdown);
  }
  stdout.write(markdown);
  return EXIT_CODES[report.evaluation.overall];
}

function shell(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`--kill-origin-cmd exited with ${String(code)}`)),
    );
  });
}

// Run only when executed, not when imported by a test.
const entry = argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(argv.slice(2)).then(
    (code) => exit(code),
    (error: unknown) => {
      stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      exit(EXIT_USAGE);
    },
  );
}
