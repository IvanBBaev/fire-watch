#!/usr/bin/env node
/**
 * Runs the L-12 deploy gate (TASKS J4) and exits non-zero when the deploy may not proceed.
 *
 *   node infra/deploy-gate/dist/cli.js \
 *     [--checklist <file> | --tick <ID>…] \
 *     [--replay-exit <code> --replay-log <file>] \
 *     [--hotfix --incident <ref> [--second-ack <name>]] \
 *     [--actor <name>] [--now <ISO-8601>] [--summary <file>]
 *   node infra/deploy-gate/dist/cli.js --template
 *
 * `--checklist` reads a Markdown task list (a PR body, a request file); `--tick` is the
 * same thing one id at a time, which is how `deploy.yml` passes its dispatch inputs.
 * `--summary` appends the Markdown report to a file — in CI, `$GITHUB_STEP_SUMMARY`, so
 * the run page is the deploy record.
 *
 * Exit codes: 0 allowed, 1 denied, 2 usage error.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { checklistFromTicks, parseChecklist, renderChecklistTemplate } from './checklist.js';
import { evaluateDeployGate, formatReport } from './gate.js';
import { SEASON_CALENDAR } from './season.js';

function usage(message: string): never {
  process.stderr.write(`deploy-gate: ${message}\n`);
  process.exit(2);
}

function main(): number {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        checklist: { type: 'string' },
        tick: { type: 'string', multiple: true },
        'replay-exit': { type: 'string' },
        'replay-log': { type: 'string' },
        hotfix: { type: 'boolean', default: false },
        incident: { type: 'string' },
        'second-ack': { type: 'string' },
        actor: { type: 'string' },
        now: { type: 'string' },
        summary: { type: 'string' },
        template: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  const values = parsed.values;

  if (values.template) {
    process.stdout.write(`${renderChecklistTemplate()}\n`);
    return 0;
  }

  const ticks = values.tick ?? [];
  if (values.checklist !== undefined && ticks.length > 0) {
    usage('--checklist and --tick are mutually exclusive');
  }
  const checklist =
    values.checklist !== undefined
      ? parseChecklist(readFileSync(values.checklist, 'utf8'))
      : checklistFromTicks(ticks);

  let replayExit: number | null = null;
  if (values['replay-exit'] !== undefined) {
    const raw = values['replay-exit'].trim();
    if (!/^\d+$/.test(raw)) usage(`--replay-exit must be an integer, got "${raw}"`);
    replayExit = Number(raw);
  }
  const replayLog =
    values['replay-log'] !== undefined ? readFileSync(values['replay-log'], 'utf8') : null;

  let now: Date;
  if (values.now !== undefined) {
    now = new Date(values.now);
    if (Number.isNaN(now.getTime())) usage(`--now is not an instant: "${values.now}"`);
  } else {
    // The CLI is the clock boundary: the gate itself takes `now` as input.
    // eslint-disable-next-line no-restricted-syntax
    now = new Date();
  }

  const result = evaluateDeployGate({
    now,
    calendar: SEASON_CALENDAR,
    checklist,
    replay: { exitCode: replayExit, log: replayLog },
    hotfix: values.hotfix
      ? { incident: values.incident ?? '', secondAckBy: values['second-ack'] ?? null }
      : null,
    actor: values.actor ?? null,
  });

  const report = formatReport(result);
  process.stdout.write(`${report}\n`);
  if (values.summary !== undefined) appendFileSync(values.summary, `${report}\n`);
  for (const finding of result.findings) {
    if (finding.status === 'fail') {
      process.stdout.write(`::error title=Deploy gate ${finding.id}::${finding.detail}\n`);
    } else if (finding.status === 'unarmed') {
      process.stdout.write(`::warning title=Deploy gate ${finding.id}::${finding.detail}\n`);
    }
  }
  return result.allowed ? 0 : 1;
}

process.exitCode = main();
